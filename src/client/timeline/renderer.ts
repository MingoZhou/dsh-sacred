/**
 * Zero-dependency WebGL renderer for the sacred timeline.
 *
 * Two programs:
 *  - ribbons: anti-aliased, glowing strokes with per-vertex width — the
 *    timeline strand (energy flowing along it), branches (stale ones pulse,
 *    pruned ones dashed), turn guides;
 *  - points: knots, leaves, pinned rings, dust and the fragments that fall
 *    from pruned branches into the void.
 * Geometry is rebuilt in screen space when the camera or data changes; the
 * per-frame cost is two draw calls and a time uniform.
 */
import { bezier, type Layout, type LaidBranch, type Pt } from './layout.ts'

export interface Camera {
  /** World x at the left edge. */
  x: number
  /** Screen px per world unit on x. */
  zoom: number
  /** Screen y of the strand. */
  cy: number
  /** Screen px per world unit on y. */
  sy: number
}

export interface FrameInput {
  layout: Layout
  cam: Camera
  width: number
  height: number
  dark: boolean
  hover?: string
  selected?: string
  selectedTurn?: number
  /** Branch key → cut animation progress 0..1. */
  cutting: ReadonlyMap<string, number>
}

export interface HitBranch {
  key: string
  leaf: Pt
  radius: number
  samples: Pt[]
  halfWidth: number
}

export interface HitKnot { turn: number; at: Pt }

export interface Built {
  hits: HitBranch[]
  knots: HitKnot[]
  leafAt: Map<string, Pt>
}

type RGB = [number, number, number]
interface Palette {
  strandA: RGB; strandB: RGB; healthy: RGB; error: RGB; anomaly: RGB; pinned: RGB; pruned: RGB; ink: RGB
  glow: number; dust: number; hi: RGB; thread: number
}
/** White paper, dark-amber ink. */
const LIGHT: Palette = {
  strandA: [176, 111, 0], strandB: [214, 140, 20], healthy: [201, 138, 46], error: [168, 116, 62],
  anomaly: [226, 83, 27], pinned: [138, 90, 0], pruned: [201, 193, 170], ink: [43, 37, 22],
  glow: 0.3, dust: 0.16, hi: [255, 214, 120], thread: 0.45,
}
/** Black glass, amber phosphor. */
const DARK: Palette = {
  strandA: [255, 166, 40], strandB: [255, 196, 96], healthy: [168, 120, 62], error: [201, 105, 74],
  anomaly: [255, 122, 46], pinned: [255, 241, 194], pruned: [77, 71, 51], ink: [232, 220, 180],
  glow: 1.0, dust: 0.4, hi: [255, 246, 214], thread: 0.6,
}

const RIBBON_VS = `
attribute vec2 a_pos; attribute float a_across; attribute float a_along; attribute vec4 a_color; attribute vec4 a_params;
uniform vec2 u_res;
varying float v_across; varying float v_along; varying vec4 v_color; varying vec4 v_params;
void main() {
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_across = a_across; v_along = a_along; v_color = a_color; v_params = a_params;
}`
const RIBBON_FS = `
precision highp float;
uniform float u_time; uniform float u_glow; uniform vec3 u_hi;
varying float v_across; varying float v_along; varying vec4 v_color; varying vec4 v_params;
void main() {
  float d = abs(v_across);
  float core = v_params.x;
  float solid = 1.0 - smoothstep(core * 0.78, core, d);
  float g = 1.0 - smoothstep(core, 1.0, d);
  g = g * g;
  float flow = v_params.y * pow(0.5 + 0.5 * sin(v_along * 0.045 - u_time * 2.4), 10.0);
  // variants pulse and stutter like a failing signal
  float stutter = step(0.82, fract(sin(floor(u_time * 9.0) * 12.9898) * 43758.5453));
  float pulse = 1.0 + v_params.z * (0.6 * sin(u_time * 4.2) + 0.5 * stutter);
  float dash = v_params.w > 0.5 ? step(0.42, fract(v_along / 9.0)) : 1.0;
  float a = (solid + g * u_glow * pulse) * v_color.a * dash;
  vec3 col = mix(v_color.rgb, u_hi, clamp(flow, 0.0, 1.0) * solid * 0.9);
  a = clamp(a + flow * g * 0.35 * v_color.a, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`
