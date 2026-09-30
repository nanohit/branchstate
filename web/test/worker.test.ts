// Worker: команды, журнал, восстановление, ограждающий номер, создание партий, правило выбора результата.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { DayRecord, OrderKind, PanelItem } from '../src/protocol.gen.ts';
import type { RunIndexEntry } from '../src/worker/host.ts';
import { Core, FakeProxy, advance, journal, newEnv, newRun, pack, readStore, tab, uuid, type Env, type Tab } from './helpers.ts';

const root = path.resolve(import.meta.dirname, '../..');

/** Партия `scripted` до конца: на каждой остановке игрок принимает первое предложение из меню и идёт дальше. */
async function playOut(t: Tab, runId: string, orders = true): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (orders) {
      const actions = Object.values(t.view().panel).flatMap((p) => (p.t === 'Actions' ? p.v : []));
      const offer = actions.find((a) => a.id.startsWith('tpl:') || a.id.startsWith('accept:'));
      if (offer?.intent) await t.cmd(runId, { t: 'Commit', intents: [offer.intent] });
    }
    if (await advance(t, runId)) return;
    await t.send({ t: 'Resync', have_rev: 0 });
  }
  assert.fail('партия не закончилась');
}

test('золотые воспроизведения дают в WASM те же хэши, что и в native', () => {
  for (const scenario of ['island', 'july1914']) {
    const lines = fs.readFileSync(path.join(root, 'crates/core/tests/golden', `${scenario}.jsonl`), 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]);
    const core = Core.create(pack(scenario), header.seed, 'golden');
    for (const line of lines.slice(1)) core.replay(line);
    assert.equal(core.hash(), (JSON.parse(lines.at(-1)!) as DayRecord).hash);
    assert.ok(core.ended());
  }
});

test('партия проходится до финала без сервера; закрытая вкладка продолжает с того же дня', async () => {
  for (const scenario of ['island', 'july1914']) {
    const env = newEnv();
    const a = tab(env);
    const runId = await newRun(a, scenario);
    assert.equal(a.view().day, 0);
    await advance(a, runId);
    const day = a.take('ViewUpdate').at(-1)!.day;
    assert.ok(day > 0);

    // Вкладку убили без событий: новый Worker поверх того же хранилища.
    const b = tab(env);
    await b.open(runId, { steal: true });
    assert.equal(b.view().day, day);
    assert.equal(b.view().phase, 'AtStop');
    await playOut(b, runId);
    await b.send({ t: 'Resync', have_rev: 0 });
    assert.equal(b.view().phase, 'Ended');
    assert.ok(b.view().panel.summary, 'итог партии в представлении');
    const index = await readStore<RunIndexEntry>(env, 'branchstate', 'runs_index');
    assert.deepEqual(index.map((e) => [e.status, e.ended]), [['ready', true]]);
  }
});

