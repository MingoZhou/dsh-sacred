/**
 * End-to-end over a fake dsh Session that implements the surface/replace
 * semantics the real one has: append-only log, surface of seqs, `replace`
 * swaps one surface position for the new event.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandInvocation, CommandResult, ContextLike, MessageLike, SessionEventLike, SessionLike } from '../src/host-types.ts'

class FakeSession implements SessionLike {
  id = 'sess-1'
  log: SessionEventLike[] = []
  surface = { nodes: [] as number[] }
  eventAt(seq: number) { return this.log[seq - 1] }
  deriveEventMessage(e: SessionEventLike) { return e.data.message! }
  append(type: string, data: Record<string, unknown>, options?: { surfaceOp?: { op: 'replace'; startSeq: number; endSeq: number } }) {
    const seq = this.log.length + 1
    this.log.push({ seq, type, data })
    if (data['message'] !== undefined) {
      const op = options?.surfaceOp
      if (op) this.surface.nodes[this.surface.nodes.indexOf(op.startSeq)] = seq
      else this.surface.nodes.push(seq)
    }
    return { seq }
  }
  msg(message: MessageLike) { return this.append('message', { message }).seq }
  call(id: string, name: string, args: object) {
    return this.msg({ role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] })
  }
  result(id: string, text: string, isError = false) {
    return this.append('tool/result', { message: { role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text }] } }).seq
  }
  text(seq: number) { return (this.deriveEventMessage(this.eventAt(seq)!).content[0] as { text: string }).text }
}

type Http = (req: AsyncIterable<Buffer> & { method: string; url: string }, res: { writeHead(s: number): void; end(b: string): void }) => Promise<void>
type Flavor = 'public' | 'v021' | 'registry'
function setup(config: Record<string, unknown> = {}, flavor: Flavor = 'public') {
  let http: Http | undefined
  const agents = new Map<string, { session: SessionLike; status: 'idle' | 'running' }>()
  const handlers: Record<string, (i: CommandInvocation) => Promise<CommandResult>> = {}
  let preStep: ((p: { agent: { session: SessionLike }; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const resolver = {
    resolveAgent: async (id: string) => {
      const a = agents.get(id)
      return a ? { agent: a } : { error: { code: 'not-found', message: `session ${id} not found` } }
    },
  }
  const services: Record<string, unknown> = {
    tokenMeter: {
      estimateMessage: () => 10,
      measure: (session: SessionLike) => {
        const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: 7 }))
        return { totalTokens: nodes.length * 7 + 500, nodes }
      },
    },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 64000 }, defaultMaxTokens: 8000 }) },
    compaction: { compactRegion: async () => ({ summarySeq: 999, shadowedSeqs: [1, 2], shadowedTokenCount: 50 }) },
    // newer DSH exposes resolveAgent publicly; 0.2.1 keeps it on an inner `agents` controller
    ...(flavor === 'public' ? { sessionController: resolver } : {}),
    ...(flavor === 'v021' ? { sessionController: { agents: resolver } } : {}),
    agents: { get: (id: string) => agents.get(id) },
  }
  const ctx: ContextLike = {
    get: (name: string) => services[name],
    commands: { register: (d) => { handlers[d.name] = d.handler; return () => {} } },
    logger: { info: () => {}, warn: (m) => { throw new Error(m) } },
    on: (_e, l) => { preStep = l; return () => {} },
    effect: (fn) => { const r = fn(); if (typeof r !== 'function') for (const _ of r) { /* run registrations */ } },
    webServer: { register: (r) => { http = r.handler as unknown as Http; return () => {} } },
  }
  return { ctx, handlers, preStep: () => preStep!, http: () => http!, agents, config: { stateDir: mkdtempSync(join(tmpdir(), 'sacred-')), ...config } }
}

function conversation() {
  const s = new FakeSession()
  s.msg({ role: 'user', content: [{ type: 'text', text: '修一下 a.ts 的 bug' }] })
  s.call('r1', 'read', { file_path: 'a.ts' }); const stale = s.result('r1', 'old\n'.repeat(3000))
  s.call('e1', 'edit', { file_path: 'a.ts', old_string: 'old', new_string: 'new' }); s.result('e1', 'ok')
  for (let i = 0; i < 4; i++) { s.call(`g${i}`, 'glob', { pattern: `${i}` }); s.result(`g${i}`, `${i}`) }
  return { s, stale }
}

