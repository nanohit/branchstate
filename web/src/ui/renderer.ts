// Рендерер карты на сыром WebGL2. Базовая карта — несколько вызовов отрисовки из буферов,
// загруженных один раз. Слои снизу вверх: море и берег → регионы → границы → маршруты → вспышки.

import type { RegionView } from '../protocol.gen.ts';
import type { Camera } from './camera.ts';
import { FILL_STRIDE, RIBBON_STRIDE, ROUTE_STRIDE, type Geo } from './geo.ts';
import { FLASH_MS, FLASH_REPEATS, OWNER_LAND, OWNER_UNKNOWN, SEA } from './theme.ts';

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform mat3 u_cam;
uniform vec4 u_quant;      // x0, y0, шаг по x, шаг по y
uniform vec2 u_view;       // размер области в CSS-пикселях
uniform usampler2D u_regions;
uniform sampler2D u_palette;
vec2 world(vec2 q) { return u_quant.xy + (q + 32768.0) * u_quant.zw; }
vec4 clip(vec2 w, vec2 px) { vec3 c = u_cam * vec3(w, 1.0); return vec4(c.xy + px * 2.0 / u_view * vec2(1.0, -1.0), 0.0, 1.0); }
uvec4 region(int i) { return texelFetch(u_regions, ivec2(i, 0), 0); }
vec3 owner(uint o) { return texelFetch(u_palette, ivec2(int(o), 0), 0).rgb; }
`;

const FILL_VS = `${COMMON}
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_region;
flat out int v_region;
void main() { v_region = int(a_region); gl_Position = clip(world(a_pos), vec2(0.0)); }`;

const FILL_FS = `${COMMON}
flat in int v_region;
uniform int u_selected;
uniform int u_hover;
out vec4 o;
void main() {
  uvec4 r = region(v_region);
  vec3 c = owner(r.r);
  // G: бит 0 — спорный, 1 — война с игроком, 2 — свой, 3–4 — давность сведений.
  float age = float((r.g >> 3) & 3u);
  c = mix(c, vec3(dot(c, vec3(0.333))), age * 0.22) + age * 0.025;
  if ((r.g & 2u) != 0u) c = mix(c, vec3(0.78, 0.42, 0.36), 0.22);
  if ((r.g & 1u) != 0u) { float h = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 9.0)); c = mix(c, vec3(0.62, 0.25, 0.2), 0.16 * h); }
  if (v_region == u_selected) c = mix(c, vec3(1.0), 0.28);
  else if (v_region == u_hover) c = mix(c, vec3(1.0), 0.14);
  o = vec4(c, 1.0);
}`;

const RIBBON_VS = `${COMMON}
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_off;
layout(location=2) in vec2 a_sides;
uniform float u_offset_scale;
uniform float u_mode;      // 0 — границы, 1 — ореол берега, 2 — линия берега
out float v_side;
out float v_half;
out vec4 v_color;
void main() {
  int a = int(a_sides.x);
  int b = int(a_sides.y);
  v_side = b >= 128 ? 1.0 : -1.0;
  b = b & 127;
  float half_px;
  if (u_mode > 1.5) { half_px = 0.55; v_color = vec4(0.28, 0.38, 0.45, 0.9); }
  else if (u_mode > 0.5) { half_px = 3.5; v_color = vec4(0.62, 0.74, 0.8, 0.55); }
  else {
    uvec4 ra = region(a);
    uvec4 rb = region(b);
    bool same = ra.r == rb.r;
    float front = float(max(ra.b, rb.b));
    bool unknown = ra.r == ${OWNER_UNKNOWN}u || rb.r == ${OWNER_UNKNOWN}u;
    // Стиль границы по владельцам сторон: внутренняя, государственная, фронт, неизвестная.
    if (same) { half_px = 0.35; v_color = vec4(0.3, 0.26, 0.2, 0.28); }
    else if (front > 1.5) { half_px = 1.6; v_color = vec4(0.72, 0.16, 0.12, 0.95); }
    else if (front > 0.5) { half_px = 1.2; v_color = vec4(0.6, 0.3, 0.2, 0.9); }
    else { half_px = 0.7; v_color = vec4(0.3, 0.25, 0.2, unknown ? 0.4 : 0.8); }
  }
  // Полутолщина с запасом в полпикселя под сглаживание.
  v_half = half_px + 0.5;
  gl_Position = clip(world(a_pos), a_off / u_offset_scale * v_half);
}`;

const RIBBON_FS = `#version 300 es
precision highp float;
in float v_side;
in float v_half;
in vec4 v_color;
out vec4 o;
void main() {
  // Сглаживание по расстоянию до оси, переход 1 px.
  float a = clamp(v_half - abs(v_side) * v_half, 0.0, 1.0);
  o = vec4(v_color.rgb, v_color.a * a);
}`;

const ROUTE_VS = `${COMMON}
layout(location=0) in vec2 a_pos;
layout(location=1) in vec3 a_off;
layout(location=2) in float a_along;
uniform float u_offset_scale;
uniform float u_half;
out float v_side;
out float v_along;
out float v_half;
void main() {
  v_side = a_off.z;
  v_along = a_along;
  v_half = u_half + 0.5;
  gl_Position = clip(world(a_pos), a_off.xy / u_offset_scale * v_half);
}`;

const ROUTE_FS = `#version 300 es
precision highp float;
in float v_side;
in float v_along;
in float v_half;
uniform vec4 u_color;
uniform float u_dash;      // период штриха в км; 0 — сплошная
out vec4 o;
void main() {
  float a = clamp(v_half - abs(v_side) * v_half, 0.0, 1.0);
  if (u_dash > 0.0) a *= step(fract(v_along / u_dash), 0.55);
  o = vec4(u_color.rgb, u_color.a * a);
}`;

const FLASH_VS = `${COMMON}
layout(location=0) in vec3 a_flash;   // x, y (км), возраст 0..1
out float v_age;
uniform float u_dpr;
void main() { v_age = a_flash.z; gl_Position = clip(a_flash.xy, vec2(0.0)); gl_PointSize = 64.0 * u_dpr; }`;

const FLASH_FS = `#version 300 es
precision highp float;
in float v_age;
uniform float u_repeats;
out vec4 o;
void main() {
  float t = fract(v_age * u_repeats);
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float ring = smoothstep(0.12, 0.0, abs(d - t * 0.9));
  o = vec4(0.75, 0.18, 0.12, ring * (1.0 - t) * 0.9);
}`;

export type Route = { edge: string; color: [number, number, number, number]; half: number; dash: number };
export type Flash = { x: number; y: number; start: number };

export type Scene = {
  regions: Map<string, RegionView>;
  /** Индекс державы в пакете — индекс цвета в палитре. */
  ownerIndex: (id: string | null) => number;
  selected: string | null;
  hover: string | null;
  routes: Route[];
  flashes: Flash[];
};

type Program = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

export class Renderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext | null = null;
  /** Число потерь контекста за сессию — метрика. */
  losses = 0;
  renderScale = 1;
  private geo: Geo;
  private palettePx: Uint8Array;
  private prog: Record<'fill' | 'ribbon' | 'route' | 'flash', Program> = {} as never;
  private vao: Record<string, { vao: WebGLVertexArrayObject; count: number; type: number }> = {};
  private regionTex: WebGLTexture | null = null;
  private paletteTex: WebGLTexture | null = null;
  private flashBuf: WebGLBuffer | null = null;
  private flashVao: WebGLVertexArrayObject | null = null;
  private regionPx: Uint8Array;
  private uploaded: Uint8Array;
  private onRestore: () => void;
  private size = { w: 0, h: 0, dpr: 0 };

  constructor(canvas: HTMLCanvasElement, geo: Geo, palettePx: Uint8Array, onRestore: () => void) {
    this.canvas = canvas;
    this.geo = geo;
    this.palettePx = palettePx;
    this.onRestore = onRestore;
    const n = geo.meta.land_idx + 1;
    this.regionPx = new Uint8Array(n * 4);
    this.uploaded = new Uint8Array(n * 4).fill(1);
    // Потеря контекста (частая на мобильном Safari в фоне): все ресурсы пересоздаются из памяти.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.losses++;
      this.gl = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.init();
      this.onRestore();
    });
    this.init();
  }

  private init() {
    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('webgl2');
    this.gl = gl;
    const make = (vs: string, fs: string, uniforms: string[]): Program => {
      const p = gl.createProgram()!;
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
      return { p, u: Object.fromEntries(['u_cam', 'u_quant', 'u_view', 'u_regions', 'u_palette', ...uniforms].map((n) => [n, gl.getUniformLocation(p, n)])) };
    };
    this.prog = {
      fill: make(FILL_VS, FILL_FS, ['u_selected', 'u_hover']),
      ribbon: make(RIBBON_VS, RIBBON_FS, ['u_offset_scale', 'u_mode']),
      route: make(ROUTE_VS, ROUTE_FS, ['u_offset_scale', 'u_half', 'u_color', 'u_dash']),
      flash: make(FLASH_VS, FLASH_FS, ['u_repeats', 'u_dpr']),
    };

    const geo = this.geo;
    const mesh = (name: string, lod: string, attrs: (stride: number) => void, stride: number) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, geo.section(`${name}.v${lod}`), gl.STATIC_DRAW);
      attrs(stride);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      const idx = geo.section(`${name}.i${lod}`);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      const bytes = geo.meta.index_bytes[`${name}.i${lod}`];
      this.vao[name + lod] = { vao, count: idx.byteLength / bytes, type: bytes === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT };
    };
    const attr = (loc: number, size: number, type: number, stride: number, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, false, stride, offset);
    };
    for (let i = 0; i < geo.meta.lods.length; i++) {
      const lod = `.lod${i}`;
      mesh('fill', lod, (s) => (attr(0, 2, gl.SHORT, s, 0), attr(1, 1, gl.UNSIGNED_BYTE, s, 4)), FILL_STRIDE);
      for (const name of ['arcs', 'coast']) mesh(name, lod, (s) => (attr(0, 2, gl.SHORT, s, 0), attr(1, 2, gl.BYTE, s, 4), attr(2, 2, gl.UNSIGNED_BYTE, s, 6)), RIBBON_STRIDE);
    }
    mesh('edges', '', (s) => (attr(0, 2, gl.SHORT, s, 0), attr(1, 3, gl.BYTE, s, 4), attr(2, 1, gl.FLOAT, s, 8)), ROUTE_STRIDE);

    this.flashVao = gl.createVertexArray();
    gl.bindVertexArray(this.flashVao);
    this.flashBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flashBuf);
    attr(0, 3, gl.FLOAT, 12, 0);
    gl.bindVertexArray(null);

    const tex = (unit: number) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    // `region_data`: RGBA8UI, один тексель на регион; пишет показанная ревизия представления.
    this.regionTex = tex(0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, this.regionPx.length / 4, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, this.regionPx);
    this.uploaded.fill(1);
    // `palette`: один тексель на индекс владельца; смена темы трогает только её.
    this.paletteTex = tex(1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.palettePx);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.size.dpr = 0;
  }

  /** Перекраска: `texSubImage2D` только изменённых текселей `region_data`. */
  private uploadRegions(scene: Scene) {
    const gl = this.gl!;
    const px = this.regionPx;
    const land = this.geo.meta.land_idx;
    for (const r of this.geo.meta.regions) {
      const v = scene.regions.get(r.id);
      const o = r.idx * 4;
      px[o] = v ? scene.ownerIndex(v.owner) : OWNER_UNKNOWN;
      px[o + 1] = v ? (v.disputed ? 1 : 0) | (v.war ? 2 : 0) | (v.own ? 4 : 0) | (v.age << 3) : 0;
      px[o + 2] = v ? v.front : 0;
    }
    px[land * 4] = OWNER_LAND;
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i <= land; i++) {
      const o = i * 4;
      if (px[o] === this.uploaded[o] && px[o + 1] === this.uploaded[o + 1] && px[o + 2] === this.uploaded[o + 2] && this.uploaded[o + 3] === 0) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, i, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, px.subarray(o, o + 4));
      this.uploaded.set(px.subarray(o, o + 3), o);
      this.uploaded[o + 3] = 0;
    }
  }

  /** Буфер канваса = CSS-размер × min(dpr, 2) × render_scale. Перевыделяется только при изменении. */
  resize(w: number, h: number) {
    const dpr = Math.min(devicePixelRatio || 1, 2) * this.renderScale;
    if (this.size.w === w && this.size.h === h && this.size.dpr === dpr) return;
    this.size = { w, h, dpr };
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
  }

  render(cam: Camera, scene: Scene, now: number) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    const geo = this.geo;
    this.uploadRegions(scene);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(SEA[0], SEA[1], SEA[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const [x0, y0, x1, y1] = geo.meta.bounds;
    const m = cam.matrix();
    const use = (pr: Program) => {
      gl.useProgram(pr.p);
      gl.uniformMatrix3fv(pr.u.u_cam, false, m);
      gl.uniform4f(pr.u.u_quant, x0, y0, (x1 - x0) / 65535, (y1 - y0) / 65535);
      gl.uniform2f(pr.u.u_view, cam.w, cam.h);
      gl.uniform1i(pr.u.u_regions, 0);
      gl.uniform1i(pr.u.u_palette, 1);
      return pr.u;
    };
    const draw = (key: string, first = 0, count = this.vao[key].count) => {
      const v = this.vao[key];
      gl.bindVertexArray(v.vao);
      gl.drawElements(gl.TRIANGLES, count, v.type, first * (v.type === gl.UNSIGNED_SHORT ? 2 : 4));
    };
    // Уровень детализации — первый, допустимый на текущем масштабе.
    const lod = `.lod${Math.max(0, geo.meta.lods.findIndex((l) => cam.scale <= l.max_scale * 1.05))}`;
    const idx = (id: string | null) => (id ? (geo.regions.get(id)?.idx ?? -1) : -1);

    let u = use(this.prog.ribbon);
    gl.uniform1f(u.u_offset_scale, geo.meta.offset_scale);
    gl.uniform1f(u.u_mode, 1);
    draw(`coast${lod}`);

    u = use(this.prog.fill);
    gl.uniform1i(u.u_selected, idx(scene.selected));
    gl.uniform1i(u.u_hover, idx(scene.hover));
    draw(`fill${lod}`);

    u = use(this.prog.ribbon);
    gl.uniform1f(u.u_offset_scale, geo.meta.offset_scale);
    gl.uniform1f(u.u_mode, 2);
    draw(`coast${lod}`);
    gl.uniform1f(u.u_mode, 0);
    draw(`arcs${lod}`);

    u = use(this.prog.route);
    gl.uniform1f(u.u_offset_scale, geo.meta.offset_scale);
    gl.uniform1f(u.u_half, 0.5);
    gl.uniform4f(u.u_color, 0.25, 0.22, 0.2, 0.22);
    gl.uniform1f(u.u_dash, 9 / cam.scale);
    draw('edges');
    for (const r of scene.routes) {
      const e = geo.edges.get(r.edge);
      if (!e) continue;
      gl.uniform1f(u.u_half, r.half);
      gl.uniform4f(u.u_color, ...r.color);
      gl.uniform1f(u.u_dash, r.dash / cam.scale);
      draw('edges', e.range[0], e.range[1]);
    }

    if (scene.flashes.length) {
      // Вспышки конечны: иначе отрисовка по требованию теряет смысл.
      const data = new Float32Array(scene.flashes.flatMap((f) => [f.x, f.y, Math.min(1, (now - f.start) / FLASH_MS)]));
      u = use(this.prog.flash);
      gl.uniform1f(u.u_repeats, FLASH_REPEATS);
      gl.uniform1f(u.u_dpr, this.canvas.width / cam.w);
      gl.bindVertexArray(this.flashVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flashBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, scene.flashes.length);
    }
    gl.bindVertexArray(null);
  }
}
