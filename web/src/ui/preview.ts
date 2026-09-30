// Проверенное превью: один запрос выполняется, один последний кандидат ждёт отправки;
// промежуточные кандидаты заменяются. Ответ с чужим `rev` или устаревшим `req_id` отбрасывается.

import type { OrderKind, Preview } from '../protocol.gen.ts';

export type PreviewDeps = {
  send: (reqId: number, rev: number, intents: OrderKind[]) => void;
  /** Показанная ревизия и хэш текущего пакета намерений. */
  rev: () => number;
  batch: () => string;
  show: (candidate: OrderKind, preview: Preview) => void;
};

export class PreviewQueue {
  private d: PreviewDeps;
  private seq = 0;
  private flying: { reqId: number; rev: number; key: string; candidate: OrderKind } | null = null;
  private waiting: OrderKind | null = null;
  private cache = new Map<string, Preview>();
  private cacheRev = -1;

  constructor(deps: PreviewDeps) {
    this.d = deps;
  }

  /** Ключ кэша: ревизия, пакет намерений и полный кандидат со всеми параметрами, включая `stance`. */
  private key(c: OrderKind) {
    return `${this.d.rev()}|${this.d.batch()}|${JSON.stringify(c)}`;
  }

  request(candidate: OrderKind) {
    // Любая новая ревизия очищает кэш.
    if (this.cacheRev !== this.d.rev()) {
      this.cache.clear();
      this.cacheRev = this.d.rev();
    }
    const hit = this.cache.get(this.key(candidate));
    if (hit) {
      this.waiting = null;
      return this.d.show(candidate, hit);
    }
    if (this.flying) this.waiting = candidate;
    else this.fly(candidate);
  }

  private fly(candidate: OrderKind) {
    this.flying = { reqId: ++this.seq, rev: this.d.rev(), key: this.key(candidate), candidate };
    this.d.send(this.flying.reqId, this.flying.rev, [candidate]);
  }

  result(reqId: number, rev: number, preview: Preview) {
    const f = this.flying;
    if (!f || f.reqId !== reqId) return;
    this.flying = null;
    const valid = rev === f.rev && rev === this.d.rev();
    if (valid) this.cache.set(f.key, preview);
    const next = this.waiting;
    this.waiting = null;
    if (next) this.request(next);
    else if (valid) this.d.show(f.candidate, preview);
  }

  /** Кандидат снят (жест отменён): ответ текущего запроса не будет показан. */
  clear() {
    this.waiting = null;
    this.flying = null;
  }

  get pending() {
    return (this.flying ? 1 : 0) + (this.waiting ? 1 : 0);
  }
}