test('/sacred status → prune → restore round trip', async () => {
  const { ctx, handlers, config } = setup({ auto: false })
  const { apply } = await import('../src/index.ts')
  apply(ctx, config)
  const { s, stale } = conversation()
  const inv = (rawInput: string) => handlers['sacred']!({ agent: { session: s }, rawInput, signal: new AbortController().signal })

  assert.match((await inv('')).text, /可剪除 1 个异常分支/)
  const pos = s.surface.nodes.indexOf(stale)
  const length = s.surface.nodes.length
  assert.match((await inv('prune')).text, /已剪除 1/)
  const tomb = s.surface.nodes[pos]!
  assert.notEqual(tomb, stale)
  assert.match(s.text(tomb), /^⟪sacred⟫ Pruned stale branch/)
  assert.equal(s.text(stale), 'old\n'.repeat(3000), 'original kept in the log')
  assert.ok(s.log.some((e) => e.type === 'compaction/prune'), 'shadow price recorded')

  assert.match((await inv(`restore ${tomb}`)).text, /召回/)
  assert.equal(s.text(s.surface.nodes[pos]!), 'old\n'.repeat(3000))
  assert.equal(s.surface.nodes.length, length, 'no node added or removed')
})

test('pins survive and block both prune and cut', async () => {
  const { ctx, handlers, config } = setup({ auto: false })
  const { apply } = await import('../src/index.ts')
  apply(ctx, config)
  const { s, stale } = conversation()
  const inv = (rawInput: string) => handlers['sacred']!({ agent: { session: s }, rawInput, signal: new AbortController().signal })
  await inv(`pin ${stale}`)
  assert.match((await inv('prune')).text, /没有可剪除/)
  assert.match((await inv(`cut ${s.surface.nodes[0]} ${s.surface.nodes[3]}`)).text, /拒绝剪除/)
  await inv(`unpin ${stale}`)
  assert.match((await inv('prune')).text, /已剪除 1/)
})

test('auto mode prunes before the step only when savings clear the batch threshold', async () => {
  const { apply } = await import('../src/index.ts')
  const signal = new AbortController().signal
  const high = setup({ minSavingsChars: 100_000 }); apply(high.ctx, high.config)
  const a = conversation(); await high.preStep()({ agent: { session: a.s }, signal }, async () => 'next')
  assert.ok(a.s.surface.nodes.includes(a.stale), 'below threshold: untouched')

  const low = setup({ minSavingsChars: 1000 }); apply(low.ctx, low.config)
  const b = conversation(); const r = await low.preStep()({ agent: { session: b.s }, signal }, async () => 'next')
  assert.equal(r, 'next')
  assert.ok(!b.s.surface.nodes.includes(b.stale), 'above threshold: pruned')
})

async function call(http: Http, method: string, url: string, body?: object) {
  let status = 0, out = ''
  const payload = body ? [Buffer.from(JSON.stringify(body))] : []
  const req = { method, url, async *[Symbol.asyncIterator]() { yield* payload } }
  await http(req, { writeHead: (s) => { status = s }, end: (b) => { out = b } })
  return { status, body: JSON.parse(out) }
}

test('HTTP API drives the same engine: view, prune, pin, restore, busy guard', async () => {
  const { ctx, http, agents, config } = setup({ auto: false })
  const { apply } = await import('../src/index.ts')
  apply(ctx, config)
  const { s, stale } = conversation()
  const agent = { session: s, status: 'idle' as 'idle' | 'running' }
  agents.set('sess-1', agent)

  assert.equal((await call(http(), 'GET', '/sacred/api/session/nope')).status, 404)
  const v = await call(http(), 'GET', '/sacred/api/session/sess-1')
  assert.equal(v.status, 200)
  assert.equal(v.body.plan.items.length, 1)
  assert.ok(v.body.nodes.every((n: { text: string }) => n.text.length <= 600), 'previews are slimmed')

  agent.status = 'running'
  assert.equal((await call(http(), 'POST', '/sacred/api/session/sess-1/prune')).status, 409)
  agent.status = 'idle'

  const pr = await call(http(), 'POST', '/sacred/api/session/sess-1/prune', { seqs: [stale] })
  assert.equal(pr.body.pruned, 1)
  assert.equal(pr.body.view.void.length, 1)
  const tomb = pr.body.view.void[0].replacementSeq
  assert.equal(pr.body.view.void[0].toolName, 'read')

  const pin = await call(http(), 'POST', '/sacred/api/session/sess-1/pin', { seq: s.surface.nodes[0] })
  assert.deepEqual(pin.body.view.pins, [s.surface.nodes[0]])
  assert.equal((await call(http(), 'POST', '/sacred/api/session/sess-1/pin', { seq: 99999 })).status, 400)

  const re = await call(http(), 'POST', '/sacred/api/session/sess-1/restore', { seq: tomb })
  assert.equal(re.body.restored.originalSeq, stale)
  assert.equal(re.body.view.void.length, 0)
})

