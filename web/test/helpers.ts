// Общие части тестов Worker: ядро WASM в Node, IndexedDB в памяти, блокировки и посредник-заглушка.

import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import path from 'node:path';
import { Core, initSync } from '../../build/wasm/branchstate_wasm.js';
import type { Command, CommandBody, FromWorker, RuntimeManifest, ToWorker, ViewSnapshot, ViewUpdate } from '../src/protocol.gen.ts';
import { ENGINE_VERSION } from '../src/protocol.gen.ts';
import type { Faults } from '../src/worker/db.ts';
import { type CoreFactory, type Deps, Host } from '../src/worker/host.ts';

const root = path.resolve(import.meta.dirname, '../..');
initSync({ module: fs.readFileSync(path.join(root, 'build/wasm/branchstate_wasm_bg.wasm')) });

export { Core };
export const coreFactory = Core as unknown as CoreFactory;

export function pack(scenario: string): string {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(root, 'scenarios', scenario, f), 'utf8'));
  return JSON.stringify({ ...read('map.json'), ...read('scenario.json') });
}

const file = (name: string) => ({ url: name, sri: '' });
export const manifest: RuntimeManifest = {
  id: 'test-manifest',
  protocol: 1,
  engine_version: ENGINE_VERSION,
  ui: file('ui'),
  core: file('core'),
  wasm: file('wasm'),
  fonts: [],
  scenarios: Object.fromEntries(
    ['island', 'july1914'].map((s) => [s, { title: JSON.parse(pack(s)).title, pack_version: JSON.parse(pack(s)).version, pack: file(s), geo_bin: file('bin'), geo_json: file('json') }]),
  ),
};

/** Web Locks в памяти: одна «вкладка» — один `Host`, блокировки общие. */
export class FakeLocks {
  private held = new Map<string, { steal: () => void; released: Promise<void> }>();

  async request(name: string, options: LockOptions | LockGrantedCallback<unknown>, callback?: LockGrantedCallback<unknown>): Promise<unknown> {
    const opts = typeof options === 'function' ? {} : options;
    const cb = (typeof options === 'function' ? options : callback)!;
    for (let cur = this.held.get(name); cur; cur = this.held.get(name)) {
      if (opts.steal) {
        cur.steal();
        this.held.delete(name);
      } else if (opts.ifAvailable) return cb(null);
      else await cur.released;
    }
    let steal!: () => void;
    const stolen = new Promise<never>((_, reject) => (steal = () => reject(new DOMException('блокировка перехвачена', 'AbortError'))));
    stolen.catch(() => {});
    const work = Promise.resolve(cb({ name, mode: 'exclusive' }));
    const entry = { steal, released: work.then(() => {}, () => {}) };
    this.held.set(name, entry);
    try {
      return await Promise.race([work, stolen]);
    } finally {
      if (this.held.get(name) === entry) this.held.delete(name);
    }
  }
}

/** Посредник-заглушка с управляемыми сбоями. Считает, сколько раз операция действительно исполнялась. */
export class FakeProxy {
  executed = new Map<string, number>();
  results = new Map<string, unknown>();
  requests: { method: string; path: string }[] = [];
  events: unknown[] = [];
  /** Ответ модели на операцию; `null` — отказ; задержка в мс. */
  answer: (req: any) => unknown = () => null;
  delay = 0;
  /** Сколько первых ответов на POST /v1/ops потерять после исполнения. */
  dropResponses = 0;
  /** Сколько запросов вообще не дойдёт. */
  offline = 0;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.requests.push({ method, path: url.pathname });
    if (this.offline > 0) {
      this.offline--;
      throw new TypeError('network down');
    }
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v1/session') return json(200, { token: 'test-token', limits: {} });
    if (url.pathname === '/v1/events') {
      this.events.push(...JSON.parse(String(init!.body)).events);
      return json(200, {});
    }
    if (url.pathname === '/v1/ops' && method === 'POST') {
      const req = JSON.parse(String(init!.body));
      if (!this.results.has(req.op_id)) {
        this.executed.set(req.op_id, (this.executed.get(req.op_id) ?? 0) + 1);
        if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
        this.results.set(req.op_id, this.answer(req));
      }
      if (this.dropResponses > 0) {
        this.dropResponses--;
        throw new TypeError('connection reset');
      }
      const result = this.results.get(req.op_id);
      return result === null ? json(200, { status: 'failed' }) : json(200, { result });
    }
    const m = /^\/v1\/ops\/(.+)$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!this.results.has(id)) return json(404, {});
      const result = this.results.get(id);
      return result === null ? json(200, { status: 'failed' }) : json(200, { status: 'done', result });
    }
    return json(404, {});
  };
}

