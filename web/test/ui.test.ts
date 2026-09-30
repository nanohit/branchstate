// Интерфейс без DOM: контракт ревизий, композиция патчей, часы анимации, машина жестов, очередь превью.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Marker, OrderKind, Preview, ViewSnapshot, ViewUpdate } from '../src/protocol.gen.ts';
import { Clock, along, moves, type Graph } from '../src/ui/clock.ts';
import { Gestures, type GestureOut } from '../src/ui/gestures.ts';
import { PreviewQueue } from '../src/ui/preview.ts';
import { ViewStore, applyUpdate, compose, fromSnapshot } from '../src/ui/store.ts';
import { advance, newEnv, newRun, tab } from './helpers.ts';

const region = (owner: string) => ({ owner, info_day: 0, own: false, war: false, disputed: false, front: 0, age: 0 });
const own = (node: string, path: string[] = [], edge?: { to: string; progress: number; days: number }): Marker => ({
  t: 'Own', asset: 'a', name: 'A', kind: 'Convoy', stance: null, free: true, busy_until: null, cargo: 0, path,
  pos: edge ? { t: 'Edge', edge: `${node}~${edge.to}`, from: node, to: edge.to, progress: edge.progress, days: edge.days } : { t: 'Node', node },
});
const foreign = (node: string, info_day: number): Marker => ({ t: 'Foreign', asset: 'f', name: 'F', owner: 'X', kind: 'Fleet', node, info_day, stance: null });

const snapshot = (markers: Record<string, Marker> = {}): ViewSnapshot => ({
  run_id: 'r', epoch: 'e', rev: 1, day: 0, date: '1914-07-23', phase: 'AtStop',
  map: { regions: { a: region('A'), b: region('B') }, markers },
  panel: { me: { t: 'Stop', v: [] } }, reports: [],
});
const update = (base: number, extra: Partial<ViewUpdate> = {}): ViewUpdate => ({
  run_id: 'r', epoch: 'e', base_rev: base, rev: base + 1, day: base, date: '1914-07-24', phase: 'Advancing',
  map_patch: { regions: [], markers: [] }, panel_patch: [], reports: [], ...extra,
});
const report = (id: string, facts = '') => ({ report_id: id, day: 1, title: 't', facts, kind: 'Arrived', actor: null, target: null, node: null, event_day: 0, channel: 'Seen', outcome: 0, template: null, weight: 1 }) as const;

test('контракт ревизий: обновление с чужим base_rev отбрасывается и ведёт к Resync', () => {
  const store = new ViewStore();
  store.snapshot(snapshot());
  assert.equal(store.update(update(5)), false);
  assert.equal(store.accepted!.rev, 1);
  assert.equal(store.pending.length, 0);
  assert.equal(store.update(update(1)), true);
  assert.equal(store.accepted!.rev, 2);
  // Показанная ревизия отстаёт от принятой, пока переход не завершён; действия недоступны.
  assert.equal(store.shown!.rev, 1);
  assert.equal(store.actionable, false);
});

test('композиция патчей сохраняет удаления и не дублирует донесения', () => {
  const a = update(1, { map_patch: { regions: [{ Upsert: ['a', region('X')] }], markers: [{ Upsert: ['m1', own('n1')] }, { Upsert: ['m2', own('n1')] }] }, panel_patch: [{ Upsert: ['stop', { t: 'Stop', v: ['Days'] }] }], reports: [report('r1', 'старое'), report('r2')] });
  const b = update(2, { map_patch: { regions: [{ Upsert: ['a', region('Y')] }], markers: [{ Remove: 'm1' }, { Upsert: ['m3', own('n2')] }] }, panel_patch: [{ Remove: 'stop' }], reports: [report('r1', 'новое')] });
  const c = compose(a, b);
  assert.deepEqual([c.base_rev, c.rev], [1, 3]);
  const base = fromSnapshot(snapshot({ m1: own('n0') }));
  const stepwise = applyUpdate(applyUpdate(base, a), b);
  const merged = applyUpdate(base, c);
  assert.deepEqual(merged, stepwise, 'композиция равна последовательному применению');
  assert.ok(!merged.markers.has('m1') && !merged.panel.has('stop'), 'удаления сохранены');
  assert.deepEqual(merged.reports.map((r) => [r.report_id, r.facts]), [['r2', ''], ['r1', 'новое']]);
});