for (const flavor of ['v021', 'registry'] as const) {
  test(`session lookup works without a public resolveAgent (${flavor})`, async () => {
    const { ctx, http, agents, config } = setup({ auto: false }, flavor)
    const { apply } = await import('../src/index.ts')
    apply(ctx, config)
    const { s } = conversation()
    agents.set('sess-1', { session: s, status: 'idle' })
    const v = await call(http(), 'GET', '/sacred/api/session/sess-1')
    assert.equal(v.status, 200)
    assert.equal(v.body.plan.items.length, 1)
    const miss = await call(http(), 'GET', '/sacred/api/session/other')
    assert.equal(miss.status, 404)
    assert.equal(typeof miss.body.error, 'string', 'a readable reason, never a bare 404')
  })
}

test('health endpoint reports version and optional services', async () => {
  const { ctx, http, config } = setup({ auto: false }, 'registry')
  const { apply, VERSION } = await import('../src/index.ts')
  apply(ctx, config)
  const h = await call(http(), 'GET', '/sacred/api/health')
  assert.equal(h.status, 200)
  assert.equal(h.body.version, VERSION)
  assert.equal(h.body.services.sessionController, false)
  assert.equal(h.body.services.agents, true)
})

test('context stats use tokenMeter prices and the routed model window', async () => {
  const { ctx, http, agents, config } = setup({ auto: false })
  const { apply } = await import('../src/index.ts')
  apply(ctx, config)
  const { s } = conversation()
  ;(s as unknown as { requestHeader: () => unknown }).requestHeader = () => ({ config: { provider: 'deepseek', model: 'deepseek-v4' } })
  agents.set('sess-1', { session: s, status: 'idle' })
  const v = (await call(http(), 'GET', '/sacred/api/session/sess-1')).body
  const n = s.surface.nodes.length
  assert.equal(v.context.measured, true)
  assert.equal(v.context.totalTokens, n * 7 + 500)
  assert.equal(v.context.breakdown.overhead, 500)
  assert.equal(v.context.contextWindow, 64000)
  assert.equal(v.context.reservedOutputTokens, 8000)
  assert.equal(v.context.model, 'deepseek-v4')
  assert.ok(v.nodes.every((x: { tokens: number }) => x.tokens === 7))
})

test('manual prune cuts any tool output, but never pins, tombstones or non-tool nodes', async () => {
  const { ctx, http, handlers, agents, config } = setup({ auto: false })
  const { apply } = await import('../src/index.ts')
  apply(ctx, config)
  const { s } = conversation()
  agents.set('sess-1', { session: s, status: 'idle' })
  const toolSeqs = s.surface.nodes.filter((q) => s.eventAt(q)!.type === 'tool/result')
  const [a, b, c] = [toolSeqs.at(-1)!, toolSeqs.at(-2)!, s.surface.nodes[0]!]
  await call(http(), 'POST', '/sacred/api/session/sess-1/pin', { seq: b })
  const r = await call(http(), 'POST', '/sacred/api/session/sess-1/prune', { seqs: [a, b, c], manual: true })
  assert.equal(r.body.pruned, 1, 'only the unpinned tool output')
  const tomb = s.surface.nodes[s.surface.nodes.indexOf(a)]
  assert.equal(tomb, undefined, 'original seq replaced on the surface')
  assert.equal(r.body.view.void[0].reason, 'manual')
  assert.match(s.text(r.body.view.void[0].replacementSeq), /Pruned by the user/)
  const again = await call(http(), 'POST', '/sacred/api/session/sess-1/prune', { seqs: [r.body.view.void[0].replacementSeq], manual: true })
  assert.equal(again.body.pruned, 0, 'tombstones are not pruned twice')
  const cmd = await handlers['sacred']!({ agent: { session: s }, rawInput: `drop ${toolSeqs[0]}`, signal: new AbortController().signal })
  assert.match(cmd.text, /已手动裁剪 1 处/)
})