export type Tab = {
  host: Host;
  out: FromWorker[];
  send: (msg: ToWorker) => Promise<void>;
  open: (runId: string | null, opts?: { steal?: boolean }) => Promise<void>;
  cmd: (runId: string, body: CommandBody, extra?: Partial<Command>) => Promise<Extract<FromWorker, { t: 'CommandResult' }>>;
  view: () => ViewSnapshot;
  rev: () => number;
  take: <T extends FromWorker['t']>(t: T) => Extract<FromWorker, { t: T }>[];
};

let seq = 0;
export const uuid = () => `id-${++seq}`;

export type Env = { idb: IDBFactory; locks: FakeLocks; proxy?: FakeProxy; faults?: Faults; budget?: Deps['budget'] };

export const newEnv = (extra: Partial<Env> = {}): Env => ({ idb: new IDBFactory(), locks: new FakeLocks(), ...extra });

/** Одна «вкладка»: свой Worker (Host) поверх общих хранилища и блокировок. */
export function tab(env: Env): Tab {
  const out: FromWorker[] = [];
  let snapshot: ViewSnapshot | null = null;
  let rev = 0;
  const host = new Host({
    idb: env.idb,
    locks: env.locks as unknown as LockManager,
    fetch: env.proxy ? env.proxy.fetch : () => Promise.reject(new Error('сети нет')),
    post: (msg) => {
      out.push(structuredClone(msg));
      if (msg.t === 'ViewSnapshot') [snapshot, rev] = [msg, msg.rev];
      const update: ViewUpdate | null = msg.t === 'ViewUpdate' ? msg : msg.t === 'CommandResult' ? msg.update : null;
      if (update) rev = update.rev;
    },
    now: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    uuid,
    randomSeed: () => 12345,
    today: () => '2026-09-30',
    loadCore: async () => coreFactory,
    loadPack: async (_m, scenario) => pack(scenario),
    faults: env.faults,
    budget: env.budget ?? { advance: 400, recovery: 200 },
  });
  const t: Tab = {
    host,
    out,
    send: (msg) => host.handle(msg),
    open: (runId, opts = {}) => host.handle({ t: 'Open', epoch: uuid(), run_id: runId, manifest, proxy: env.proxy ? 'http://proxy.test' : null, steal: opts.steal ?? false }),
    async cmd(runId, body, extra = {}) {
      const command_id = extra.command_id ?? uuid();
      await host.handle({ t: 'Command', run_id: runId, command_id, expected_rev: extra.expected_rev ?? rev, body });
      return out.filter((m) => m.t === 'CommandResult' && m.command_id === command_id).at(-1) as Extract<FromWorker, { t: 'CommandResult' }>;
    },
    view: () => snapshot!,
    rev: () => rev,
    take: (type) => out.filter((m) => m.t === type) as never,
  };
  return t;
}

/** Новая партия и её открытие во вкладке. */
export async function newRun(t: Tab, scenario = 'island', mode: 'Scripted' | 'Llm' = 'Scripted', seed = 7): Promise<string> {
  await t.open(null);
  const runId = uuid();
  const res = await t.cmd(runId, { t: 'NewRun', scenario, seed, daily: false, mode });
  if (res.outcome.t !== 'Accepted') throw new Error(`NewRun: ${JSON.stringify(res.outcome)}`);
  await t.open(runId);
  return runId;
}

/** «Дальше» до остановки; возвращает, закончилась ли партия. */
export async function advance(t: Tab, runId: string, mode: 'Next' | { Days: number } = 'Next'): Promise<boolean> {
  const res = await t.cmd(runId, { t: 'Advance', mode });
  if (res.outcome.t !== 'Accepted') throw new Error(`Advance: ${JSON.stringify(res.outcome)}`);
  await t.host.idle();
  const last = t.out.filter((m) => m.t === 'ViewUpdate').at(-1) as ViewUpdate | undefined;
  return last?.phase === 'Ended';
}

/** Хэши дней из журнала партии — то, что сравнивают тесты восстановления. */
export async function journal(env: Env, runId: string): Promise<{ day: number; hash: string }[]> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const r = env.idb.open(`run-${runId}`);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const days: { day: number; hash: string }[] = await new Promise((resolve) => {
    const r = db.transaction('days').objectStore('days').getAll();
    r.onsuccess = () => resolve(r.result);
  });
  db.close();
  return days.map((d) => ({ day: d.day, hash: d.hash }));
}

export async function readStore<T>(env: Env, dbName: string, store: string): Promise<T[]> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const r = env.idb.open(dbName);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (!db.objectStoreNames.contains(store)) {
    db.close();
    return [];
  }
  const rows: T[] = await new Promise((resolve) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
  });
  db.close();
  return rows;
}