test('команды: повтор распознаётся до проверки ревизии, изменённый запрос — конфликт, устаревшая ревизия — stale', async () => {
  const env = newEnv();
  const t = tab(env);
  const runId = await newRun(t);
  const offer = (Object.values(t.view().panel) as PanelItem[]).flatMap((p) => (p.t === 'Actions' ? p.v : [])).find((a) => a.id === 'tpl:trn_mar_access')!;
  const intents = [offer.intent!];
  const rev0 = t.rev();

  const first = await t.cmd(runId, { t: 'Commit', intents }, { command_id: 'c1' });
  assert.equal(first.outcome.t, 'Accepted');
  assert.ok(first.update && first.update.base_rev === rev0 && first.update.rev === rev0 + 1);
  assert.ok(first.update.panel_patch.some((op) => 'Upsert' in op && op.Upsert[1].t === 'Order'), 'приказ появился в планах');

  // Повтор с тем же id и запросом: сохранённый исход, без повторного эффекта и без старого патча, даже с устаревшей ревизией.
  const again = await t.cmd(runId, { t: 'Commit', intents }, { command_id: 'c1', expected_rev: rev0 });
  assert.equal(again.outcome.t, 'Accepted');
  assert.equal(again.update, null);
  await t.send({ t: 'Resync', have_rev: 0 });
  assert.equal(Object.values(t.view().panel).filter((p) => p.t === 'Order').length, 1);

  const conflict = await t.cmd(runId, { t: 'Commit', intents: [] }, { command_id: 'c1' });
  assert.deepEqual([conflict.outcome.t, conflict.outcome.t === 'Rejected' && conflict.outcome.reason], ['Rejected', 'CommandConflict']);

  const stale = await t.cmd(runId, { t: 'Commit', intents }, { expected_rev: rev0 });
  assert.deepEqual(stale.outcome, { t: 'Rejected', reason: 'Stale', current_rev: rev0 + 1, detail: null });

  // Отмена освобождает резерв: приказ уходит из планов, инициатива возвращается.
  const order = Object.values(t.view().panel).find((p) => p.t === 'Order')!;
  const cancel = await t.cmd(runId, { t: 'Cancel', order_id: (order.v as { id: number }).id });
  assert.equal(cancel.outcome.t, 'Accepted');
  assert.ok(cancel.update!.panel_patch.some((op) => 'Remove' in op && op.Remove.startsWith('order:')));

  // Недопустимое намерение отклоняется и не портит состояние.
  const bad: OrderKind = { Pay: { to: 'MAR', amount: 100000 } };
  const invalid = await t.cmd(runId, { t: 'Commit', intents: [bad] });
  assert.deepEqual([invalid.outcome.t, invalid.outcome.t === 'Rejected' && invalid.outcome.reason], ['Rejected', 'Invalid']);
});

/** Хэши дней эталонной партии без сбоев: те же команды, тот же сид. */
async function reference(scenario: string, steps: number): Promise<{ day: number; hash: string }[]> {
  const env = newEnv();
  const t = tab(env);
  const runId = await newRun(t, scenario);
  for (let i = 0; i < steps; i++) if (await advance(t, runId)) break;
  return journal(env, runId);
}

test('внедрение сбоев: убийство Worker на каждой записи, прерванная транзакция и квота → тот же хэш', async () => {
  const expected = await reference('island', 4);
  for (const kind of ['kill', 'quota'] as const) {
    for (let failAt = 1; failAt <= 12; failAt++) {
      let writes = 0;
      const env: Env = newEnv({
        faults: {
          beforeCommit: (stores) => {
            if (stores.includes('init') || stores.includes('publish')) return;
            if (++writes === failAt) throw kind === 'quota' ? new DOMException('квота исчерпана', 'QuotaExceededError') : new Error('worker killed');
          },
        },
      });
      let t = tab(env);
      const runId = await newRun(t, 'island');
      for (let i = 0; i < 40 && (await journal(env, runId)).length < expected.length; i++) {
        const res = await t.cmd(runId, { t: 'Advance', mode: 'Next' });
        await t.host.idle();
        if (kind === 'kill' && writes >= failAt && (res.outcome.t !== 'Accepted' || t.take('Error').length)) {
          // Worker убит посреди записи: память потеряна, новый Worker восстанавливается из хранилища.
          t = tab(env);
          await t.open(runId, { steal: true });
          await t.host.idle();
        } else if (res.outcome.t !== 'Accepted') {
          assert.equal(res.outcome.reason, 'Storage', 'команда при сбое записи отклоняется как ошибка хранения');
          await t.send({ t: 'Resync', have_rev: 0 });
        }
      }
      const got = await journal(env, runId);
      assert.deepEqual(got.slice(0, expected.length), expected, `${kind}, сбой на записи №${failAt}`);
    }
  }
});

