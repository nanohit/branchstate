// Геометрия сценария: один ArrayBuffer, поверх него — представления TypedArray без копий.
// CPU использует контуры и прямоугольники для попадания касания, ломаные рёбер — для движения маркеров.

export type GeoNode = { id: string; name: string; x: number; y: number; sea: boolean; port: boolean; region: string | null; priority: number };
export type GeoEdge = { id: string; a: string; b: string; mode: string; days: number; range: [number, number]; line: [number, number]; length: number };
export type GeoRegion = { id: string; idx: number; name: string; rings: [number, number][]; label: [number, number]; area: number };
export type GeoMeta = {
  scenario: string;
  bounds: [number, number, number, number];
  offset_scale: number;
  lods: { max_scale: number; vertices: number; triangles: number }[];
  land_idx: number;
  regions: GeoRegion[];
  nodes: GeoNode[];
  edges: GeoEdge[];
  sections: Record<string, [number, number]>;
  index_bytes: Record<string, number>;
  bin_hash: string;
};

export const FILL_STRIDE = 6;
export const RIBBON_STRIDE = 8;
export const ROUTE_STRIDE = 12;

export class Geo {
  meta: GeoMeta;
  buf: ArrayBuffer;
  nodes = new Map<string, GeoNode>();
  edges = new Map<string, GeoEdge>();
  regions = new Map<string, GeoRegion>();
  private between = new Map<string, { id: string; reversed: boolean; days: number }>();
  private lines: Float32Array;
  private bbox: Float32Array;
  private fill: Int16Array;

  constructor(meta: GeoMeta, buf: ArrayBuffer) {
    this.meta = meta;
    this.buf = buf;
    // Координаты и индексы хранятся разностями; сумма восстанавливает их на месте, без копий.
    for (const [name, [offset, length]] of Object.entries(meta.sections)) {
      if (name.includes('.v')) {
        const stride = name.startsWith('fill') ? FILL_STRIDE : name.startsWith('edges') ? ROUTE_STRIDE : RIBBON_STRIDE;
        const dv = new DataView(buf, offset, length);
        for (let o = stride; o < length; o += stride) {
          dv.setInt16(o, dv.getInt16(o, true) + dv.getInt16(o - stride, true), true);
          dv.setInt16(o + 2, dv.getInt16(o + 2, true) + dv.getInt16(o + 2 - stride, true), true);
        }
      } else if (name.includes('.i')) {
        const a = meta.index_bytes[name] === 2 ? new Uint16Array(buf, offset, length / 2) : new Uint32Array(buf, offset, length / 4);
        for (let i = 1; i < a.length; i++) a[i] += a[i - 1];
      }
    }
    for (const n of meta.nodes) this.nodes.set(n.id, n);
    for (const r of meta.regions) this.regions.set(r.id, r);
    for (const e of meta.edges) {
      this.edges.set(e.id, e);
      this.between.set(`${e.a}>${e.b}`, { id: e.id, reversed: false, days: e.days });
      this.between.set(`${e.b}>${e.a}`, { id: e.id, reversed: true, days: e.days });
    }
    const view = (name: string) => meta.sections[name];
    this.lines = new Float32Array(buf, view('edge_lines')[0], view('edge_lines')[1] / 4);
    this.bbox = new Float32Array(buf, view('bbox')[0], view('bbox')[1] / 4);
    const lod = meta.lods.length - 1;
    // Вершины заливки идут кольцами: они же — контуры регионов. Шаг 6 байт = 3 значения i16.
    this.fill = new Int16Array(buf, view(`fill.v.lod${lod}`)[0], view(`fill.v.lod${lod}`)[1] / 2);
  }

  get maxScale() {
    return this.meta.lods.at(-1)!.max_scale;
  }

  section(name: string) {
    const [offset, length] = this.meta.sections[name];
    return new Uint8Array(this.buf, offset, length);
  }

  edge(from: string, to: string) {
    return this.between.get(`${from}>${to}`) ?? null;
  }

  /** Точка на ломаной ребра на доле `f` его длины; `reversed` — доля считается от конца. */
  edgePoint(id: string, f: number, reversed: boolean): [number, number] {
    const e = this.edges.get(id)!;
    const [first, count] = e.line;
    const l = this.lines;
    const target = (reversed ? 1 - f : f) * e.length;
    let i = first;
    while (i < first + count - 2 && l[(i + 1) * 3 + 2] < target) i++;
    const [a, b] = [i * 3, (i + 1) * 3];
    const span = l[b + 2] - l[a + 2];
    const k = span > 0 ? Math.min(1, Math.max(0, (target - l[a + 2]) / span)) : 0;
    return [l[a] + (l[b] - l[a]) * k, l[a + 1] + (l[b + 1] - l[a + 1]) * k];
  }

  /** Попадание точки в регион на CPU: отбор по прямоугольникам, затем чётность пересечений по контурам. */
  regionAt(x: number, y: number): string | null {
    const [x0, y0, x1, y1] = this.meta.bounds;
    const qx = ((x - x0) / (x1 - x0)) * 65535 - 32768;
    const qy = ((y - y0) / (y1 - y0)) * 65535 - 32768;
    const v = this.fill;
    for (const r of this.meta.regions) {
      const b = r.idx * 4;
      if (x < this.bbox[b] || y < this.bbox[b + 1] || x > this.bbox[b + 2] || y > this.bbox[b + 3]) continue;
      let inside = false;
      for (const [first, count] of r.rings) {
        for (let i = 0, j = count - 1; i < count; j = i++) {
          const [xi, yi, xj, yj] = [v[(first + i) * 3], v[(first + i) * 3 + 1], v[(first + j) * 3], v[(first + j) * 3 + 1]];
          if (yi > qy !== yj > qy && qx < ((xj - xi) * (qy - yi)) / (yj - yi) + xi) inside = !inside;
        }
      }
      if (inside) return r.id;
    }
    return null;
  }
}
