// One outgoing WSS connection per link: hello, welcome, ping/pong, backoff reconnects, command
// dispatch and the acknowledged event outbox.
import type { HostPort } from './host.ts'
import { logLine } from './host.ts'
import type { Store } from './store.ts'
import { toProjectRefs } from './store.ts'
import { backoffDelay, errorMessage } from './util.ts'
import type { ErrorCode, JobEvent, Limits, ProjectRef } from './wire.ts'
import { PROTOCOL_VERSION, parseServerMessage } from './wire.ts'

export type LinkStatus =
  | 'connecting'
  | 'online'
  | 'offline'
  | 'revoked'
  | 'unauthorized'
  | 'outdated'
  | 'no_token'

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: any) => void): void
}

export interface Timing {
  helloTimeoutMs: number
  connectTimeoutMs: number
  watchdogMs: number
  resendMs: number
  backoffBaseMs: number
  backoffCapMs: number
}

export const DEFAULT_TIMING: Timing = {
  helloTimeoutMs: 15_000,
  connectTimeoutMs: 20_000,
  watchdogMs: 75_000,
  resendMs: 60_000,
  backoffBaseMs: 1000,
  backoffCapMs: 300_000
}

export type CommandResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: ErrorCode; message: string } }

export interface HelloInfo {
  orca_version: string
  capabilities: string[]
}

export interface LinkConnectionOptions {
  linkId: string
  wsUrl: string
  token: string
  host: HostPort
  store: Store
  timing: Timing
  random: () => number
  newSocket: (url: string) => SocketLike
  pluginVersion: string
  platform: string
  helloInfo: () => Promise<HelloInfo>
  onCommand: (name: string, args: unknown, limits: Limits) => Promise<CommandResult>
  onChange: () => void
  onRevoked: (reason: string) => void
}

const OPEN = 1

export class LinkConnection {
  status: LinkStatus = 'connecting'
  limits: Limits = {}
  lastError: string | null = null
  private socket: SocketLike | null = null
  private attempt = 0
  private stopped = false
  private welcomed = false
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private helloTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private resendTimer: ReturnType<typeof setInterval> | null = null
  private sentAt = new Map<number, number>()

  private o: LinkConnectionOptions

  constructor(o: LinkConnectionOptions) {
    this.o = o
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  private setStatus(status: LinkStatus): void {
    if (this.status === status) return
    this.status = status
    this.o.onChange()
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    logLine(this.o.host, event, { link_id: this.o.linkId, ...fields })
  }

  private clearTimers(): void {
    for (const t of [this.watchdog, this.helloTimer, this.connectTimer, this.retryTimer]) if (t) clearTimeout(t)
    this.watchdog = this.helloTimer = this.connectTimer = this.retryTimer = null
    if (this.resendTimer) clearInterval(this.resendTimer)
    this.resendTimer = null
  }

  private connect(): void {
    if (this.stopped) return
    this.welcomed = false
    let socket: SocketLike
    try {
      socket = this.o.newSocket(this.o.wsUrl)
    } catch (error) {
      this.log('ws.create_failed', { error: errorMessage(error) })
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.connectTimer = setTimeout(() => {
      this.log('ws.connect_timeout')
      this.drop(socket)
    }, this.o.timing.connectTimeoutMs)
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      if (this.connectTimer) clearTimeout(this.connectTimer)
      void this.sendHello(socket)
    })
    socket.addEventListener('message', (event: { data: unknown }) => {
      if (this.socket !== socket) return
      void this.onMessage(socket, event.data)
    })
    socket.addEventListener('close', (event: { code?: number }) => {
      if (this.socket !== socket) return
      this.onClose(event?.code ?? 1006)
    })
    socket.addEventListener('error', () => {
      // A close event always follows; the reason is not exposed by the standard API.
      if (this.socket === socket) this.lastError = 'connection error'
    })
  }

  private async sendHello(socket: SocketLike): Promise<void> {
    try {
      const info = await this.o.helloInfo()
      if (this.socket !== socket) return
      const projects: ProjectRef[] = toProjectRefs(this.o.store.link(this.o.linkId)?.allowed_projects ?? [])
      this.rawSend({
        v: PROTOCOL_VERSION,
        type: 'hello',
        token: this.o.token,
        installation_id: this.o.store.installationId,
        plugin_version: this.o.pluginVersion,
        orca_version: info.orca_version,
        platform: this.o.platform,
        capabilities: info.capabilities,
        projects
      })
      this.helloTimer = setTimeout(() => {
        this.log('ws.welcome_timeout')
        this.drop(socket)
      }, this.o.timing.helloTimeoutMs)
    } catch (error) {
      this.log('hello.failed', { error: errorMessage(error) })
      this.drop(socket)
    }
  }

