// Карта: единственный цикл кадра (координатор), DOM-слой маркеров и подписей, жесты.
// Порядок кадра: указатели → камера и переходы → экранные позиции → DOM и WebGL с одной камерой.

import type { Marker, Pos } from '../protocol.gen.ts';
import { Camera } from './camera.ts';
import { along, type Clock } from './clock.ts';
import type { Geo } from './geo.ts';
import { Gestures } from './gestures.ts';
import { Renderer, type Flash, type Route } from './renderer.ts';
import type { ViewState, ViewStore } from './store.ts';
import { FLASH_MS, css, ownerColor } from './theme.ts';

export type Hit = { kind: 'marker'; key: string } | { kind: 'node'; id: string } | { kind: 'region'; id: string } | null;

export type MapHooks = {
  ownerIndex: (id: string | null) => number;
  player: () => number;
  /** Выбранный объект и подсветки — интерфейсное состояние. */
  selected: () => { marker: string | null; region: string | null };
  routes: () => Route[];
  /** Касание началось на выбранном своём свободном активе — с него можно тянуть. */
  draggable: (key: string) => boolean;
  tap: (hit: Hit) => void;
  /** Фишка над точкой экрана: ближайшая допустимая цель в радиусе притяжения или `null`. */
  dragOver: (x: number, y: number) => string | null;
  drop: (node: string | null) => void;
  dragCancel: () => void;
  metric: (name: string, value: number) => void;
};

const KIND: Record<string, string> = { Army: 'А', Fleet: 'Ф', Flotilla: 'ф', Convoy: 'К' };
const STANCE: Record<string, string> = { Demonstrate: 'демонстрация', Escort: 'эскорт', Blockade: 'блокада' };
const SNAP_PX = 48;
const HIT_PX = 24;
const MARGIN_PX = 64;

type El = { el: HTMLElement; tf: string; w: number; h: number; x: number; y: number; on: boolean };

export class MapView {
  cam: Camera;
  renderer: Renderer;
  gestures: Gestures;
  root: HTMLElement;
  private layer: HTMLElement;
  private geo: Geo;
  private store: ViewStore;
  private clock: Clock;
  private hooks: MapHooks;
  private dirty = false;
  private raf = 0;
  private last = 0;
  private markers = new Map<string, El>();
  private nodes = new Map<string, El>();
  private labels = new Map<string, El>();
  private shownFor: ViewState | null = null;
  private flashes: Flash[] = [];
  private seenFlash = new Set<string>();
  private drag: { key: string; x: number; y: number; snap: string | null } | null = null;
  private labelScale = 0;
  private labelAt = 0;
  private frames: number[] = [];
  private active = false;
  private resizeAt = 0;

  constructor(root: HTMLElement, geo: Geo, store: ViewStore, clock: Clock, palettePx: Uint8Array, hooks: MapHooks) {
    this.root = root;
    this.geo = geo;
    this.store = store;
    this.clock = clock;
    this.hooks = hooks;
    const canvas = document.createElement('canvas');
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    root.append(canvas, this.layer);
    this.cam = new Camera(geo.meta.bounds, geo.maxScale);
    this.renderer = new Renderer(canvas, geo, palettePx, () => this.invalidate());
    this.buildStatic();

    this.gestures = new Gestures({
      tap: (x, y) => this.hooks.tap(this.hit(x, y)),
      pan: (dx, dy) => (this.cam.pan(dx, dy), this.invalidate()),
      pinch: (f, cx, cy, dx, dy) => (this.cam.pan(dx, dy), this.cam.zoomAt(f, cx, cy), this.invalidate()),
      dragStart: (x, y) => {
        const hit = this.hit(x, y);
        this.drag = hit?.kind === 'marker' ? { key: hit.key, x, y, snap: null } : null;
      },
      drag: (x, y) => {
        if (!this.drag) return;
        const snap = this.hooks.dragOver(x, y);
        // Тактильный отклик при притяжении к цели, где API есть.
        if (snap && snap !== this.drag.snap) navigator.vibrate?.(10);
        Object.assign(this.drag, { x, y, snap });
        this.invalidate();
      },
      drop: () => {
        const snap = this.drag?.snap ?? null;
        this.drag = null;
        this.hooks.drop(snap);
        this.invalidate();
      },
      dragCancel: () => {
        this.drag = null;
        this.hooks.dragCancel();
        this.invalidate();
      },
      inertia: (vx, vy) => ((this.cam.vx = vx / this.cam.scale), (this.cam.vy = vy / this.cam.scale), this.invalidate()),
      stop: () => (this.cam.vx = this.cam.vy = 0),
    });
    this.bind();
  }