const POINT_VS = `
attribute vec2 a_pos; attribute float a_size; attribute vec4 a_color; attribute float a_kind; attribute float a_seed; attribute float a_anim;
uniform vec2 u_res; uniform float u_time; uniform float u_dpr;
varying vec4 v_color; varying float v_kind;
void main() {
  vec2 p = a_pos; vec4 col = a_color;
  if (a_anim > 0.5 && a_anim < 1.5) {
    p.x = mod(p.x + u_time * (5.0 + a_seed * 9.0), u_res.x + 40.0) - 20.0;
    p.y += sin(u_time * 0.6 + a_seed * 40.0) * 7.0;
    col.a *= 0.35 + 0.65 * (0.5 + 0.5 * sin(u_time * 1.1 + a_seed * 23.0));
  } else if (a_anim > 1.5) {
    float f = fract(u_time * 0.16 + a_seed);
    p.y += f * 64.0;
    p.x += sin(u_time * 1.3 + a_seed * 31.0) * 4.0;
    col.a *= (1.0 - f) * min(f * 6.0, 1.0);
  }
  vec2 c = p / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = a_size * u_dpr;
  v_color = col; v_kind = a_kind;
}`
const POINT_FS = `
precision highp float;
uniform float u_glow; uniform float u_time;
varying vec4 v_color; varying float v_kind;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0) discard;
  vec3 col = v_color.rgb;
  float a;
  if (v_kind < 0.5) {
    float disk = 1.0 - smoothstep(0.36, 0.44, r);
    float glow = pow(1.0 - r, 2.2) * u_glow;
    float hi = 1.0 - smoothstep(0.0, 0.2, length(q - vec2(-0.13, -0.13)));
    col = mix(col, vec3(1.0), hi * 0.6 * disk);
    a = max(disk, glow);
  } else if (v_kind < 1.5) {
    float disk = 1.0 - smoothstep(0.28, 0.35, r);
    float ring = 1.0 - smoothstep(0.035, 0.075, abs(r - 0.72));
    ring *= step(0.0, sin(atan(q.y, q.x) * 7.0 + u_time * 1.4));
    float glow = pow(1.0 - r, 2.0) * u_glow * 0.8;
    a = max(max(disk, ring), glow);
  } else if (v_kind < 2.5) {
    a = 1.0 - smoothstep(0.05, 0.1, abs(r - 0.4));
  } else if (v_kind < 3.5) {
    float disk = 1.0 - smoothstep(0.42, 0.5, r);
    float inner = 1.0 - smoothstep(0.2, 0.28, r);
    col = mix(col, vec3(1.0), inner);
    float glow = pow(1.0 - r, 2.0) * u_glow;
    a = max(disk, glow);
  } else {
    a = pow(1.0 - r, 2.4);
  }
  a *= v_color.a;
  gl_FragColor = vec4(col * a, a);
}`

const R_STRIDE = 12
const P_STRIDE = 10

function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader')
    gl.attachShader(prog, sh)
  }
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
  return prog
}