const graph: Graph = {
  edge: (from, to) => {
    const days: Record<string, number> = { 'n1~n2': 2, 'n2~n3': 1 };
    if (days[`${from}~${to}`]) return { id: `${from}~${to}`, reversed: false, days: days[`${from}~${to}`] };
    if (days[`${to}~${from}`]) return { id: `${to}~${from}`, reversed: true, days: days[`${to}~${from}`] };
    return null;
  },
};

test('часы анимации: позиция в конце перехода дня равна позиции ядра', () => {
  const path = ['n1', 'n2', 'n3'];
  const from = fromSnapshot(snapshot({ m: own('n1', path) }));
  // Через день актив на ребре n1→n2 (2 дня) с прогрессом 1 — ровно как сообщило ядро.
  const day1 = applyUpdate(from, update(1, { map_patch: { regions: [], markers: [{ Upsert: ['m', own('n1', path, { to: 'n2', progress: 1, days: 2 })] }] } }));
  const [m1] = moves(from, day1, graph);
  assert.deepEqual(along(m1, 1), { edge: 'n1~n2', reversed: false, f: 0.5 });
  assert.deepEqual(along(m1, 0.5), { edge: 'n1~n2', reversed: false, f: 0.25 });
  // Объединённый переход на два дня вперёд: конец ребра n1→n2, затем всё ребро n2→n3; время — по дням.
  const day3 = applyUpdate(day1, update(2, { map_patch: { regions: [], markers: [{ Upsert: ['m', own('n3')] }] } }));
  const [m2] = moves(day1, day3, graph);
  assert.deepEqual(m2.legs.map((l) => [l.edge, l.f0, l.f1, l.weight]), [['n1~n2', 0.5, 1, 1], ['n2~n3', 0, 1, 1]]);
  assert.deepEqual(along(m2, 1), { edge: 'n2~n3', reversed: false, f: 1 });
  assert.deepEqual(along(m2, 0.25), { edge: 'n1~n2', reversed: false, f: 0.75 });
});

test('туман войны: чужое движение без двух соседних наблюдений не анимируется', () => {
  const from = fromSnapshot(snapshot({ f: foreign('n1', 3) }));
  const seenNext = applyUpdate(from, update(1, { map_patch: { regions: [], markers: [{ Upsert: ['f', foreign('n2', 4)] }] } }));
  assert.equal(moves(from, seenNext, graph).length, 1, 'видели в соседних узлах в соседние дни — движение по ребру');
  const stale = applyUpdate(from, update(1, { map_patch: { regions: [], markers: [{ Upsert: ['f', foreign('n2', 6)] }] } }));
  assert.equal(moves(from, stale, graph).length, 0, 'сведения не за соседний день — известно без маршрута');
  const far = applyUpdate(from, update(1, { map_patch: { regions: [], markers: [{ Upsert: ['f', foreign('n3', 4)] }] } }));
  assert.equal(moves(from, far, graph).length, 0, 'узлы не соседние — без маршрута');
});

test('часы анимации: переполнение очереди объединяет обновления; на остановке показанная ревизия равна принятой', () => {
  const store = new ViewStore();
  store.snapshot(snapshot({ m: own('n1', ['n1', 'n2']) }));
  const clock = new Clock(store, { tDay: 700, tJump: 200, maxWaiting: 2, graph, instant: () => false });
  const moving = (rev: number, progress: number) => update(rev, { map_patch: { regions: [], markers: [{ Upsert: ['m', own('n1', ['n1', 'n2'], { to: 'n2', progress, days: 2 })] }] } });

  assert.equal(store.update(moving(1, 1)), true);
  clock.accept(0);
  assert.equal(clock.current!.duration, 700);
  assert.equal(store.shown!.rev, 1, 'показанная ревизия меняется по завершении перехода');
  // Пока идёт первый переход, приходят ещё три дня: больше двух ожидающих — объединение.
  for (const rev of [2, 3, 4]) {
    store.update(update(rev, { map_patch: { regions: [{ Upsert: ['a', region(`S${rev}`)] }], markers: [] } }));
    clock.accept(100);
  }
  assert.equal(store.pending.length, 1);
  assert.equal(clock.merges, 1);
  assert.equal(clock.tick(699), true);
  clock.tick(700);
  assert.equal(store.shown!.rev, 2);
  assert.equal(clock.current!.duration, 200, 'объединённые дни проигрываются коротким скачком');
  // Остановка: текущий переход ускоряется, показанная ревизия доводится до принятой.
  store.update(update(5, { phase: 'AtStop', panel_patch: [{ Upsert: ['stop', { t: 'Stop', v: ['Days'] }] }] }));
  clock.accept(750);
  clock.tick(950);
  assert.equal(store.shown!.rev, store.accepted!.rev);
  assert.equal(store.shown!.regions.get('a')!.owner, 'S4');
  assert.equal(store.actionable, true);
  assert.equal(clock.busy, false);

  // Скрытая вкладка и prefers-reduced-motion: переходов нет, обновления применяются сразу.
  const s2 = new ViewStore();
  s2.snapshot(snapshot({ m: own('n1', ['n1', 'n2']) }));
  const still = new Clock(s2, { tDay: 700, tJump: 200, maxWaiting: 2, graph, instant: () => true });
  s2.update(moving(1, 1));
  still.accept(0);
  assert.equal(s2.shown!.rev, 2);
});

