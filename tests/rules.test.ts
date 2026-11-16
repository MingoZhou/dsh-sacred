import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPrune, TOMBSTONE_MARK } from '../src/core/rules.ts'
import { patchPaths } from '../src/core/paths.ts'
import type { SacredNode } from '../src/core/types.ts'

let seq = 0
const big = (label: string) => `${label}\n${'x'.repeat(1000)}`
function call(name: string, args: Record<string, unknown>): SacredNode {
  seq++
  return { seq, kind: 'assistant', text: '', chars: 0, toolCalls: [{ id: `c${seq}`, name, args }] }
}
function result(of: SacredNode, text: string, isError = false): SacredNode {
  seq++
  return { seq, kind: 'tool', text, chars: Array.from(text).length, toolCallId: of.toolCalls![0]!.id, isError }
}
/** Pad with harmless calls so the protected tail does not cover the cases under test. */
function tail(n = 4): SacredNode[] {
  const out: SacredNode[] = []
  for (let i = 0; i < n; i++) { const c = call('glob', { pattern: `t${i}` }); out.push(c, result(c, `t${i}`)) }
  return out
}

test('read made stale by a later edit of the same file', () => {
  const r = call('read', { file_path: './src/a.ts' })
  const e = call('edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })
  const nodes = [r, result(r, big('old a')), e, result(e, 'ok'), ...tail()]
  const plan = planPrune(nodes)
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0]!.reason, 'superseded-by-write')
  assert.equal(plan.items[0]!.path, 'src/a.ts')
  assert.ok(plan.items[0]!.replacementText.startsWith(TOMBSTONE_MARK))
  assert.ok(plan.charsAfter < plan.charsBefore)
})

test('a failed edit does not make the read stale', () => {
  const r = call('read', { file_path: 'a.ts' })
  const e = call('edit', { file_path: 'a.ts' })
  const nodes = [r, result(r, big('a')), e, result(e, 'no match', true), ...tail()]
  assert.equal(planPrune(nodes).items.filter((i) => i.reason === 'superseded-by-write').length, 0)
})

test('apply_patch paths count as writes', () => {
  assert.deepEqual(patchPaths('*** Begin Patch\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** End Patch'), ['src/b.ts'])
  const r = call('read', { file_path: 'src/b.ts' })
  const p = call('apply_patch', { patch: '*** Update File: src/b.ts\n-a\n+b' })
  const plan = planPrune([r, result(r, big('b')), p, result(p, 'done'), ...tail()])
  assert.equal(plan.items[0]?.reason, 'superseded-by-write')
})

test('re-read of the same range supersedes, a different range does not', () => {
  const r1 = call('read', { file_path: 'c.ts' })
  const r2 = call('read', { file_path: 'c.ts', offset: 50 })
  const r3 = call('read', { file_path: 'c.ts' })
  const nodes = [r1, result(r1, big('c1')), r2, result(r2, big('c2')), r3, result(r3, big('c3')), ...tail()]
  const plan = planPrune(nodes)
  assert.deepEqual(plan.items.map((i) => i.reason), ['superseded-by-read'])
  assert.equal(plan.items[0]!.seq, nodes[1]!.seq)
})

test('duplicate grep with identical output keeps the latest', () => {
  const g1 = call('grep', { pattern: 'foo', path: '.' })
  const g2 = call('grep', { path: '.', pattern: 'foo' })
  const nodes = [g1, result(g1, big('hits')), g2, result(g2, big('hits')), ...tail()]
  const plan = planPrune(nodes)
  assert.deepEqual(plan.items.map((i) => [i.reason, i.seq]), [['duplicate', nodes[1]!.seq]])
})

test('failed attempt keeps only the error head once the tool later succeeds', () => {
  const b1 = call('bash', { command: 'npm test' })
  const b2 = call('bash', { command: 'npm test -- --fix' })
  const nodes = [b1, result(b1, `Error: boom\n${'trace\n'.repeat(400)}`, true), b2, result(b2, 'pass'), ...tail()]
  const item = planPrune(nodes, { failedKeepChars: 20 }).items[0]!
  assert.equal(item.reason, 'failed-retried')
  assert.match(item.replacementText, /Error: boom/)
  assert.ok(item.charsAfter < item.charsBefore)
})

test('pins, protected tail, small outputs and existing tombstones are left alone', () => {
  const r = call('read', { file_path: 'd.ts' })
  const rr = result(r, big('d'))
  const w = call('write', { file_path: 'd.ts', content: 'x' })
  const base = [r, rr, w, result(w, 'ok')]
  assert.equal(planPrune([...base, ...tail()], { pinned: new Set([rr.seq]) }).items.length, 0)
  assert.equal(planPrune(base).items.length, 0, 'within protected tail')
  const s = call('read', { file_path: 'e.ts' }); const sw = call('write', { file_path: 'e.ts' })
  assert.equal(planPrune([s, result(s, 'tiny'), sw, result(sw, 'ok'), ...tail()]).items.length, 0)
  const t = call('read', { file_path: 'f.ts' }); const tw = call('write', { file_path: 'f.ts' })
  assert.equal(planPrune([t, result(t, `${TOMBSTONE_MARK} ${'x'.repeat(500)}`), tw, result(tw, 'ok'), ...tail()]).items.length, 0)
})

test('firstIndex reports where the cache prefix breaks', () => {
  const r = call('read', { file_path: 'g.ts' })
  const w = call('write', { file_path: 'g.ts' })
  const nodes = [{ seq: ++seq, kind: 'user' as const, text: 'hi', chars: 2 }, r, result(r, big('g')), w, result(w, 'ok'), ...tail()]
  assert.equal(planPrune(nodes).firstIndex, 2)
})