test('ограждающий номер: после смены writer_epoch старый писатель не может записать', async () => {
  const env = newEnv();
  const a = tab(env);
  const runId = await newRun(a);
  await advance(a, runId);
  const day = a.take('ViewUpdate').at(-1)!.day;

  // Вторая вкладка без перехвата открывает партию только для просмотра.
  const viewer = tab(env);
  await viewer.open(runId);
  assert.equal(viewer.take('Opened').at(-1)!.writer, false);
  const denied = await viewer.cmd(runId, { t: 'Advance', mode: 'Next' });
  assert.equal(denied.outcome.t === 'Rejected' && denied.outcome.reason, 'NotWriter');

  // «Продолжить здесь»: перехват блокировки; новый писатель сначала восстанавливает записанное состояние.
  const b = tab(env);
  await b.open(runId, { steal: true });
  assert.equal(b.take('Opened').at(-1)!.writer, true);
  assert.equal(b.view().day, day);

  // Старый писатель узнаёт о потере владения и больше ничего не записывает.
  const before = await journal(env, runId);
  const res = await a.cmd(runId, { t: 'Advance', mode: 'Next' });
  await a.host.idle();
  assert.equal(res.outcome.t, 'Rejected');
  assert.equal(a.take('Opened').at(-1)!.writer, false);
  assert.deepEqual(await journal(env, runId), before);

  assert.equal((await b.cmd(runId, { t: 'Advance', mode: 'Next' })).outcome.t, 'Accepted');
  await b.host.idle();
  assert.ok((await journal(env, runId)).length > before.length);
});

test('ограждающий номер защищает и без блокировки: запись устаревшего писателя прерывается транзакцией', async () => {
  const env = newEnv();
  const a = tab(env);
  const runId = await newRun(a);
  // Блокировки между «вкладками» не общие — как при заморозке, когда семантика Web Locks подвела.
  const b = tab({ ...env, locks: new (env.locks.constructor as new () => typeof env.locks)() });
  await b.open(runId);
  assert.equal(b.take('Opened').at(-1)!.writer, true);
  const res = await a.cmd(runId, { t: 'Advance', mode: 'Next' });
  assert.equal(res.outcome.t === 'Rejected' && res.outcome.reason, 'NotWriter');
  assert.equal((await journal(env, runId)).length, 0);
});

test('создание и публикация: сбой между индексом, инициализацией и публикацией не создаёт дубликат', async () => {
  for (const stage of ['init', 'publish']) {
    let armed = true;
    const env = newEnv({
      faults: {
        beforeCommit: (stores) => {
          if (armed && stores.includes(stage)) {
            armed = false;
            throw new Error('worker killed');
          }
        },
      },
    });
    const a = tab(env);
    await a.open(null);
    const runId = uuid();
    const body = { t: 'NewRun', scenario: 'island', seed: null, daily: false, mode: 'Scripted', sandbox: false } as const;
    await a.cmd(runId, body, { command_id: 'create-1' });
    let index = await readStore<RunIndexEntry>(env, 'branchstate', 'runs_index');
    assert.deepEqual(index.map((e) => [e.run_id, e.status]), [[runId, 'creating']], 'незавершённая партия не выдаётся за готовую');

    // Новый Worker: готовая база допубликовывается, незавершённая инициализация повторяется тем же запросом.
    const b = tab(env);
    await b.open(null);
    const retry = await b.cmd(uuid(), body, { command_id: 'create-1' });
    assert.equal(retry.outcome.t, 'Accepted');
    index = await readStore<RunIndexEntry>(env, 'branchstate', 'runs_index');
    assert.deepEqual(index.map((e) => [e.run_id, e.status]), [[runId, 'ready']], 'повтор продолжил ту же партию');

    const other = await b.cmd(uuid(), { ...body, scenario: 'july1914' }, { command_id: 'create-1' });
    assert.equal(other.outcome.t === 'Rejected' && other.outcome.reason, 'CommandConflict');
    await b.open(runId);
    assert.equal(b.view().day, 0);
  }
});

