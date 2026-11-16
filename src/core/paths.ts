/**
 * Which files a tool call reads or writes, for the built-in dsh tools
 * (`read`, `write`, `edit`, `str_replace_editor`, `apply_patch`).
 * Unknown tools (bash, MCP, …) touch no known path — rules stay conservative.
 */
import type { SacredToolCall } from './types.ts'

export const READ_TOOLS = new Set(['read'])
export const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
export const PATCH_TOOLS = new Set(['apply_patch'])

export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s.replace(/\/+/g, '/')
}

function pathArg(args: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim() !== '') return normalizePath(v)
  }
  return undefined
}

/** Paths named in an apply_patch body (`*** Update File:` style and unified-diff headers). */
export function patchPaths(patch: string): string[] {
  const out = new Set<string>()
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line)
      ?? /^\*\*\* Move to: (.+)$/.exec(line)
      ?? /^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line)
    if (m && m[1] && m[1] !== '/dev/null') out.add(normalizePath(m[1]))
  }
  return [...out]
}

export function readPath(call: SacredToolCall): string | undefined {
  return READ_TOOLS.has(call.name) ? pathArg(call.args) : undefined
}

export function writtenPaths(call: SacredToolCall): string[] {
  if (WRITE_TOOLS.has(call.name)) {
    const p = pathArg(call.args)
    return p === undefined ? [] : [p]
  }
  if (PATCH_TOOLS.has(call.name)) {
    for (const key of ['patch', 'input', 'diff']) {
      const v = call.args[key]
      if (typeof v === 'string') return patchPaths(v)
    }
  }
  return []
}

/** Stable key for "same read range": offset/limit with defaults removed. */
export function readRangeKey(call: SacredToolCall): string {
  const offset = call.args['offset'] ?? 1
  const limit = call.args['limit'] ?? null
  return JSON.stringify([offset, limit])
}

/** Canonical JSON (sorted keys) so argument order does not defeat duplicate detection. */
export function canonicalArgs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArgs).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalArgs(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