  private async onMessage(socket: SocketLike, data: unknown): Promise<void> {
    this.armWatchdog(socket)
    const msg = parseServerMessage(data)
    if (!msg) return
    if (!this.welcomed && msg.type !== 'welcome' && msg.type !== 'revoked' && msg.type !== 'ping') return
    switch (msg.type) {
      case 'welcome': {
        if (msg.link_id !== this.o.linkId) {
          this.log('welcome.mismatch')
          this.drop(socket)
          return
        }
        if (this.helloTimer) clearTimeout(this.helloTimer)
        this.welcomed = true
        this.attempt = 0
        this.limits = msg.limits
        this.lastError = null
        this.setStatus('online')
        this.armWatchdog(socket)
        this.log('online')
        this.resendTimer = setInterval(() => this.flush(true), this.o.timing.resendMs)
        this.flush(false)
        return
      }
      case 'ping':
        this.rawSend({ v: PROTOCOL_VERSION, type: 'pong' })
        return
      case 'ack':
        this.sentAt.delete(msg.seq)
        this.o.store.ack(this.o.linkId, msg.seq)
        return
      case 'revoked':
        this.log('revoked')
        this.stopped = true
        this.clearTimers()
        this.setStatus('revoked')
        this.close(1000)
        this.o.onRevoked(msg.reason)
        return
      case 'command': {
        const limits = this.limits
        let result: CommandResult
        try {
          result = await this.o.onCommand(msg.name, msg.args, limits)
        } catch (error) {
          this.log('command.crashed', { name: msg.name, error: errorMessage(error) })
          result = { ok: false, error: { code: 'internal', message: 'internal error' } }
        }
        if (result.ok) this.rawSend({ v: PROTOCOL_VERSION, type: 'result', re: msg.id, ok: true, data: result.data })
        else this.rawSend({ v: PROTOCOL_VERSION, type: 'result', re: msg.id, ok: false, error: result.error })
        return
      }
    }
  }

  private armWatchdog(socket: SocketLike): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    if (!this.welcomed) return
    this.watchdog = setTimeout(() => {
      this.log('ws.watchdog')
      this.drop(socket)
    }, this.o.timing.watchdogMs)
  }

  private onClose(code: number): void {
    this.clearTimers()
    this.socket = null
    this.welcomed = false
    if (this.stopped) return
    if (code === 4401) {
      this.lastError = 'unauthorized'
      this.log('closed', { close_code: code })
      this.setStatus('unauthorized')
      return
    }
    if (code === 4400) {
      this.lastError = 'unsupported_version'
      this.log('closed', { close_code: code })
      this.setStatus('outdated')
      return
    }
    this.log('closed', { close_code: code })
    this.setStatus('offline')
    this.scheduleReconnect()
  }

  /** Closes a socket we no longer trust and goes through the normal close path. */
  private drop(socket: SocketLike): void {
    if (this.socket !== socket) return
    try {
      socket.close(4000, 'reconnect')
    } catch {
      /* ignore */
    }
    // Some implementations delay the close event; do not wait for it.
    this.onClose(1006)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return
    const delay = backoffDelay(this.attempt++, this.o.random, this.o.timing.backoffBaseMs, this.o.timing.backoffCapMs)
    this.log('reconnect.scheduled', { delay_ms: delay, attempt: this.attempt })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private rawSend(message: Record<string, unknown>): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return false
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  /** Sends the events still waiting for an ack; `onlyStale` skips ones sent a moment ago. */
  flush(onlyStale: boolean): void {
    if (!this.welcomed) return
    const now = Date.now()
    for (const entry of [...this.o.store.outbox(this.o.linkId).events]) {
      const sent = this.sentAt.get(entry.seq)
      if (onlyStale && sent !== undefined && now - sent < this.o.timing.resendMs) continue
      if (this.rawSend({ v: PROTOCOL_VERSION, type: 'event', seq: entry.seq, event: entry.event })) {
        this.sentAt.set(entry.seq, now)
      }
    }
  }

  /** Queues an event (persisted first) and sends it if the link is up. */
  publish(event: JobEvent): void {
    this.o.store.enqueue(this.o.linkId, event)
    this.flush(false)
  }

  sendProjects(): void {
    if (!this.welcomed) return
    const projects = toProjectRefs(this.o.store.link(this.o.linkId)?.allowed_projects ?? [])
    this.rawSend({ v: PROTOCOL_VERSION, type: 'projects', projects })
  }

  get isOnline(): boolean {
    return this.welcomed && this.status === 'online'
  }

  /** Stops reconnecting and closes; `unlink` first tells the skill the user removed the link. */
  stop(unlink = false): void {
    this.stopped = true
    if (unlink) this.rawSend({ v: PROTOCOL_VERSION, type: 'unlink' })
    this.clearTimers()
    this.close(1000)
  }

  private close(code: number): void {
    const socket = this.socket
    this.socket = null
    this.welcomed = false
    if (!socket) return
    try {
      socket.close(code)
    } catch {
      /* ignore */
    }
  }
}