function recorder() {
  const log: string[] = [];
  const out: GestureOut = {
    tap: (x, y) => log.push(`tap ${x},${y}`),
    pan: (dx, dy) => log.push(`pan ${dx},${dy}`),
    pinch: (f, cx, cy) => log.push(`pinch ${f.toFixed(2)} ${cx},${cy}`),
    dragStart: () => log.push('dragStart'),
    drag: (x, y) => log.push(`drag ${x},${y}`),
    drop: (x, y) => log.push(`drop ${x},${y}`),
    dragCancel: () => log.push('dragCancel'),
    inertia: () => log.push('inertia'),
    stop: () => log.push('stop'),
  };
  return { g: new Gestures(out), log };
}

test('машина жестов: все переходы таблицы', () => {
  // Idle → Pressing → тап.
  let { g, log } = recorder();
  g.down(1, 10, 10, 0, false);
  assert.equal(g.state, 'Pressing');
  g.move(1, 13, 12, 50);
  assert.equal(g.state, 'Pressing', 'смещение меньше 8 px');
  g.up(1, 100);
  assert.deepEqual([g.state, log], ['Idle', ['tap 13,12']]);

  // Долгое нажатие — не тап.
  ({ g, log } = recorder());
  g.down(1, 10, 10, 0, false);
  g.up(1, 400);
  assert.deepEqual([g.state, log], ['Idle', []]);

  // Pressing → Panning → Inertia → новое касание останавливает инерцию.
  ({ g, log } = recorder());
  g.down(1, 0, 0, 0, false);
  g.move(1, 20, 0, 16);
  assert.equal(g.state, 'Panning');
  g.move(1, 40, 0, 32);
  g.up(1, 40);
  assert.deepEqual([g.state, log], ['Inertia', ['pan 20,0', 'pan 20,0', 'inertia']]);
  g.down(2, 5, 5, 60, false);
  assert.deepEqual([g.state, log.at(-1)], ['Pressing', 'stop']);
  g.up(2, 80);
  g.inertiaDone();
  assert.equal(g.state, 'Idle');

  // Движение с невыбранного актива — панорама; с выбранного своего свободного — перетаскивание.
  ({ g, log } = recorder());
  g.down(1, 0, 0, 0, true);
  g.move(1, 10, 0, 16);
  assert.deepEqual([g.state, log], ['Dragging', ['dragStart', 'drag 10,0']]);
  g.move(1, 30, 5, 32);
  g.up(1, 48);
  assert.deepEqual([g.state, log.slice(2)], ['Idle', ['drag 30,5', 'drop 30,5']]);

  // Второй палец во время перетаскивания: черновик отменён, масштабирование.
  ({ g, log } = recorder());
  g.down(1, 0, 0, 0, true);
  g.move(1, 20, 0, 16);
  g.down(2, 100, 0, 20, false);
  assert.deepEqual([g.state, log.at(-1)], ['Pinching', 'dragCancel']);
  g.move(2, 180, 0, 36);
  assert.equal(log.at(-1), 'pinch 2.00 100,0');
  // Pinching → остался один палец → Panning → отпускание.
  g.up(2, 50);
  assert.equal(g.state, 'Panning');
  g.move(1, 25, 0, 66);
  assert.equal(log.at(-1), 'pan 5,0');
  g.up(1, 300);
  assert.equal(g.state, 'Idle', 'палец стоял перед отпусканием — без инерции');

  // Pinching → ни одного пальца; Panning → второй палец → Pinching.
  ({ g, log } = recorder());
  g.down(1, 0, 0, 0, false);
  g.move(1, 20, 0, 16);
  g.down(2, 50, 0, 20, false);
  assert.equal(g.state, 'Pinching');
  g.up(1, 30);
  g.up(2, 31);
  assert.equal(g.state, 'Idle');

  // pointercancel и lostpointercapture: всегда Idle, без инерции; черновик отменён.
  for (const prepare of [(x: Gestures) => x.down(1, 0, 0, 0, false), (x: Gestures) => (x.down(1, 0, 0, 0, false), x.move(1, 30, 0, 16)), (x: Gestures) => (x.down(1, 0, 0, 0, true), x.move(1, 30, 0, 16)), (x: Gestures) => (x.down(1, 0, 0, 0, false), x.down(2, 9, 9, 1, false))]) {
    ({ g, log } = recorder());
    prepare(g);
    const dragging = g.state === 'Dragging';
    g.cancel();
    assert.equal(g.state, 'Idle');
    assert.ok(!log.includes('inertia') && !log.includes('drop'));
    assert.equal(log.includes('dragCancel'), dragging);
  }
});

