// Камера: координаты и касания — в CSS-пикселях; разрешение канваса учитывает только рендерер.

export class Camera {
  cx = 0;
  cy = 0;
  scale = 1;
  w = 1;
  h = 1;
  /** Высота шторки: центрирование учитывает видимую часть карты над ней. */
  inset = 0;
  bounds: [number, number, number, number];
  maxScale: number;
  /** Скорость инерции, км/мс. */
  vx = 0;
  vy = 0;

  constructor(bounds: [number, number, number, number], maxScale: number) {
    this.bounds = bounds;
    this.maxScale = maxScale;
  }

  get minScale() {
    const [x0, y0, x1, y1] = this.bounds;
    return Math.min(this.maxScale, Math.max(this.w / (x1 - x0), (this.h - this.inset) / (y1 - y0)));
  }

  private get midY() {
    return (this.h - this.inset) / 2;
  }

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.scale + this.w / 2, (y - this.cy) * this.scale + this.midY];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.w / 2) / this.scale + this.cx, (sy - this.midY) / this.scale + this.cy];
  }

  /** Размер области и шторки изменились: центр камеры в координатах карты сохраняется. */
  resize(w: number, h: number, inset: number) {
    this.w = w;
    this.h = h;
    this.inset = inset;
    this.clamp();
  }

  pan(dx: number, dy: number) {
    this.cx -= dx / this.scale;
    this.cy -= dy / this.scale;
    this.clamp();
  }

  zoomAt(factor: number, sx: number, sy: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    this.cx = wx - (sx - this.w / 2) / this.scale;
    this.cy = wy - (sy - this.midY) / this.scale;
    this.clamp();
  }

  centerOn(x: number, y: number, scale = this.scale) {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, scale));
    this.cx = x;
    this.cy = y;
    this.clamp();
  }

  /** Камера ограничена областью карты. */
  clamp() {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale));
    const [x0, y0, x1, y1] = this.bounds;
    const hw = this.w / 2 / this.scale;
    const hh = this.midY / this.scale;
    const lim = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
    this.cx = lim(this.cx, x0 + hw, x1 - hw);
    this.cy = lim(this.cy, y0 + hh, y1 - (this.h - this.midY) / this.scale);
  }

  /** Затухание скорости после жеста. Возвращает, продолжается ли движение. */
  inertia(dt: number): boolean {
    if (!this.vx && !this.vy) return false;
    const [px, py] = [this.cx, this.cy];
    this.cx -= this.vx * dt;
    this.cy -= this.vy * dt;
    this.clamp();
    const k = Math.exp(-dt / 320);
    this.vx *= k;
    this.vy *= k;
    const still = Math.hypot(this.vx, this.vy) * this.scale < 0.02 || (px === this.cx && py === this.cy);
    if (still) this.vx = this.vy = 0;
    return !still;
  }

  /** Матрица 3×3 (по столбцам): километры карты → пространство отсечения. */
  matrix(): Float32Array {
    const [sx, sy] = [(2 * this.scale) / this.w, (-2 * this.scale) / this.h];
    return new Float32Array([sx, 0, 0, 0, sy, 0, -this.cx * sx, -this.cy * sy - 1 + (2 * (this.h - this.midY)) / this.h, 1]);
  }
}