function rand(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

export class TimelineRenderer {
  private readonly gl: WebGLRenderingContext
  private readonly ribbon: WebGLProgram
  private readonly point: WebGLProgram
  private readonly rBuf: WebGLBuffer
  private readonly pBuf: WebGLBuffer
  private rCount = 0
  private pCount = 0
  private glow = 0.5
  private hi: RGB = [255, 255, 255]
  private readonly dust: number[] = []

  constructor(private readonly canvas: HTMLCanvasElement) {
    const opts = { premultipliedAlpha: true, antialias: true, alpha: true }
    const gl = (canvas.getContext('webgl2', opts) ?? canvas.getContext('webgl', opts)) as WebGLRenderingContext | null
    if (!gl) throw new Error('WebGL unavailable')
    this.gl = gl
    this.ribbon = compile(gl, RIBBON_VS, RIBBON_FS)
    this.point = compile(gl, POINT_VS, POINT_FS)
    this.rBuf = gl.createBuffer()!
    this.pBuf = gl.createBuffer()!
    const r = rand(42)
    for (let i = 0; i < 90; i++) this.dust.push(r(), r(), r())
  }

  /** Rebuild screen-space geometry; returns hit-testing data. */
  build(f: FrameInput): Built {
    const P = f.dark ? DARK : LIGHT
    this.glow = P.glow
    this.hi = P.hi
    const { cam, layout } = f
    const sx = (x: number) => (x - cam.x) * cam.zoom
    const sy = (y: number) => cam.cy + y * cam.sy
    const R: number[] = []
    const Pt: number[] = []
    const hits: HitBranch[] = []
    const knots: HitKnot[] = []
    const leafAt = new Map<string, Pt>()

    const ribbon = (pts: Pt[], widths: number[], pad: number, color: RGB, alpha: number, flow: number, pulse: number, dash: number, colorAt?: (i: number) => RGB) => {
      if (pts.length < 2) return
      let along = 0
      const verts: number[][] = []
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!
        let nx = -(b.y - a.y), ny = b.x - a.x
        const len = Math.hypot(nx, ny) || 1
        nx /= len; ny /= len
        if (i > 0) along += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
        const core = widths[i]! / 2
        const half = core + pad
        const c = colorAt ? colorAt(i) : color
        const col = [c[0] / 255, c[1] / 255, c[2] / 255, alpha]
        const params = [core / half, flow, pulse, dash]
        verts.push([pts[i]!.x + nx * half, pts[i]!.y + ny * half, 1, along, ...col, ...params])
        verts.push([pts[i]!.x - nx * half, pts[i]!.y - ny * half, -1, along, ...col, ...params])
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const [a, b, c, d] = [verts[i * 2]!, verts[i * 2 + 1]!, verts[i * 2 + 2]!, verts[i * 2 + 3]!]
        R.push(...a, ...b, ...c, ...b, ...d, ...c)
      }
    }
    const point = (x: number, y: number, size: number, c: RGB, alpha: number, kind: number, seed = 0, anim = 0) => {
      Pt.push(x, y, size, c[0] / 255, c[1] / 255, c[2] / 255, alpha, kind, seed, anim)
    }

    // turn guides
    for (const k of layout.knots) {
      const x = sx(k.x)
      if (x < -10 || x > f.width + 10) continue
      const sel = f.selectedTurn === k.turn.index
      ribbon([{ x, y: 8 }, { x, y: f.height - 8 }], [1, 1], 0.5, P.ink, sel ? 0.16 : 0.06, 0, 0, 1)
    }

    // strand
    const sPts: Pt[] = [], sW: number[] = []
    for (const s of layout.strand) {
      const x = sx(s.x)
      if (x < -40 || x > f.width + 40) continue
      sPts.push({ x, y: cam.cy })
      sW.push(s.width)
    }
    const span = Math.max(1, layout.endX - layout.startX)
    const strandColor = (i: number) => mix(P.strandA, P.strandB, Math.min(1, Math.max(0, ((sPts[i]!.x / cam.zoom + cam.x) - layout.startX) / span)))
    ribbon(sPts, sW, 10, P.strandA, 0.95, 1, 0, 0, strandColor)
    // the timeline is a braid: fine threads twist around the core
    for (let k = 0; k < 4; k++) {
      const phase = (k * Math.PI) / 2
      const tPts = sPts.map((pt, i) => {
        const wx = pt.x / cam.zoom + cam.x
        return { x: pt.x, y: pt.y + Math.sin(wx * 0.045 + phase) * (sW[i]! * 0.62 + 3) }
      })
      ribbon(tPts, tPts.map(() => 0.9), 1.5, P.strandB, P.thread, 0.6, 0, 0, strandColor)
    }
    // ruler ticks along the timeline, every 30 world units
    const firstTick = Math.ceil((cam.x) / 30) * 30
    for (let wx = firstTick; wx < cam.x + f.width / cam.zoom; wx += 30) {
      const x = sx(wx)
      const w = layout.strand.find((st) => st.x >= wx)?.width ?? 4
      const major = Math.round(wx / 30) % 5 === 0
      const y0 = cam.cy + w / 2 + 9, y1 = y0 + (major ? 8 : 4)
      ribbon([{ x, y: y0 }, { x, y: y1 }], [1, 1], 0.4, P.ink, major ? 0.28 : 0.14, 0, 0, 0)
    }

    // branches
    const colorOf = (b: LaidBranch): RGB => {
      switch (b.branch.status) {
        case 'anomaly': return P.anomaly
        case 'pinned': return P.pinned
        case 'pruned': return P.pruned
        case 'error': return P.error
        default: return P.healthy
      }
    }
    for (const lb of layout.branches) {
      const key = lb.branch.key
      const cut = f.cutting.get(key)
      const lead = sx(lb.p0.x)
      if (lead < -260 || lead > f.width + 40) continue
      const p = cut ?? 0
      const fallY = p * p * 130
      const driftX = lb.side * p * 14
      const pts: Pt[] = []
      const ws: number[] = []
      const N = 22
      const pruned = lb.branch.status === 'pruned'
      const hot = f.hover === key || f.selected === key
      for (let i = 0; i <= N; i++) {
        const t = pruned ? 0.12 + (i / N) * 0.88 : i / N
        const w = bezier(lb, t)
        pts.push({ x: sx(w.x) + driftX * t, y: sy(w.y) + fallY * t })
        ws.push(lb.width * (1 - 0.45 * t) * (hot ? 1.45 : 1))
      }
      const c = p > 0 ? mix(colorOf(lb), [255, 255, 255], Math.max(0, 1 - p * 5)) : colorOf(lb)
      const nominal = lb.branch.status === 'healthy' || lb.branch.status === 'error'
      const alpha = (pruned ? 0.55 : hot ? 1 : nominal ? 0.72 : 0.95) * (1 - p)
      ribbon(pts, ws, hot ? 7 : 5, c, alpha,
        lb.branch.status === 'healthy' || lb.branch.status === 'pinned' ? 0.35 : 0,
        lb.branch.status === 'anomaly' ? 1 : 0, pruned ? 1 : 0)
      const leaf = pts[pts.length - 1]!
      leafAt.set(key, leaf)
      const size = lb.leaf * 2 * 2.4 * (hot ? 1.3 : 1)
      if (lb.branch.status === 'pinned') { point(leaf.x, leaf.y, size * 1.8, P.pinned, 1, 1); point(leaf.x, leaf.y, size, P.pinned, 1, 3) }
      else if (lb.branch.status === 'anomaly') point(leaf.x, leaf.y, size * 1.7, c, alpha, 1)
      else if (pruned) {
        point(leaf.x, leaf.y, size, P.pruned, 0.9, 2)
        for (let k = 0; k < 4; k++) point(leaf.x, leaf.y + 4, 3.2, P.pruned, 0.7, 4, (k * 0.27 + lb.p0.x * 0.013) % 1, 2)
      } else point(leaf.x, leaf.y, size, c, alpha, 0)
      if (f.selected === key) point(leaf.x, leaf.y, size * 1.9, P.ink, 0.9, 2)
      if (p > 0 && p < 0.6) {
        const r = rand(lb.p0.x | 0)
        const base = { x: sx(lb.p0.x), y: cam.cy }
        for (let k = 0; k < 16; k++) {
          const ang = r() * Math.PI * 2, dist = 6 + p * 70 * (0.4 + r())
          point(base.x + Math.cos(ang) * dist, base.y + Math.sin(ang) * dist, 4 + r() * 3, P.anomaly, (1 - p / 0.6) * 0.9, 4)
        }
      }
      if (p === 0) hits.push({ key, leaf, radius: size / 2.4, samples: pts.filter((_, i) => i % 3 === 0), halfWidth: ws[0]! / 2 + 4 })
    }

    // knots
    for (const k of layout.knots) {
      const x = sx(k.x)
      if (x < -20 || x > f.width + 20) continue
      const at = { x, y: cam.cy }
      knots.push({ turn: k.turn.index, at })
      const sel = f.selectedTurn === k.turn.index
      if (k.turn.userPinned) point(x, cam.cy, 40, P.pinned, 1, 1)
      point(x, cam.cy, sel ? 30 : 24, k.turn.userPinned ? P.pinned : P.strandA, 1, 3)
      if (sel) point(x, cam.cy, 44, P.ink, 0.8, 2)
    }

    // dust drifting along the timeline
    for (let i = 0; i < this.dust.length; i += 3) {
      point(this.dust[i]! * f.width, cam.cy + (this.dust[i + 1]! - 0.5) * 70, 2 + this.dust[i + 2]! * 3, P.strandB, P.dust, 4, this.dust[i + 2]!, 1)
    }

    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(R), gl.DYNAMIC_DRAW)
    this.rCount = R.length / R_STRIDE
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(Pt), gl.DYNAMIC_DRAW)
    this.pCount = Pt.length / P_STRIDE
    return { hits, knots, leafAt }
  }

  private attrib(prog: WebGLProgram, name: string, size: number, stride: number, offset: number): void {
    const gl = this.gl
    const loc = gl.getAttribLocation(prog, name)
    if (loc < 0) return
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4)
  }

  render(width: number, height: number, dpr: number, time: number): void {
    const gl = this.gl
    const w = Math.round(width * dpr), h = Math.round(height * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    for (let i = 0; i < 8; i++) gl.disableVertexAttribArray(i)
    gl.useProgram(this.ribbon)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rBuf)
    this.attrib(this.ribbon, 'a_pos', 2, R_STRIDE, 0)
    this.attrib(this.ribbon, 'a_across', 1, R_STRIDE, 2)
    this.attrib(this.ribbon, 'a_along', 1, R_STRIDE, 3)
    this.attrib(this.ribbon, 'a_color', 4, R_STRIDE, 4)
    this.attrib(this.ribbon, 'a_params', 4, R_STRIDE, 8)
    gl.uniform2f(gl.getUniformLocation(this.ribbon, 'u_res'), width, height)
    gl.uniform1f(gl.getUniformLocation(this.ribbon, 'u_time'), time)
    gl.uniform1f(gl.getUniformLocation(this.ribbon, 'u_glow'), this.glow)
    gl.uniform3f(gl.getUniformLocation(this.ribbon, 'u_hi'), this.hi[0] / 255, this.hi[1] / 255, this.hi[2] / 255)
    gl.drawArrays(gl.TRIANGLES, 0, this.rCount)

    for (let i = 0; i < 8; i++) gl.disableVertexAttribArray(i)
    gl.useProgram(this.point)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pBuf)
    this.attrib(this.point, 'a_pos', 2, P_STRIDE, 0)
    this.attrib(this.point, 'a_size', 1, P_STRIDE, 2)
    this.attrib(this.point, 'a_color', 4, P_STRIDE, 3)
    this.attrib(this.point, 'a_kind', 1, P_STRIDE, 7)
    this.attrib(this.point, 'a_seed', 1, P_STRIDE, 8)
    this.attrib(this.point, 'a_anim', 1, P_STRIDE, 9)
    gl.uniform2f(gl.getUniformLocation(this.point, 'u_res'), width, height)
    gl.uniform1f(gl.getUniformLocation(this.point, 'u_time'), time)
    gl.uniform1f(gl.getUniformLocation(this.point, 'u_dpr'), dpr)
    gl.uniform1f(gl.getUniformLocation(this.point, 'u_glow'), this.glow)
    gl.drawArrays(gl.POINTS, 0, this.pCount)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteBuffer(this.rBuf)
    gl.deleteBuffer(this.pBuf)
    gl.deleteProgram(this.ribbon)
    gl.deleteProgram(this.point)
  }
}