test('кэш и очередь превью: новая ревизия очищает кэш, stance меняет ключ, в очереди не больше одного ожидающего', () => {
  let rev = 3;
  const sent: { reqId: number; rev: number; intents: OrderKind[] }[] = [];
  const shown: OrderKind[] = [];
  const q = new PreviewQueue({ send: (reqId, r, intents) => sent.push({ reqId, rev: r, intents }), rev: () => rev, batch: () => 'batch', show: (c) => shown.push(c) });
  const move = (to: string, stance: 'Hold' | 'Blockade' = 'Hold'): OrderKind => ({ Move: { asset: 'a', to, stance } });
  const preview = {} as Preview;

  q.request(move('n1'));
  q.request(move('n2'));
  q.request(move('n3'));
  assert.equal(sent.length, 1, 'один запрос выполняется');
  assert.equal(q.pending, 2, 'и один последний кандидат ждёт: промежуточный заменён');
  q.result(sent[0].reqId, 3, preview);
  assert.deepEqual(sent[1].intents, [move('n3')]);
  assert.deepEqual(shown, [], 'результат устаревшего кандидата не показан');
  q.result(sent[1].reqId, 3, preview);
  assert.deepEqual(shown, [move('n3')]);

  // Повтор того же кандидата — из кэша; смена stance — другой ключ.
  q.request(move('n3'));
  assert.equal(sent.length, 2);
  q.request(move('n3', 'Blockade'));
  assert.equal(sent.length, 3);
  // Ответ с устаревшим req_id и с чужой ревизией отбрасываются.
  q.result(999, 3, preview);
  q.result(sent[2].reqId, 2, preview);
  assert.equal(shown.length, 2);

  // Новая ревизия (Commit, Cancel, новый день) очищает кэш.
  rev = 4;
  q.request(move('n3'));
  assert.equal(sent.length, 4);
  assert.equal(sent[3].rev, 4);
});

test('одна ревизия на весь экран: снимок Worker и его обновления сходятся с Resync', async () => {
  const env = newEnv();
  const t = tab(env);
  const runId = await newRun(t, 'july1914');
  const store = new ViewStore();
  store.snapshot(t.view());
  const clock = new Clock(store, { tDay: 700, tJump: 200, maxWaiting: 2, graph: { edge: () => null }, instant: () => true });
  const seen = t.out.length;
  await advance(t, runId);
  for (const msg of t.out.slice(seen)) {
    const u = msg.t === 'ViewUpdate' ? msg : msg.t === 'CommandResult' ? msg.update : null;
    if (u) {
      assert.equal(store.update(u), true, 'ревизии идут подряд');
      clock.accept(0);
    }
  }
  await t.send({ t: 'Resync', have_rev: store.accepted!.rev });
  const fresh = fromSnapshot(t.view());
  assert.deepEqual(store.shown, fresh, 'накопленные патчи дают то же представление, что и свежий снимок');
  assert.equal(store.actionable, true);
  assert.ok([...store.shown!.panel.keys()].some((k) => k.startsWith('actions:')), 'на остановке действия доступны');
});