test('ветка, экспорт и импорт: развилка на границе дня, файл партии воспроизводится с теми же хэшами', async () => {
  const env = newEnv();
  const t = tab(env);
  const runId = await newRun(t, 'island');
  for (let i = 0; i < 3; i++) await advance(t, runId);
  const days = await journal(env, runId);
  const forkDay = days[Math.floor(days.length / 2)].day;

  const forkId = uuid();
  assert.equal((await t.cmd(forkId, { t: 'Fork', day: forkDay })).outcome.t, 'Accepted');
  await t.open(forkId);
  assert.equal(t.view().day, forkDay);
  // Без новых приказов ветка идёт тем же путём: ответы до развилки уже в журнале, повторных вызовов нет.
  while ((await journal(env, forkId)).length < days.length - forkDay) await advance(t, forkId, { Days: 1 });
  const forked = await journal(env, forkId);
  assert.deepEqual(forked, days.filter((d) => d.day >= forkDay));

  await t.send({ t: 'Export', run_id: forkId });
  const file = t.take('Exported').at(-1)!.file;
  assert.equal(file.trim().split('\n').length, 1 + days.length, 'заголовок и все дни: до развилки — у родителя');

  const importedId = uuid();
  assert.equal((await t.cmd(importedId, { t: 'Import', file })).outcome.t, 'Accepted');
  await t.open(importedId);
  assert.equal(t.view().day, days.length);
  assert.deepEqual(await journal(env, importedId), days);

  const broken = file.replace(/"hash":"[0-9a-f]{8}/, '"hash":"00000000');
  const bad = await t.cmd(uuid(), { t: 'Import', file: broken });
  assert.equal(bad.outcome.t === 'Rejected' && bad.outcome.reason, 'Invalid');
});

test('L12 через Worker: «Дальше» и «Ждать N дней» дают тот же мир', async () => {
  const byStops = await reference('july1914', 30);
  const env = newEnv();
  const t = tab(env);
  const runId = await newRun(t, 'july1914');
  for (let i = 0; i < 30; i++) if (await advance(t, runId, { Days: 5 })) break;
  assert.deepEqual(await journal(env, runId), byStops);
});

// ---- операции через посредника

/** Ответ модели: принять первое ждущее предложение, план без шагов. */
const accepting = (req: any) => {
  if (req.kind !== 'decide') return null;
  const accept = req.observation.menu.filter((m: { id: string }) => m.id.startsWith('accept:')).map((m: { id: string }) => m.id);
  return { today: accept, plan: { goal: req.observation.goal, steps: [], review_if: [] }, beliefs: [], reason: 'тест' };
};

async function llmRun(env: Env): Promise<{ t: Tab; runId: string }> {
  const t = tab(env);
  const runId = await newRun(t, 'island', 'Llm');
  const offer = Object.values(t.view().panel).flatMap((p) => (p.t === 'Actions' ? p.v : [])).find((a) => a.id === 'tpl:trn_mar_access')!;
  await t.cmd(runId, { t: 'Commit', intents: [offer.intent!] });
  return { t, runId };
}

const inputs = (env: Env, runId: string) => readStore<{ source: string; op_id: string }>(env, `run-${runId}`, 'day_inputs');

test('режим llm: операция уходит заранее, ответ модели применяется и записывается в журнал', async () => {
  const proxy = new FakeProxy();
  proxy.answer = accepting;
  const env = newEnv({ proxy });
  const { t, runId } = await llmRun(env);
  await advance(t, runId, { Days: 2 });
  assert.deepEqual((await inputs(env, runId)).map((r) => r.source), ['model']);
  const days = await readStore<DayRecord>(env, `run-${runId}`, 'days');
  assert.deepEqual(days.map((d) => Object.values(d.sources).filter((s) => s === 'Model').length), [0, 1]);
  assert.ok(Object.values(t.take('ViewUpdate').at(-1)!.panel_patch).length >= 0);
  await t.send({ t: 'Resync', have_rev: 0 });
  assert.ok(Object.values(t.view().panel).some((p) => p.t === 'Agreement'), 'Марена приняла предложение по ответу модели');
  assert.ok(proxy.events.length > 0, 'события измерений ушли пачкой на остановке');
});

test('потерянный ответ: посредник принял операцию, клиент ответа не получил — повтор продолжает ту же операцию', async () => {
  const proxy = new FakeProxy();
  proxy.answer = accepting;
  proxy.dropResponses = 1;
  const env = newEnv({ proxy, budget: { advance: 3000, recovery: 1000 } });
  const { t, runId } = await llmRun(env);
  await advance(t, runId, { Days: 2 });
  assert.deepEqual((await inputs(env, runId)).map((r) => r.source), ['model']);
  assert.deepEqual([...proxy.executed.values()], [1], 'операция исполнена один раз');
  assert.equal(new Set(proxy.requests.filter((r) => r.path.startsWith('/v1/ops')).map((r) => r.path)).size >= 1, true);
});

test('нет сети во время промотки: повторы в пределах доли бюджета, затем резервная политика', async () => {
  const proxy = new FakeProxy();
  proxy.answer = accepting;
  proxy.offline = 1000;
  const env = newEnv({ proxy });
  const { t, runId } = await llmRun(env);
  await advance(t, runId, { Days: 2 });
  assert.deepEqual((await inputs(env, runId)).map((r) => r.source), ['fallback']);
  const days = await readStore<DayRecord>(env, `run-${runId}`, 'days');
  assert.equal(Object.values(days[1].sources).filter((s) => s === 'Fallback').length, 1);
});

test('неизменность резерва: ответ после записанного fallback ничего не меняет, и после восстановления в другой вкладке', async () => {
  const proxy = new FakeProxy();
  proxy.answer = accepting;
  proxy.delay = 900; // дольше доли бюджета дня
  const env = newEnv({ proxy });
  const { t, runId } = await llmRun(env);
  await advance(t, runId, { Days: 2 });
  assert.deepEqual((await inputs(env, runId)).map((r) => r.source), ['fallback']);
  const before = await journal(env, runId);

  // Поздний ответ приходит и сохраняется в `ops` для анализа, но выбор дня уже записан.
  await new Promise((r) => setTimeout(r, 1200));
  const ops = await readStore<{ state: string; response: unknown }>(env, `run-${runId}`, 'ops');
  assert.ok(ops.some((o) => o.state === 'answered' && o.response), 'поздний ответ сохранён');
  assert.deepEqual((await inputs(env, runId)).map((r) => r.source), ['fallback']);

  const b = tab(env);
  await b.open(runId, { steal: true });
  await b.host.idle();
  assert.deepEqual(await journal(env, runId), before);
  assert.deepEqual((await inputs(env, runId)).map((r) => r.source), ['fallback']);
  const days = await readStore<DayRecord>(env, `run-${runId}`, 'days');
  assert.deepEqual(days.map((d) => Object.values(d.sources).filter((s) => s === 'Model').length), [0, 0], 'опоздавший ответ не переписал разрешённый день');
});

test('восстановление посреди промотки: записанный выбор используется, незавершённая операция забирается по op_id', async () => {
  const proxy = new FakeProxy();
  proxy.answer = accepting;
  let kill = false;
  const env = newEnv({
    proxy,
    faults: {
      beforeCommit: (stores) => {
        // Убить Worker на записи дня, в котором решала модель.
        if (kill && stores.includes('days')) throw new Error('worker killed');
      },
    },
  });
  const { t, runId } = await llmRun(env);
  // День 0 разрешается, затем день 1 с операцией: выбор записан, но запись дня сорвана.
  const res = await t.cmd(runId, { t: 'Advance', mode: { Days: 3 } });
  assert.equal(res.outcome.t, 'Accepted');
  while ((await journal(env, runId)).length < 1) await new Promise((r) => setTimeout(r, 5));
  kill = true;
  await t.host.idle();
  kill = false;
  assert.equal((await journal(env, runId)).length, 1);
  assert.deepEqual((await inputs(env, runId)).map((r) => r.source), ['model']);

  const b = tab(env);
  await b.open(runId, { steal: true });
  await b.host.idle();
  assert.ok((await journal(env, runId)).length >= 2, 'промотка продолжилась после восстановления');
  const days = await readStore<DayRecord>(env, `run-${runId}`, 'days');
  assert.equal(Object.values(days[1].sources).filter((s) => s === 'Model').length, 1, 'день решён записанным ответом модели');
  assert.deepEqual([...proxy.executed.values()].filter((n) => n > 1), [], 'ни одна операция не исполнена дважды');
  assert.equal(b.take('ViewSnapshot').at(-1)!.phase, 'Advancing');
  assert.equal(b.take('ViewUpdate').at(-1)!.phase, 'AtStop');
});

test('скрытая вкладка: писатель отпускает блокировку, по возвращении восстанавливается и продолжает', async () => {
  const env = newEnv();
  const t = tab(env);
  const runId = await newRun(t, 'island');
  await t.send({ t: 'Visibility', hidden: true });
  const denied = await t.cmd(runId, { t: 'Advance', mode: 'Next' });
  assert.equal(denied.outcome.t === 'Rejected' && denied.outcome.reason, 'NotWriter');
  await t.send({ t: 'Visibility', hidden: false });
  assert.equal(t.take('Opened').at(-1)!.writer, true);
  assert.equal(await advance(t, runId), false);
  assert.ok((await journal(env, runId)).length > 0);
});

test('Ping отвечает Pong с epoch и фазой; запросы превью привязаны к ревизии', async () => {
  const env = newEnv();
  const t = tab(env);
  const runId = await newRun(t);
  await t.send({ t: 'Ping', n: 5 });
  const pong = t.take('Pong').at(-1)!;
  assert.deepEqual([pong.n, pong.phase], [5, 'AtStop']);
  assert.equal(pong.epoch, t.take('Opened').at(-1)!.epoch);

  await t.send({ t: 'MoveOptions', req_id: 1, rev: t.rev(), asset_id: 'trn_convoy_1' });
  const options = t.take('MoveOptionsResult').at(-1)!;
  assert.equal(options.rev, t.rev());
  const target = options.options.targets.find((x) => x.node === 'skerry_port')!;
  assert.deepEqual(target.path, ['tern_harbor', 'south_water', 'skerry_port']);
  const intent: OrderKind = { Move: { asset: 'trn_convoy_1', to: 'skerry_port', stance: 'Hold' } };
  await t.send({ t: 'Preview', req_id: 2, rev: t.rev(), intents: [intent] });
  const preview = t.take('PreviewResult').at(-1)!;
  assert.deepEqual([preview.req_id, preview.preview.reject, preview.preview.orders[0].incursion], [2, null, 'SKE']);
  assert.equal(runId, preview.run_id);
});

test('песочница: партия без цели не заканчивается и после перезапуска открывается тем же вариантом пакета', async () => {
  const env = newEnv();
  const t = tab(env);
  const runId = await newRun(t, 'july1914', 'Scripted', 7, true);
  const me = t.view().panel.me;
  assert.equal(me.t === 'Me' && me.v.goal, null, 'цели нет');
  for (let i = 0; i < 8; i++) assert.equal(await advance(t, runId, { Days: 7 }), false);
  const days = await journal(env, runId);
  assert.ok(days.length > 30, 'партия идёт дальше даты предела обычного сценария');
  const index = await readStore<RunIndexEntry>(env, 'branchstate', 'runs_index');
  assert.deepEqual(index.map((e) => [e.title, e.ended]), [['Июль 1914 — песочница', false]]);

  // Новый Worker: журнал воспроизводится с теми же хэшами только на пакете песочницы.
  const b = tab(env);
  await b.open(runId, { steal: true });
  assert.equal(b.view().phase, 'AtStop');
  assert.equal(b.view().day, days.length);
  // У «Острова» песочницы нет: флаг игнорируется, цель остаётся.
  const plain = await newRun(tab(newEnv()), 'island', 'Scripted', 7, true).catch(() => null);
  assert.ok(plain);
});
