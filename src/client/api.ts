/** Data access for the 上下文裁剪 tab — HTTP in the harness, in-memory in the demo. */
import type { SacredView } from '../engine.ts'

export type ClientView = SacredView & { busy?: boolean }

export interface SacredApi {
  view(sessionId: string): Promise<ClientView>
  prune(sessionId: string, seqs?: number[], manual?: boolean): Promise<{ pruned: number; saved: number; savedTokens?: number; view: ClientView }>
  pin(sessionId: string, seq: number): Promise<{ view: ClientView }>
  unpin(sessionId: string, seq: number): Promise<{ view: ClientView }>
  restore(sessionId: string, seq: number): Promise<{ view: ClientView }>
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    if (code !== undefined) this.code = code
  }
}

export class HttpSacredApi implements SacredApi {
  private readonly base: string
  constructor(base = '/sacred/api') {
    this.base = base
  }

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    // A 404 without our JSON body means the route itself is missing: the host half never started.
    if (!res.ok && data.error === undefined && res.status === 404) throw new ApiError(404, res.statusText, 'host-missing')
    if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.code)
    return data as T
  }

  view(id: string) { return this.req<ClientView>('GET', `/session/${encodeURIComponent(id)}`) }
  prune(id: string, seqs?: number[], manual?: boolean) {
    return this.req<{ pruned: number; saved: number; savedTokens?: number; view: ClientView }>('POST', `/session/${encodeURIComponent(id)}/prune`, seqs ? { seqs, ...(manual ? { manual: true } : {}) } : {})
  }
  pin(id: string, seq: number) { return this.req<{ view: ClientView }>('POST', `/session/${encodeURIComponent(id)}/pin`, { seq }) }
  unpin(id: string, seq: number) { return this.req<{ view: ClientView }>('POST', `/session/${encodeURIComponent(id)}/unpin`, { seq }) }
  restore(id: string, seq: number) { return this.req<{ view: ClientView }>('POST', `/session/${encodeURIComponent(id)}/restore`, { seq }) }
}
