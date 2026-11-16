/**
 * Timeline geometry in world units (x = time, y = 0 on the sacred timeline).
 *
 * - The strand runs left → right; its width at x is the context accumulated
 *   up to that moment, so pruning visibly thins the timeline.
 * - Each turn is a knot on the strand; each tool call is a branch whose
 *   length and width grow with the tokens it occupies.
 * Pure: no DOM, no WebGL — the renderer and the hit-testing both read it.
 */
import type { Branch, Turn } from '../../core/tree.ts'

export interface Pt { x: number; y: number }

export interface LaidBranch {
  branch: Branch
  turn: number
  side: 1 | -1
  /** Bezier control points (world). */
  p0: Pt; p1: Pt; p2: Pt; p3: Pt
  /** Core width in px. */
  width: number
  /** Leaf radius in px. */
  leaf: number
}

export interface LaidKnot { turn: Turn; x: number }

export interface StrandSample { x: number; width: number }

export interface Layout {
  width: number
  /** Largest |y| any branch reaches. */
  extent: number
  knots: LaidKnot[]
  branches: LaidBranch[]
  strand: StrandSample[]
  startX: number
  endX: number
}

const SLOT = 30
const TURN_GAP = 64
const PAD_L = 70
const PAD_R = 140

export function layoutTimeline(turns: readonly Turn[], contextWindow?: number): Layout {
  const maxTok = Math.max(1, ...turns.flatMap((t) => t.branches.map((b) => b.tokens)))
  const total = turns.reduce((s, t) => s + t.tokens, 0)
  const ref = Math.max(contextWindow ?? 0, total * 1.15, 1)

  const knots: LaidKnot[] = []
  const branches: LaidBranch[] = []
  // cumulative context at x, as step points
  const steps: Array<{ x: number; cum: number }> = []
  let x = PAD_L
  let cum = 0
  let parity = 0
  turns.forEach((turn, ti) => {
    if (ti > 0) x += TURN_GAP
    knots.push({ turn, x })
    cum += Math.max(0, turn.tokens - turn.branches.reduce((s, b) => s + b.tokens, 0))
    steps.push({ x, cum })
    turn.branches.forEach((b, k) => {
      const bx = x + 30 + k * SLOT
      const side: 1 | -1 = parity++ % 2 === 0 ? -1 : 1
      const f = Math.sqrt(b.tokens / maxTok)
      const pruned = b.status === 'pruned'
      // a limb leaves the timeline steeply, then sweeps forward — like a branch reaching for light
      const L = pruned ? 30 + 26 * f : 40 + 132 * f
      const reach = 26 + L * 0.62
      const p0 = { x: bx, y: 0 }
      let p1 = { x: bx + reach * 0.08, y: side * L * 0.42 }
      let p2 = { x: bx + reach * 0.42, y: side * L * 0.98 }
      let p3 = { x: bx + reach, y: side * L }
      if (pruned) {
        // severed and drooping toward the void below the timeline
        p1 = { x: bx + reach * 0.25, y: side * L * 0.25 }
        p2 = { x: bx + reach * 0.6, y: side * L * 0.2 + 30 }
        p3 = { x: bx + reach * 0.78, y: side * L * 0.1 + 58 }
      }
      branches.push({ branch: b, turn: ti, side, p0, p1, p2, p3, width: 1.1 + 4.6 * f, leaf: 3.2 + 4.2 * f })
      cum += b.tokens
      steps.push({ x: bx, cum })
    })
    x += 30 + Math.max(0, turn.branches.length - 1) * SLOT + 10
  })
  const startX = PAD_L - 40
  const endX = x + 30
  const strand: StrandSample[] = []
  let si = 0
  let current = 0
  for (let sx = startX; sx <= endX; sx += 6) {
    while (si < steps.length && steps[si]!.x <= sx) current = steps[si++]!.cum
    strand.push({ x: sx, width: 2.4 + 15 * Math.sqrt(current / ref) })
  }
  const extent = Math.max(60, ...branches.map((b) => Math.abs(b.p3.y)))
  return { width: endX + PAD_R, extent, knots, branches, strand, startX, endX }
}

export function bezier(b: LaidBranch, t: number): Pt {
  const u = 1 - t
  const a = u * u * u, c = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t
  return {
    x: a * b.p0.x + c * b.p1.x + d * b.p2.x + e * b.p3.x,
    y: a * b.p0.y + c * b.p1.y + d * b.p2.y + e * b.p3.y,
  }
}
