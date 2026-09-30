// Клиент операций: запросы к посреднику, повторы, опрос по op_id.
// Операция идемпотентна: клиент всегда повторяет тот же запрос с тем же op_id.

import type { JsonValue } from '../protocol.gen.ts';

export type OpRequest = { op_id: string; kind: 'decide' | 'narrate'; pack_version: string; persona_id: string; tier: string; observation: JsonValue };

export type OpsDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Анонимный токен сессии: чтение и сохранение. */
  token: { get: () => Promise<string | undefined>; set: (t: string) => Promise<void> };
};

export class OpsClient {
  base: string;
  deps: OpsDeps;
  private session: Promise<string> | null = null;

  constructor(base: string, deps: OpsDeps) {
    this.base = base.replace(/\/$/, '');
    this.deps = deps;
  }

  private async auth(renew = false): Promise<string> {
    if (renew) this.session = null;
    this.session ??= (async () => {
      const saved = renew ? undefined : await this.deps.token.get();
      if (saved) return saved;
      const res = await this.deps.fetch(`${this.base}/v1/session`, { method: 'POST' });
      if (!res.ok) throw new Error(`session ${res.status}`);
      const { token } = await res.json();
      await this.deps.token.set(token);
      return token as string;
    })();
    return this.session.catch((e) => {
      this.session = null;
      throw e;
    });
  }

  private async call(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    for (let renewed = false; ; renewed = true) {
      const token = await this.auth(renewed);
      const res = await this.deps.fetch(this.base + path, { ...init, signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
      if (res.status !== 401 || renewed) return res;
    }
  }

  /**
   * Доводит операцию до результата. Молчание посредника не доказывает, что операции нет:
   * повторяется тот же запрос с растущей паузой. `null` — посредник отказал (лимит, ошибка модели).
   */
  async run(request: OpRequest, signal: AbortSignal): Promise<JsonValue | null> {
    let pause = 200;
    let posted = false;
    while (!signal.aborted) {
      try {
        const res = posted
          ? await this.call(`/v1/ops/${encodeURIComponent(request.op_id)}`, { method: 'GET' }, signal)
          : await this.call('/v1/ops', { method: 'POST', body: JSON.stringify(request) }, signal);
        if (res.status === 200) {
          const body = await res.json();
          if (body.status === 'failed') return null;
          if (body.result !== undefined && body.status !== 'pending') return body.result;
        }
        if (res.status === 200 || res.status === 202) {
          // Операция принята и ещё идёт — опрашиваем по op_id.
          posted = true;
          await this.deps.sleep(150);
          continue;
        }
        if (res.status === 404 && posted) {
          posted = false; // посредник не знает операцию — повторяем исходный запрос
          continue;
        }
        if (res.status >= 400 && res.status < 500) return null; // 409, 429 и прочие отказы
      } catch (e) {
        if (signal.aborted) break;
      }
      await this.deps.sleep(pause);
      pause = Math.min(pause * 2, 3000);
    }
    return null;
  }

  /** Пачка событий измерений; потеря пачки не важна. */
  async events(batch: JsonValue[]): Promise<void> {
    try {
      await this.call('/v1/events', { method: 'POST', body: JSON.stringify({ events: batch }) }, AbortSignal.timeout(5000));
    } catch {
      /* измерения не должны мешать игре */
    }
  }
}
