// Автопрогон `llm`: партии через настоящий Worker-адаптер и посредника; игрок — на автопилоте.
// Печатает исходы, отказы проверки, долю fallback, T1–T3 (p95) и затраты по учёту посредника.
//   node scripts/llm-autorun.ts [сценарий] [число партий] [url посредника] [мс раздумий игрока на остановке]

import { IDBFactory } from 'fake-indexeddb';
import type { DayRecord, FromWorker, ViewSnapshot } from '../web/src/protocol.gen.ts';
import { Host } from '../web/src/worker/host.ts';
import { FakeLocks, coreFactory, manifest, pack, readStore, uuid } from '../web/test/helpers.ts';

const [scenario = 'july1914', count = '50', proxy = 'http://127.0.0.1:8787', think = '0'] = process.argv.slice(2);
const events: { name: string; value?: number }[] = [];
const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : 0);
const ledger = async () => (await fetch(`${proxy}/v1/ledger`)).json() as Promise<Record<string, number>>;

const before = await ledger();
const outcomes: Record<string, number> = {};
const sources = { Model: 0, Fallback: 0, rejected: 0 };
for (let i = 1; i <= Number(count); i++) {
  const env = { idb: new IDBFactory() };
  const out: FromWorker[] = [];
  const host = new Host({
    idb: env.idb,
    locks: new FakeLocks() as unknown as LockManager,
    // События измерений перехватываются здесь и уходят на посредника как обычно.
    fetch: (input, init) => {
      if (String(input).endsWith('/v1/events')) events.push(...JSON.parse(String(init!.body)).events);
      return fetch(input, init);
    },
    post: (m) => out.push(m),
    now: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    uuid,
    randomSeed: () => i,
    today: () => new Date().toISOString().slice(0, 10),
    loadCore: async () => coreFactory,
    loadPack: async (_m, s) => pack(s),
  });
  const rev = () => Math.max(0, ...out.flatMap((m) => (m.t === 'ViewSnapshot' || m.t === 'ViewUpdate' ? [m.rev] : m.t === 'CommandResult' && m.update ? [m.update.rev] : [])));
  const cmd = (run_id: string, body: never) => host.handle({ t: 'Command', run_id, command_id: uuid(), expected_rev: rev(), body });
  const open = (run_id: string | null) => host.handle({ t: 'Open', epoch: uuid(), run_id, manifest, proxy, steal: false });
  await open(null);
  const runId = uuid();
  await cmd(runId, { t: 'NewRun', scenario, seed: i, daily: false, mode: 'Llm' } as never);
  out.length = 0;
  await open(runId);
  for (let stops = 0; stops < 60; stops++) {
    const intents = host.autopilot();
    if (intents.length) await cmd(runId, { t: 'Commit', intents } as never);
    // Пока игрок читает, операции следующего дня уже идут: так выглядит настоящая партия.
    if (Number(think)) await new Promise((r) => setTimeout(r, Number(think)));
    await cmd(runId, { t: 'Advance', mode: 'Next' } as never);
    await host.idle();
    await host.handle({ t: 'Resync', have_rev: 0 });
    const view = out.findLast((m) => m.t === 'ViewSnapshot') as ViewSnapshot;
    const summary = view.panel.summary;
    if (view.phase === 'Ended' && summary?.t === 'Summary') {
      const key = `${summary.v.reason}${summary.v.goal === 'Open' ? '' : 'Achieved' in summary.v.goal ? ' (цель достигнута)' : ' (цель провалена)'}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      break;
    }
  }
  for (const d of await readStore<DayRecord>(env as never, `run-${runId}`, 'days')) {
    for (const s of Object.values(d.sources)) if (s === 'Model' || s === 'Fallback') sources[s]++;
    sources.rejected += Object.keys(d.rejected).length;
  }
  process.stdout.write('.');
}
const after = await ledger();
const t = (name: string) => events.filter((e) => e.name === name).map((e) => e.value ?? 0);
const decided = sources.Model + sources.Fallback;
console.log(`\n${scenario}: ${count} партий в режиме llm, раздумья игрока ${think} мс`);
console.log('  исходы:', outcomes);
console.log(`  пересмотров: ${decided}; моделью ${sources.Model}, fallback ${sources.Fallback} (${decided ? ((sources.Fallback * 100) / decided).toFixed(1) : 0}%), из них отказов проверки ${sources.rejected}`);
console.log(`  T1/T2/T3 p95, мс: ${p95(t('t1'))} / ${p95(t('t2'))} / ${p95(t('t3'))} (цели 100 / 2000 / 6000)`);
console.log(`  посредник: операций ${(after.ops ?? 0) - (before.ops ?? 0)}, кэш-хитов ${(after.cache_hits ?? 0) - (before.cache_hits ?? 0)}, затраты ${((after.rub ?? 0) - (before.rub ?? 0)).toFixed(2)} ₽`);
process.exit(0);