  /** Пометить кадр грязным: отрисовка только по требованию. */
  invalidate() {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Узел-цель в радиусе притяжения от точки экрана среди допустимых. */
  snapTarget(x: number, y: number, allowed: Iterable<string>): string | null {
    let best: string | null = null;
    let bd = SNAP_PX;
    for (const id of allowed) {
      const n = this.geo.nodes.get(id)!;
      const [sx, sy] = this.cam.toScreen(n.x, n.y);
      const d = Math.hypot(sx - x, sy - y);
      if (d < bd) [best, bd] = [id, d];
    }
    return best;
  }

  /** Допустимые цели выбранного актива подсвечиваются на своих узлах. */
  setTargets(ids: Set<string>) {
    for (const [id, e] of this.nodes) e.el.classList.toggle('tgt', ids.has(id));
    this.invalidate();
  }

  centerOnNode(id: string, scale?: number) {
    const n = this.geo.nodes.get(id);
    if (n) this.cam.centerOn(n.x, n.y, scale);
    this.invalidate();
  }

  // ---- ввод: Pointer Events на корне карты

  private bind() {
    const r = this.root;
    const xy = (e: PointerEvent): [number, number] => {
      const b = r.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top];
    };
    r.addEventListener('pointerdown', (e) => {
      r.setPointerCapture(e.pointerId);
      const [x, y] = xy(e);
      const hit = this.hit(x, y);
      this.gestures.down(e.pointerId, x, y, e.timeStamp, hit?.kind === 'marker' && this.hooks.draggable(hit.key));
      this.active = true;
    });
    r.addEventListener('pointermove', (e) => this.gestures.move(e.pointerId, ...xy(e), e.timeStamp));
    r.addEventListener('pointerup', (e) => (this.gestures.up(e.pointerId, e.timeStamp), this.gestureEnd()));
    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      r.addEventListener(type, () => {
        if (this.gestures.state !== 'Idle' && this.gestures.state !== 'Inertia') this.gestures.cancel();
        this.gestureEnd();
      });
    }
    r.addEventListener('wheel', (e) => (e.preventDefault(), this.cam.zoomAt(Math.exp(-e.deltaY * 0.0015), ...xyWheel(e, r)), this.invalidate()), { passive: false });
    // Фокус с клавиатуры на десктопе: Enter и пробел на маркере — как тап.
    this.layer.addEventListener('keydown', (e) => {
      const key = (e.target as HTMLElement).dataset.key;
      if (key && (e.key === 'Enter' || e.key === ' ')) this.hooks.tap({ kind: 'marker', key });
    });
    const resize = () => {
      this.resizeAt = performance.now();
      this.invalidate();
    };
    new ResizeObserver(resize).observe(r);
    visualViewport?.addEventListener('resize', resize);
  }

  private gestureEnd() {
    if (this.gestures.state !== 'Idle' && this.gestures.state !== 'Inertia') return;
    this.active = false;
    sessionStorage.setItem('bs.cam', JSON.stringify([this.cam.cx, this.cam.cy, this.cam.scale]));
    this.govern();
  }

  /** Регулятор качества: по кадрам последнего жеста, только после его окончания, с гистерезисом. */
  private govern() {
    const f = this.frames.splice(0);
    if (f.length < 12) return;
    f.sort((a, b) => a - b);
    const p95 = f[Math.floor(f.length * 0.95)];
    const slow = f.filter((x) => x > 16.7).length / f.length;
    this.hooks.metric('frames_slow_pct', Math.round(slow * 100));
    this.hooks.metric('frame_max_ms', Math.round(f[f.length - 1]));
    const r = this.renderer;
    const next = p95 > 22 && r.renderScale > 0.5 ? r.renderScale - 0.25 : p95 < 11 && r.renderScale < 1 ? r.renderScale + 0.25 : r.renderScale;
    if (next !== r.renderScale) {
      r.renderScale = next;
      this.hooks.metric('render_scale_pct', next * 100);
      this.invalidate();
    }
  }

  /** Попадание касания: маркеры и узлы — по экранным позициям, регион — на CPU по контурам. */
  hit(x: number, y: number): Hit {
    let best: Hit = null;
    let bd = HIT_PX;
    for (const [key, m] of this.markers) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (m.on && d < bd) [best, bd] = [{ kind: 'marker', key }, d];
    }
    if (best) return best;
    for (const [id, n] of this.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (n.on && d < bd) [best, bd] = [{ kind: 'node', id }, d];
    }
    if (best) return best;
    const id = this.geo.regionAt(...this.cam.toWorld(x, y));
    return id ? { kind: 'region', id } : null;
  }

  // ---- DOM-слой

  private make(tag: string, cls: string, html: string): El {
    const el = document.createElement(tag);
    el.className = cls;
    el.innerHTML = html;
    this.layer.append(el);
    return { el, tf: '', w: 0, h: 0, x: 0, y: 0, on: true };
  }

  private buildStatic() {
    for (const n of this.geo.meta.nodes) this.nodes.set(n.id, this.make('div', `nd p${n.priority}${n.sea ? ' sea' : ''}${n.port ? ' port' : ''}`, `<i></i><span>${n.name}</span>`));
    for (const r of this.geo.meta.regions) this.labels.set(r.id, this.make('div', 'rl', r.name));
    this.measure();
    // Размеры подписей измеряются один раз при создании и после загрузки шрифта.
    document.fonts?.ready.then(() => (this.measure(), this.invalidate()));
  }

  private measure() {
    for (const e of [...this.nodes.values(), ...this.labels.values()]) {
      const text = e.el.querySelector('span') ?? e.el;
      e.w = text.offsetWidth;
      e.h = text.offsetHeight;
    }
    this.labelScale = 0;
  }

  private syncMarkers(state: ViewState) {
    if (this.shownFor === state) return;
    this.shownFor = state;
    for (const [key, m] of state.markers) {
      if (m.t === 'Flash') {
        // Вспышка — только в день, когда игрок узнал о событии, в узле из claims.
        const n = this.geo.nodes.get(m.node);
        if (n && !this.seenFlash.has(key)) this.flashes.push({ x: n.x, y: n.y, start: performance.now() });
        this.seenFlash.add(key);
        continue;
      }
      let e = this.markers.get(key);
      if (!e) {
        e = this.make('button', 'mk', '');
        e.el.dataset.key = key;
        e.el.setAttribute('role', 'button');
        this.markers.set(key, e);
      }
      const age = m.t === 'Own' ? 0 : Math.min(3, Math.floor((state.day - m.info_day) / 3));
      const stance = m.t !== 'Unknown' && m.stance ? STANCE[m.stance] : '';
      const cls = `mk ${m.t.toLowerCase()} k${m.kind}${m.t === 'Own' && m.free ? ' free' : ''} a${age}${stance ? ' st' : ''}`;
      if (e.el.className !== cls) e.el.className = cls;
      const text = m.t === 'Unknown' ? '?' : KIND[m.kind];
      if (e.el.textContent !== text) e.el.textContent = text;
      // Вид по давности сведений задаёт тема; смысл — в подписи для доступности.
      const label =
        m.t === 'Own'
          ? `${m.name}: ${m.free ? 'свободен' : m.busy_until != null ? `занят ещё ${m.busy_until - state.day} дн.` : 'занят'}${stance ? `, ${stance}` : ''}`
          : m.t === 'Foreign'
            ? `${m.name}: сведения ${state.day - m.info_day} дн. назад${stance ? `, ${stance}` : ''}`
            : `Неопознанное наблюдение, ${state.day - m.info_day} дн. назад`;
      if (e.el.getAttribute('aria-label') !== label) e.el.setAttribute('aria-label', label);
      if (m.t !== 'Unknown') e.el.style.setProperty('--c', css(ownerColor(this.hooks.ownerIndex(m.t === 'Own' ? null : m.owner), m.t === 'Own')));
    }
    for (const [key, e] of this.markers) {
      if (!state.markers.has(key)) {
        e.el.remove();
        this.markers.delete(key);
      }
    }
    this.labelScale = 0;
  }

  private posOf(p: Pos): [number, number] {
    if (p.t === 'Node') {
      const n = this.geo.nodes.get(p.node)!;
      return [n.x, n.y];
    }
    const e = this.geo.edge(p.from, p.to)!;
    return this.geo.edgePoint(e.id, p.progress / p.days, e.reversed);
  }

  private place(e: El, x: number, y: number, dx = 0, dy = 0) {
    const [sx, sy] = this.cam.toScreen(x, y);
    e.x = sx + dx;
    e.y = sy + dy;
    // Объекты вне экрана с запасом исключаются из покадровой работы.
    const on = e.x > -MARGIN_PX && e.y > -MARGIN_PX && e.x < this.cam.w + MARGIN_PX && e.y < this.cam.h + MARGIN_PX;
    const tf = on ? `translate3d(${e.x.toFixed(1)}px,${e.y.toFixed(1)}px,0)` : 'off';
    if (tf === e.tf) return;
    if (on !== e.on || !e.tf) e.el.style.display = on ? '' : 'none';
    if (on) e.el.style.transform = tf;
    e.tf = tf;
    e.on = on;
  }

  // ---- кадр

  private frame(now: number) {
    this.raf = 0;
    this.dirty = false;
    const dt = this.last ? Math.min(64, now - this.last) : 16;
    const animating = this.active || this.clock.current !== null;
    if (animating && this.last) this.frames.push(now - this.last);
    this.last = now;

    // Размеры: CSS обновляется сразу, буфер канваса — после стабилизации viewport и окончания жеста.
    const [w, h] = [this.root.clientWidth, this.root.clientHeight];
    const inset = Number(this.root.dataset.inset ?? 0);
    if (w !== this.cam.w || h !== this.cam.h || inset !== this.cam.inset) this.cam.resize(w, h, inset);
    const settled = !this.active && now - this.resizeAt > 150;
    if (settled || !this.renderer.canvas.width) this.renderer.resize(w, h);

    // Камера и визуальные переходы.
    let more = this.cam.inertia(dt);
    if (!more && this.gestures.state === 'Inertia') {
      this.gestures.inertiaDone();
      this.gestureEnd();
    }
    more = this.clock.tick(now) || more;
    const state = this.store.shown;
    if (state) this.syncMarkers(state);

    // Экранные позиции видимых маркеров и подписей; раскладка в этом проходе не читается.
    for (const [id, e] of this.nodes) {
      const n = this.geo.nodes.get(id)!;
      this.place(e, n.x, n.y);
    }
    for (const [id, e] of this.labels) {
      const r = this.geo.regions.get(id)!;
      this.place(e, r.label[0], r.label[1]);
    }
    if (state) {
      const tr = this.clock.current;
      const t = tr && tr.duration ? Math.min(1, (now - tr.start) / tr.duration) : 1;
      const moving = new Map(tr?.moves.map((m) => [m.key, m]) ?? []);
      // Несколько активов в одном узле раскладываются веером вокруг якоря.
      const groups = new Map<string, string[]>();
      const at = new Map<string, [number, number, string | null]>();
      for (const [key, m] of state.markers) {
        if (m.t === 'Flash') continue;
        const mv = moving.get(key);
        if (mv && t < 1) {
          const p = along(mv, t);
          at.set(key, [...this.geo.edgePoint(p.edge, p.f, p.reversed), null]);
          continue;
        }
        const node = m.t === 'Own' ? (m.pos.t === 'Node' ? m.pos.node : null) : m.node;
        at.set(key, [...(m.t === 'Own' ? this.posOf(m.pos) : this.posOf({ t: 'Node', node: m.node })), node]);
        if (node) groups.set(node, [...(groups.get(node) ?? []), key]);
      }
      for (const [key, [x, y, node]] of at) {
        const e = this.markers.get(key)!;
        const g = node ? groups.get(node)! : [key];
        const i = g.indexOf(key);
        if (this.drag?.key === key) {
          const [wx, wy] = this.cam.toWorld(this.drag.x, this.drag.y);
          this.place(e, wx, wy, 0, -22);
        } else this.place(e, x, y, (i - (g.length - 1) / 2) * 30, node ? -20 : 0);
        e.el.classList.toggle('drag', this.drag?.key === key);
      }
    }
    this.declutter(now);

    // Вспышки конечны.
    this.flashes = this.flashes.filter((f) => now - f.start < FLASH_MS);
    more ||= this.flashes.length > 0;

    const sel = this.hooks.selected();
    this.renderer.render(this.cam, { regions: state?.regions ?? new Map(), ownerIndex: this.hooks.ownerIndex, selected: sel.region, hover: null, routes: this.hooks.routes(), flashes: this.flashes }, now);
    for (const e of this.markers.values()) e.el.classList.toggle('sel', e.el.dataset.key === sel.marker);

    if (!more) this.last = 0;
    if (more || this.dirty || !settled) this.invalidate();
  }

  /** Подавление пересечений подписей по закэшированным прямоугольникам: после окончания масштабирования, не чаще раза в 100 мс. */
  private declutter(now: number) {
    if (this.cam.scale === this.labelScale || this.gestures.state === 'Pinching' || now - this.labelAt < 100) return;
    this.labelScale = this.cam.scale;
    this.labelAt = now;
    const taken: [number, number, number, number][] = [];
    const free = (r: [number, number, number, number]) => taken.every((t) => r[2] < t[0] || r[0] > t[2] || r[3] < t[1] || r[1] > t[3]);
    const s = this.cam.scale;
    const items: { e: El; rect: [number, number, number, number]; pr: number }[] = [];
    for (const [id, e] of this.nodes) {
      const n = this.geo.nodes.get(id)!;
      const [x, y] = [n.x * s, n.y * s];
      items.push({ e, rect: [x + 7, y - e.h / 2, x + 9 + e.w, y + e.h / 2], pr: 10 + n.priority });
    }
    for (const [id, e] of this.labels) {
      const r = this.geo.regions.get(id)!;
      const [x, y] = [r.label[0] * s, r.label[1] * s];
      // Подпись региона показывается, если регион на экране заметно больше неё.
      items.push({ e, rect: [x - e.w / 2, y - e.h / 2, x + e.w / 2, y + e.h / 2], pr: Math.sqrt(r.area) * s > e.w * 1.6 ? Math.min(9, Math.sqrt(r.area) * s * 0.01) : -1 });
    }
    items.sort((a, b) => b.pr - a.pr);
    for (const it of items) {
      const show = it.pr >= 0 && free(it.rect);
      if (show) taken.push(it.rect);
      it.e.el.classList.toggle('hide', !show);
    }
  }
}

function xyWheel(e: WheelEvent, r: HTMLElement): [number, number] {
  const b = r.getBoundingClientRect();
  return [e.clientX - b.left, e.clientY - b.top];
}
