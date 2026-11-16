/**
 * File-backed per-session state (pins + prune ledger) for the host.
 * The session log stays the source of truth for content — originals are never
 * deleted; the ledger only remembers which surface node replaced which.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionState, StateStore } from './engine.ts'

export function defaultStateDir(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'sacred')
}

export class FileStore implements StateStore {
  private readonly cache = new Map<string, SessionState>()
  private readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^\w.-]/g, '_')}.json`)
  }

  get(id: string): SessionState {
    let state = this.cache.get(id)
    if (state) return state
    try {
      state = JSON.parse(readFileSync(this.file(id), 'utf8')) as SessionState
    } catch {
      state = { pins: [], ledger: [] }
    }
    this.cache.set(id, state)
    return state
  }

  save(id: string): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file(id), JSON.stringify(this.get(id), null, 2))
  }
}
