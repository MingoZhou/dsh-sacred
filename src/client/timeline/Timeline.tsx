/**
 * The sacred timeline: WebGL strand + branches, HTML labels, pan / zoom,
 * hover and click picking, and the cut animation.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Branch, Turn } from '../../core/tree.ts'
import type { Key, T } from '../i18n.ts'
import { layoutTimeline, type Layout } from './layout.ts'
import { TimelineRenderer, type Built, type Camera } from './renderer.ts'

export type Selection = { type: 'branch'; key: string } | { type: 'turn'; index: number } | null

interface Props {
  turns: Turn[]
  contextWindow?: number
  selected: Selection
  /** Result seqs being cut (animation). */
  cutting: ReadonlySet<number>
  onSelect: (s: Selection) => void
  t: T
}

interface Label { key: string; x: number; y: number; side: 1 | -1; tool: string; text: string; tokens: string; status: Branch['status']; strong: boolean }
interface AxisLabel { index: number; x: number; title: string; text: string; pinned: boolean; selected: boolean }

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function clip(s: string, n: number): string {
  const pts = Array.from(s.replace(/\s+/g, ' ').trim())
  return pts.length > n ? `${pts.slice(0, n).join('')}…` : pts.join('')
}

const CUT_MS = 1100

export function Timeline({ turns, contextWindow, selected, cutting, onSelect, t }: Props): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<TimelineRenderer | null>(null)
  const camRef = useRef<Camera>({ x: 0, zoom: 1, cy: 200, sy: 1 })
  const sizeRef = useRef({ w: 800, h: 420 })
  const builtRef = useRef<Built | null>(null)
  const hoverRef = useRef<string | undefined>(undefined)
  const dirtyRef = useRef(true)
  const fittedRef = useRef(false)
  const cutStartRef = useRef<number | null>(null)
  const [labels, setLabels] = useState<Label[]>([])
  const [axis, setAxis] = useState<AxisLabel[]>([])
  const [tip, setTip] = useState<{ x: number; y: number; b: Branch } | null>(null)
  const [glError, setGlError] = useState<string | null>(null)

  const layout: Layout = useMemo(() => layoutTimeline(turns, contextWindow), [turns, contextWindow])
  const byKey = useMemo(() => new Map(layout.branches.map((b) => [b.branch.key, b])), [layout])
  const cuttingKeys = useMemo(() => {
    const out = new Set<string>()
    for (const b of layout.branches) if (b.branch.resultSeq !== undefined && cutting.has(b.branch.resultSeq)) out.add(b.branch.key)
    return out
  }, [layout, cutting])
  // the frame loop reads the latest props from here, so the WebGL context is created once
  const live = useRef({ layout, selected, cuttingKeys, byKey, turns, t, onSelect })
  live.current = { layout, selected, cuttingKeys, byKey, turns, t, onSelect }

  const fit = () => {
    const { layout } = live.current
    const { w, h } = sizeRef.current
    const zoom = Math.min(2.2, Math.max(0.3, (w - 60) / layout.width))
    const contentW = layout.width * zoom
    camRef.current = {
      x: contentW < w ? -(w - contentW) / 2 / zoom : Math.max(0, layout.width - w / zoom),
      zoom,
      cy: (h - 34) / 2 + 4,
      sy: Math.min(1.15, ((h - 34) / 2 - 30) / layout.extent),
    }
    dirtyRef.current = true
  }

  useEffect(() => { if (!fittedRef.current) { fit(); fittedRef.current = true } else dirtyRef.current = true }, [layout])
  useEffect(() => { dirtyRef.current = true }, [selected])
  useEffect(() => {
    cutStartRef.current = cuttingKeys.size > 0 ? performance.now() : null
    dirtyRef.current = true
  }, [cuttingKeys])

  // renderer lifecycle + frame loop
  useEffect(() => {
    const canvas = canvasRef.current!
    let renderer: TimelineRenderer
    try {
      renderer = new TimelineRenderer(canvas)
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e))
      return
    }
    rendererRef.current = renderer
    const ro = new ResizeObserver(() => {
      const r = wrapRef.current!.getBoundingClientRect()
      const prev = sizeRef.current
      sizeRef.current = { w: Math.max(200, r.width), h: Math.max(240, r.height) }
      if (Math.abs(prev.w - sizeRef.current.w) > 1 || Math.abs(prev.h - sizeRef.current.h) > 1) fit()
    })
    ro.observe(wrapRef.current!)
    let raf = 0
    const t0 = performance.now()
    let lastDark: boolean | null = null
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (document.visibilityState !== 'visible') return
      const dark = getComputedStyle(wrapRef.current!).getPropertyValue('--sac-is-dark').trim() === '1'
      if (dark !== lastDark) { lastDark = dark; dirtyRef.current = true }
      const { layout, selected, cuttingKeys } = live.current
      const cutting = new Map<string, number>()
      if (cutStartRef.current !== null) {
        const p = Math.min(1, (now - cutStartRef.current) / CUT_MS)
        for (const k of cuttingKeys) cutting.set(k, p)
        dirtyRef.current = true
      }
      const { w, h } = sizeRef.current
      if (dirtyRef.current) {
        dirtyRef.current = false
        builtRef.current = renderer.build({
          layout, cam: camRef.current, width: w, height: h, dark,
          ...(hoverRef.current ? { hover: hoverRef.current } : {}),
          ...(selected?.type === 'branch' ? { selected: selected.key } : {}),
          ...(selected?.type === 'turn' ? { selectedTurn: selected.index } : {}),
          cutting,
        })
        placeLabels(cutting)
      }
      renderer.render(w, h, Math.min(2, window.devicePixelRatio || 1), (now - t0) / 1000)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); rendererRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function placeLabels(cuttingNow: ReadonlyMap<string, number>): void {
    const { selected, byKey, turns, t } = live.current
    const built = builtRef.current
    if (!built) return
    const { w } = sizeRef.current
    const cam = camRef.current
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
    const free = (r: { x0: number; y0: number; x1: number; y1: number }) =>
      r.x0 > 0 && r.x1 < w && !placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0)
    // keep the strand itself clear
    placed.push({ x0: -1e9, y0: cam.cy - 12, x1: 1e9, y1: cam.cy + 12 })
    const rank = (b: Branch) => (selected?.type === 'branch' && selected.key === b.key ? 1e12
      : hoverRef.current === b.key ? 1e11
        : b.status === 'anomaly' ? 1e10 + b.tokens
          : b.status === 'pinned' ? 1e9 + b.tokens : b.tokens)
    const candidates = [...built.leafAt.entries()]
      .map(([key, at]) => ({ key, at, lb: byKey.get(key)! }))
      .filter((c) => c.lb && !cuttingNow.has(c.key))
      .sort((a, b) => rank(b.lb.branch) - rank(a.lb.branch))
    const out: Label[] = []
    for (const c of candidates) {
      const b = c.lb.branch
      const text = clip(b.label, 18)
      const width = 14 + (b.toolName.length + 1) * 6 + Array.from(text).reduce((s, ch) => s + (ch.charCodeAt(0) > 255 ? 12 : 6.6), 0) + 34
      const side = c.lb.side
      const x0 = c.at.x + 8, y0 = side < 0 ? c.at.y - 24 : c.at.y + 6
      const rect = { x0, y0, x1: x0 + width, y1: y0 + 18 }
      if (!free(rect)) continue
      placed.push(rect)
      out.push({ key: b.key, x: x0, y: y0, side, tool: b.toolName, text, tokens: fmtTokens(b.tokens), status: b.status,
        strong: (selected?.type === 'branch' && selected.key === b.key) || hoverRef.current === b.key })
      if (out.length > 60) break
    }
    setLabels(out)
    // axis labels for turns, thinned when crowded
    const ax: AxisLabel[] = []
    let lastX = -1e9
    for (const k of built.knots) {
      const turn = turns[k.turn]!
      if (k.at.x - lastX < 96 && !(selected?.type === 'turn' && selected.index === k.turn)) continue
      lastX = k.at.x
      ax.push({
        index: k.turn, x: k.at.x,
        title: turn.userSeq === undefined ? t('turn.system') : t('turn', { n: k.turn + 1 }),
        text: clip(turn.userText || '—', 9), pinned: turn.userPinned,
        selected: selected?.type === 'turn' && selected.index === k.turn,
      })
    }
    setAxis(ax)
  }

  // picking
  function pick(px: number, py: number): Selection {
    const built = builtRef.current
    if (!built) return null
    let best: { key: string; d: number } | null = null
    for (const h of built.hits) {
      const dl = Math.hypot(px - h.leaf.x, py - h.leaf.y) - h.radius - 6
      let d = dl
      for (const s of h.samples) d = Math.min(d, Math.hypot(px - s.x, py - s.y) - h.halfWidth)
      if (d < 4 && (!best || d < best.d)) best = { key: h.key, d }
    }
    if (best) return { type: 'branch', key: best.key }
    for (const k of built.knots) if (Math.hypot(px - k.at.x, py - k.at.y) < 14) return { type: 'turn', index: k.turn }
    return null
  }

  const drag = useRef<{ x: number; camX: number; moved: boolean } | null>(null)
  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, camX: camRef.current.x, moved: false }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d) {
      const dx = e.clientX - d.x
      if (Math.abs(dx) > 3) d.moved = true
      if (d.moved) {
        camRef.current = { ...camRef.current, x: d.camX - dx / camRef.current.zoom }
        dirtyRef.current = true
        setTip(null)
        return
      }
    }
    const { x, y } = local(e)
    const hit = pick(x, y)
    const key = hit?.type === 'branch' ? hit.key : undefined
    wrapRef.current!.style.cursor = hit ? 'pointer' : d ? 'grabbing' : 'grab'
    if (key !== hoverRef.current) {
      hoverRef.current = key
      dirtyRef.current = true
    }
    const b = key ? live.current.byKey.get(key)?.branch : undefined
    setTip(b ? { x, y, b } : null)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (d && !d.moved) {
      const { x, y } = local(e)
      live.current.onSelect(pick(x, y))
    }
  }
  const onWheel = (e: React.WheelEvent) => {
    const cam = camRef.current
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      camRef.current = { ...cam, x: cam.x + (e.deltaX || e.deltaY) / cam.zoom }
    } else {
      const { x } = local(e)
      const worldX = cam.x + x / cam.zoom
      const zoom = Math.min(4, Math.max(0.15, cam.zoom * Math.exp(-e.deltaY * 0.0015)))
      camRef.current = { ...cam, zoom, x: worldX - x / zoom }
    }
    dirtyRef.current = true
  }
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const stop = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [])
  const zoomBy = (f: number) => {
    const cam = camRef.current
    const cx = sizeRef.current.w / 2
    const worldX = cam.x + cx / cam.zoom
    const zoom = Math.min(4, Math.max(0.15, cam.zoom * f))
    camRef.current = { ...cam, zoom, x: worldX - cx / zoom }
    dirtyRef.current = true
  }

  return (
    <div className="sac-tl" ref={wrapRef}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerLeave={() => { hoverRef.current = undefined; dirtyRef.current = true; setTip(null) }}
      onWheel={onWheel}>
      <canvas ref={canvasRef} className="sac-tl-canvas" />
      {glError && <div className="sac-tl-error">WebGL: {glError}</div>}
      <div className="sac-tl-labels">
        {labels.map((l) => (
          <div key={l.key} className={`sac-tl-label is-${l.status}${l.strong ? ' is-strong' : ''}`} style={{ transform: `translate(${l.x}px, ${l.y}px)` }}>
            <code>{l.tool}</code>{l.text}<b>{l.tokens}</b>
          </div>
        ))}
        {axis.map((a) => (
          <div key={a.index} className={`sac-tl-axis${a.selected ? ' is-selected' : ''}`} style={{ transform: `translateX(${a.x}px)` }}
            onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => { e.stopPropagation(); onSelect({ type: 'turn', index: a.index }) }}>
            <span>{a.title}{a.pinned ? ' ◆' : ''}</span>{a.text}
          </div>
        ))}
        <div className="sac-tl-ends"><span>{t('root')}</span><span>{t('now')}</span></div>
      </div>
      {tip && (
        <div className="sac-tl-tip" style={{ transform: `translate(${Math.min(tip.x + 14, sizeRef.current.w - 230)}px, ${tip.y + 14}px)` }}>
          <div><code>{tip.b.toolName}</code> {clip(tip.b.path ?? tip.b.label, 34)}</div>
          <div className="sac-tl-tip-meta">{fmtTokens(tip.b.tokens)} tokens · {t(`status.${tip.b.status}` as Key)}</div>
        </div>
      )}
      <div className="sac-tl-zoom" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <button onClick={() => zoomBy(1 / 1.3)} aria-label="zoom out">−</button>
        <button onClick={() => zoomBy(1.3)} aria-label="zoom in">+</button>
        <button onClick={() => { fit() }}>{t('fit')}</button>
      </div>
    </div>
  )
}
