// A fake CuriaBots skill for tests: HTTP /connector/pair and a hand-rolled WebSocket server that
// speaks the contract. No dependencies: only node:http, node:crypto and node:net.
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Socket } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface FakeConn {
  id: number
  socket: Socket
  link_id: string | null
  hello: any | null
  received: any[]
  closed: boolean
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, len])
      : len < 65536
        ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
        : (() => {
            const b = Buffer.alloc(10)
            b[0] = 0x80 | opcode
            b[1] = 127
            b.writeBigUInt64BE(BigInt(len), 2)
            return b
          })()
  return Buffer.concat([head, payload])
}

export class FakeSkill {
  server: Server
  port = 0
  conns: FakeConn[] = []
  pairBodies: any[] = []
  /** What POST /connector/pair answers next; a function can inspect the body. */
  pairReply: (body: any) => { status: number; json?: unknown } = () => ({ status: 400 })
  /** token -> link_id the skill accepts */
  tokens = new Map<string, string>()
  autoAck = true
  /** Extra fields for the next `welcome` (for example `link_name`). */
  welcomeExtra: Record<string, unknown> = {}
  welcomeLimits: Record<string, number> = { max_jobs: 5, max_prompt_bytes: 16384 }
  results = new Map<string, (r: any) => void>()
  private nextConn = 1

  constructor() {
    this.server = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/connector/pair')) {
        let data = ''
        req.on('data', (c) => (data += c))
        req.on('end', () => {
          let body: any = null
          try {
            body = JSON.parse(data)
          } catch {
            /* ignore */
          }
          this.pairBodies.push(body)
          const reply = this.pairReply(body)
          res.writeHead(reply.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(reply.json ?? {}))
        })
        return
      }
      res.writeHead(404).end()
    })
    this.server.on('upgrade', (req: IncomingMessage, socket: Socket) => this.upgrade(req, socket))
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as { port: number }).port
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/skills/orca`
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.socket.destroy()
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  /** Registers a pairing that succeeds once and returns the link it will accept. */
  allowPair(linkId: string, token: string, botLabel = 'T.A.R.S.'): void {
    this.pairReply = () => {
      this.tokens.set(token, linkId)
      return { status: 200, json: { link_id: linkId, token, bot_label: botLabel } }
    }
  }

  private upgrade(req: IncomingMessage, socket: Socket): void {
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    const conn: FakeConn = { id: this.nextConn++, socket, link_id: null, hello: null, received: [], closed: false }
    this.conns.push(conn)
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 2) return
        const opcode = buf[0]! & 0x0f
        const masked = (buf[1]! & 0x80) !== 0
        let len = buf[1]! & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        const maskLen = masked ? 4 : 0
        if (buf.length < off + maskLen + len) return
        const mask = masked ? buf.subarray(off, off + 4) : null
        const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len))
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
        buf = buf.subarray(off + maskLen + len)
        if (opcode === 8) {
          socket.write(frame(8, payload.subarray(0, 2)))
          socket.end()
        } else if (opcode === 9) socket.write(frame(10, payload))
        else if (opcode === 1) this.onText(conn, payload.toString('utf8'))
      }
    })
    socket.on('close', () => (conn.closed = true))
    socket.on('error', () => undefined)
  }

  private onText(conn: FakeConn, text: string): void {
    const msg = JSON.parse(text)
    conn.received.push(msg)
    if (msg.type === 'hello') {
      const linkId = this.tokens.get(msg.token)
      if (!linkId) return this.closeConn(conn, 4401)
      conn.link_id = linkId
      conn.hello = msg
      this.send(conn, { v: 1, type: 'welcome', link_id: linkId, bot_label: 'T.A.R.S.', ...this.welcomeExtra, limits: this.welcomeLimits })
    } else if (msg.type === 'event' && this.autoAck) {
      this.send(conn, { v: 1, type: 'ack', seq: msg.seq })
    } else if (msg.type === 'result') {
      this.results.get(msg.re)?.(msg)
      this.results.delete(msg.re)
    }
  }

  send(conn: FakeConn, msg: unknown): void {
    if (!conn.closed) conn.socket.write(frame(1, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg))))
  }

  closeConn(conn: FakeConn, code = 1000): void {
    const p = Buffer.alloc(2)
    p.writeUInt16BE(code)
    if (!conn.closed) {
      conn.socket.write(frame(8, p))
      setTimeout(() => conn.socket.destroy(), 50)
    }
  }

  /** The live connection of a link (the newest one). */
  connOf(linkId: string): FakeConn | undefined {
    return [...this.conns].reverse().find((c) => c.link_id === linkId && !c.closed)
  }

  /** Sends a command and resolves with the plugin's `result` message. */
  command(linkId: string, name: string, args: unknown, timeoutMs = 3000): Promise<any> {
    const conn = this.connOf(linkId)
    if (!conn) return Promise.reject(new Error('no connection for ' + linkId))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('command timeout ' + name)), timeoutMs)
      this.results.set(id, (r) => {
        clearTimeout(t)
        resolve(r)
      })
      this.send(conn, { v: 1, type: 'command', id, name, args })
    })
  }

  events(linkId: string): any[] {
    return this.conns.filter((c) => c.link_id === linkId).flatMap((c) => c.received.filter((m) => m.type === 'event'))
  }
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 3000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for ' + what)
    await new Promise((r) => setTimeout(r, 10))
  }
}
