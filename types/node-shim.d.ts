// Minimal declarations for the few Node APIs the worker uses, so `tsc -p .` needs no @types/node
// (this repo has no npm dependencies at all). Orca's own types cover everything else.
declare namespace NodeJS {
  type Platform = 'aix' | 'darwin' | 'freebsd' | 'linux' | 'openbsd' | 'sunos' | 'win32' | (string & {})
  type ProcessEnv = Record<string, string | undefined>
}
declare const process: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }
declare const Buffer: {
  byteLength(text: string, encoding?: string): number
  from(text: string, encoding?: string): { subarray(start: number): { toString(encoding?: string): string } }
}
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: string[],
    options: {
      timeout?: number
      killSignal?: string
      env?: NodeJS.ProcessEnv
      maxBuffer?: number
      windowsHide?: boolean
      shell?: boolean
    },
    callback: (error: (Error & { code?: unknown; killed?: boolean; signal?: string }) | null, stdout: string, stderr: string) => void
  ): unknown
}
declare module 'node:os' {
  export function homedir(): string
  export function hostname(): string
}
declare module 'node:path' {
  export function isAbsolute(path: string): boolean
  export function join(...parts: string[]): string
  export const sep: string
}
declare module 'node:crypto' {
  export function createHash(algorithm: string): { update(data: string): { digest(encoding: string): string } }
  export function randomUUID(): string
  export function randomBytes(size: number): { toString(encoding: string): string }
}
declare module 'node:fs/promises' {
  interface Stats {
    isDirectory(): boolean
    isSymbolicLink(): boolean
  }
  export function lstat(path: string): Promise<Stats>
  export function stat(path: string): Promise<Stats>
  export function realpath(path: string): Promise<string>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function rename(from: string, to: string): Promise<void>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
}
