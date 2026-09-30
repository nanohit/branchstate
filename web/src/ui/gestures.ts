// Машина жестов: тап, панорама, масштабирование двумя пальцами, перетаскивание выбранного актива, инерция.
// Чистая логика без DOM: события указателей на входе, действия на выходе.

export type GestureState = 'Idle' | 'Pressing' | 'Panning' | 'Pinching' | 'Dragging' | 'Inertia';

export type GestureOut = {
  tap(x: number, y: number): void;
  pan(dx: number, dy: number): void;
  /** Масштаб вокруг центра двух пальцев; сдвиг центра — панорама. */
  pinch(factor: number, cx: number, cy: number, dx: number, dy: number): void;
  dragStart(x: number, y: number): void;
  drag(x: number, y: number): void;
  /** Отпускание: над целью — превью, вне цели фишка возвращается. */
  drop(x: number, y: number): void;
  /** Черновик перетаскивания отменён; выбор сохраняется. */
  dragCancel(): void;
  inertia(vx: number, vy: number): void;
  stop(): void;
};

export const SLOP_PX = 8;
export const TAP_MS = 300;

type Pt = { x: number; y: number; t: number };

export class Gestures {
  state: GestureState = 'Idle';
  private out: GestureOut;
  private pts = new Map<number, Pt>();
  private origin: Pt = { x: 0, y: 0, t: 0 };
  private onAsset = false;
  private velocity = { x: 0, y: 0 };

  constructor(out: GestureOut) {
    this.out = out;
  }

  /** `onSelectedAsset` — касание началось на уже выбранном своём свободном активе. */
  down(id: number, x: number, y: number, t: number, onSelectedAsset: boolean) {
    this.pts.set(id, { x, y, t });
    if (this.pts.size === 1) {
      if (this.state === 'Inertia') this.out.stop();
      this.state = 'Pressing';
      this.origin = { x, y, t };
      this.onAsset = onSelectedAsset;
      this.velocity = { x: 0, y: 0 };
    } else if (this.pts.size === 2) {
      // Второй палец в любой момент переводит жест в масштабирование; черновик перетаскивания отменяется.
      if (this.state === 'Dragging') this.out.dragCancel();
      this.state = 'Pinching';
    }
  }

  move(id: number, x: number, y: number, t: number) {
    const prev = this.pts.get(id);
    if (!prev) return;
    const before = this.pinchFrame();
    this.pts.set(id, { x, y, t });
    switch (this.state) {
      case 'Pressing':
        if (Math.hypot(x - this.origin.x, y - this.origin.y) < SLOP_PX) return;
        // Перетаскивать можно только выбранный свой свободный актив; движение с невыбранного — панорама.
        if (this.onAsset) {
          this.state = 'Dragging';
          this.out.dragStart(this.origin.x, this.origin.y);
          this.out.drag(x, y);
        } else {
          this.state = 'Panning';
          this.out.pan(x - this.origin.x, y - this.origin.y);
        }
        return;
      case 'Panning': {
        const dt = Math.max(1, t - prev.t);
        // Скорость сглаживается: инерция не должна зависеть от последнего дёрганого события.
        this.velocity = { x: 0.6 * this.velocity.x + (0.4 * (x - prev.x)) / dt, y: 0.6 * this.velocity.y + (0.4 * (y - prev.y)) / dt };
        this.out.pan(x - prev.x, y - prev.y);
        return;
      }
      case 'Dragging':
        this.out.drag(x, y);
        return;
      case 'Pinching': {
        const after = this.pinchFrame();
        if (before && after && before.d > 0) this.out.pinch(after.d / before.d, after.cx, after.cy, after.cx - before.cx, after.cy - before.cy);
        return;
      }
    }
  }

  up(id: number, t: number) {
    const p = this.pts.get(id);
    if (!p) return;
    this.pts.delete(id);
    switch (this.state) {
      case 'Pressing':
        this.state = 'Idle';
        if (t - this.origin.t < TAP_MS) this.out.tap(p.x, p.y);
        return;
      case 'Dragging':
        this.state = 'Idle';
        this.out.drop(p.x, p.y);
        return;
      case 'Panning':
        this.release(t - p.t);
        return;
      case 'Pinching':
        if (this.pts.size === 1) {
          // Остался один палец — панорама с нуля скорости.
          this.state = 'Panning';
          this.velocity = { x: 0, y: 0 };
          const [rest] = this.pts.values();
          rest.t = t;
        } else if (this.pts.size === 0) this.release(0);
        return;
    }
  }

  /** `pointercancel` и `lostpointercapture` всегда возвращают жест в `Idle`, без инерции. */
  cancel() {
    if (this.state === 'Dragging') this.out.dragCancel();
    if (this.state === 'Inertia') this.out.stop();
    this.pts.clear();
    this.state = 'Idle';
  }

  /** Координатор кадра сообщает, что затухание скорости камеры закончилось. */
  inertiaDone() {
    if (this.state === 'Inertia') this.state = 'Idle';
  }

  private release(idleMs: number) {
    const speed = Math.hypot(this.velocity.x, this.velocity.y);
    // Палец остановился перед отпусканием — инерции нет.
    if (speed > 0.05 && idleMs < 80) {
      this.state = 'Inertia';
      this.out.inertia(this.velocity.x, this.velocity.y);
    } else this.state = 'Idle';
  }

  private pinchFrame() {
    if (this.pts.size !== 2) return null;
    const [a, b] = [...this.pts.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
}
