// Часы анимации: игровой день двигает только ядро; анимация показывает уже известный переход
// между показанной и принятой ревизиями.

import type { Marker, Pos, ViewUpdate } from '../protocol.gen.ts';
import { applyUpdate, compose, hasMapChanges, type ViewState, type ViewStore } from './store.ts';

/** Участок движения по ребру: от доли `f0` до `f1` длины его ломаной; вес — доля времени перехода. */
export type Leg = { edge: string; reversed: boolean; f0: number; f1: number; weight: number };
export type Move = { key: string; legs: Leg[] };

export type Graph = {
  /** Ребро между соседними узлами и его направление относительно (from → to). */
  edge: (from: string, to: string) => { id: string; reversed: boolean; days: number } | null;
};

const posLeg = (p: Extract<Pos, { t: 'Edge' }>, g: Graph) => {
  const e = g.edge(p.from, p.to);
  return e && { ...e, f: p.progress / p.days };
};

/** Свой актив идёт по фактическому пути: время на ребро пропорционально его `days`, скорость равномерна по длине. */
function ownLegs(a: Extract<Marker, { t: 'Own' }>, b: Extract<Marker, { t: 'Own' }>, g: Graph): Leg[] | null {
  const path = a.path.length ? a.path : b.path;
  const legs: Leg[] = [];
  let i = 0; // индекс узла пути, от которого идёт следующее ребро
  let f = 0;
  if (a.pos.t === 'Edge') {
    const at = posLeg(a.pos, g);
    if (!at || path[0] !== a.pos.from || path[1] !== a.pos.to) return null;
    f = at.f;
  } else if (path[0] !== a.pos.node) return null;
  for (; i + 1 < path.length; i++, f = 0) {
    const e = g.edge(path[i], path[i + 1]);
    if (!e) return null;
    const endsHere = b.pos.t === 'Edge' ? b.pos.from === path[i] && b.pos.to === path[i + 1] : false;
    const f1 = endsHere ? (b.pos as Extract<Pos, { t: 'Edge' }>).progress / e.days : 1;
    if (f1 > f) legs.push({ edge: e.id, reversed: e.reversed, f0: f, f1, weight: (f1 - f) * e.days });
    if (endsHere || (b.pos.t === 'Node' && b.pos.node === path[i + 1])) return legs;
  }
  return null;
}

/**
 * Движения маркеров между двумя показанными состояниями. Чужое перемещение анимируется по ребру,
 * только если актив видели в двух соседних узлах в два соседних дня; иначе — «известно без маршрута».
 */
export function moves(from: ViewState, to: ViewState, g: Graph): Move[] {
  const out: Move[] = [];
  for (const [key, b] of to.markers) {
    const a = from.markers.get(key);
    if (!a || a === b) continue;
    if (a.t === 'Own' && b.t === 'Own') {
      const legs = ownLegs(a, b, g);
      if (legs?.length) out.push({ key, legs });
    } else if (a.t === 'Foreign' && b.t === 'Foreign' && a.node !== b.node && b.info_day === a.info_day + 1) {
      const e = g.edge(a.node, b.node);
      if (e) out.push({ key, legs: [{ edge: e.id, reversed: e.reversed, f0: 0, f1: 1, weight: 1 }] });
    }
  }
  return out;
}

/** Положение на движении в момент `t` ∈ [0, 1]: ребро и доля его длины. */
export function along(move: Move, t: number): { edge: string; reversed: boolean; f: number } {
  const total = move.legs.reduce((s, l) => s + l.weight, 0);
  let rest = Math.min(1, Math.max(0, t)) * total;
  for (const l of move.legs) {
    if (rest <= l.weight || l === move.legs.at(-1)) {
      const k = l.weight ? Math.min(1, rest / l.weight) : 1;
      return { edge: l.edge, reversed: l.reversed, f: l.f0 + (l.f1 - l.f0) * k };
    }
    rest -= l.weight;
  }
  throw new Error('пустое движение');
}

export type Transition = { to: ViewState; start: number; duration: number; moves: Move[] };

export type ClockOptions = {
  /** Длительность дня на экране и перехода-скачка, мс (гипотезы). */
  tDay: number;
  tJump: number;
  /** Сколько переходов ждут за текущим (гипотеза). */
  maxWaiting: number;
  graph: Graph;
  /** Скачки вместо переходов: скрытая вкладка, `prefers-reduced-motion`. */
  instant: () => boolean;
};

export class Clock {
  current: Transition | null = null;
  /** Число объединений обновлений — метрика отставания анимации. */
  merges = 0;
  private store: ViewStore;
  private o: ClockOptions;

  constructor(store: ViewStore, options: ClockOptions) {
    this.store = store;
    this.o = options;
  }

  get busy() {
    return this.current !== null || this.store.pending.length > 0;
  }

  /** Вызывается, когда хранилище приняло обновление. */
  accept(now: number) {
    const q = this.store.pending;
    const atStop = q.at(-1)?.phase !== 'Advancing';
    // Переполнение очереди и остановка: ожидающие обновления объединяются в один переход-скачок.
    if (q.length > this.o.maxWaiting || (atStop && q.length > 1)) {
      this.store.pending = [q.reduce(compose)];
      this.merges++;
      (this.store.pending[0] as ViewUpdate & { jump?: boolean }).jump = true;
    }
    // Перед приказами показанная ревизия доводится до принятой: текущий переход ускоряется.
    if (atStop && this.current) this.current.duration = Math.min(this.current.duration, Math.max(0, now - this.current.start) + this.o.tJump);
    if (atStop && this.store.pending[0]) (this.store.pending[0] as ViewUpdate & { jump?: boolean }).jump = true;
    this.tick(now);
  }

  /** Продвигает переходы. Возвращает, нужен ли ещё кадр. */
  tick(now: number): boolean {
    for (;;) {
      if (this.current) {
        if (now - this.current.start < this.current.duration) return true;
        this.store.show(this.current.to);
        this.current = null;
      }
      const next = this.store.pending.shift() as (ViewUpdate & { jump?: boolean }) | undefined;
      if (!next) return false;
      const from = this.store.shown!;
      const to = applyUpdate(from, next);
      // Дни без видимых изменений не проигрываются.
      const duration = this.o.instant() || !hasMapChanges(next) ? 0 : next.jump ? this.o.tJump : this.o.tDay;
      this.current = { to, start: now, duration, moves: duration ? moves(from, to, this.o.graph) : [] };
    }
  }

  /** Возврат и восстановление: сразу последняя ревизия, без пропущенных анимаций. */
  reset() {
    this.current = null;
  }
}
