// UI-бандл комплекта. Интерфейс не считает игру: он показывает представление показанной ревизии
// и отправляет намерения в Worker.

import { effect, signal } from '@preact/signals-core';
import type { Command, CommandBody, FromWorker, MoveOptions, OrderKind, Outcome, RegionView, RuntimeManifest, Stance, ToWorker, ViewUpdate } from './protocol.gen.ts';
import { Clock } from './ui/clock.ts';
import { Geo, type GeoMeta } from './ui/geo.ts';
import { MapView, type Hit } from './ui/mapview.ts';
import { PreviewQueue } from './ui/preview.ts';
import type { Route } from './ui/renderer.ts';
import { type Draft, type RunInfo, type Sel, type SheetCtx, type TabId, dateRu, findAction, runTab, sheetBody, tabs, topBar } from './ui/sheet.ts';
import { ViewStore } from './ui/store.ts';
import { STYLE } from './ui/style.ts';
import { MAX_WAITING, T_DAY_MS, T_JUMP_MS, palette } from './ui/theme.ts';

declare global {
  interface Window {
    __BS: { manifest: RuntimeManifest; run: string | null; proxy: string };
  }
}

const { manifest, run: wantedRun, proxy } = window.__BS;
const $ = (html: string) => Object.assign(document.createElement('template'), { innerHTML: html }).content.firstElementChild as HTMLElement;
document.head.append($(`<style>${STYLE}</style>`));
const el = {
  map: $('<div id="map"></div>'),
  top: $('<div id="top"></div>'),
  sheet: $('<div id="sheet"><div class="grip" data-a="grip"></div><div class="body"></div><div class="tabs"></div></div>'),
  toast: $('<div id="toast"></div>'),
};
document.body.append(el.map, el.top, el.sheet, el.toast);
const body = el.sheet.querySelector('.body') as HTMLElement;
const tabBar = el.sheet.querySelector('.tabs') as HTMLElement;

let toastTimer = 0;
function toast(text: string) {
  el.toast.textContent = text;
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.remove('on'), 4000);
}

/** Оболочка в главном потоке может читать только общий `runs_index`. */
function readRuns(): Promise<RunInfo[]> {
  return new Promise((resolve) => {
    const r = indexedDB.open('branchstate', 1);
    r.onupgradeneeded = () => ['runs_index', 'settings'].forEach((s) => r.result.createObjectStore(s));
    r.onerror = () => resolve([]);
    r.onsuccess = () => {
      const q = r.result.transaction('runs_index').objectStore('runs_index').getAll();
      q.onsuccess = () => (r.result.close(), resolve(q.result));
      q.onerror = () => resolve([]);
    };
  });
}

// ---- соединение с Worker

const store = new ViewStore();
const state = {
  tab: signal<TabId>('turn'),
  sel: signal<Sel>(null),
  draft: signal<Draft>(null),
  saving: signal(false),
  options: signal<MoveOptions | null>(null),
  waiting: signal(0),
  writer: signal(true),
  open: signal(false),
  opened: signal(new Map<string, string | null>()),
  runs: signal<RunInfo[]>([]),
};

let worker: Worker | null = null;
let epoch = '';
let runId: string | null = null;
let alive = 0;
let pingN = 0;
let pongN = 0;
const pending = new Map<string, (o: Outcome) => void>();
let onMessage: (msg: FromWorker) => void = () => {};

/** Новый Worker с новым `epoch`: запуск, восстановление, переключение партии. */
function connect(steal = false) {
  worker?.terminate();
  for (const reject of pending.values()) reject({ t: 'Rejected', reason: 'Busy', current_rev: null, detail: 'соединение с Worker перезапущено' });
  pending.clear();
  epoch = crypto.randomUUID();
  alive = 0;
  // Worker принимает только скрипт своего источника: шим получает URL ядра комплекта параметром.
  worker = new Worker(`/worker.js?core=${encodeURIComponent(manifest.core.url)}`, { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    // Сообщение с чужим `run_id` или `epoch` интерфейс отбрасывает.
    if ('epoch' in msg && msg.epoch && msg.epoch !== epoch) return;
    if ('run_id' in msg && msg.run_id && runId && msg.run_id !== runId && msg.t !== 'CommandResult' && msg.t !== 'Exported') return;
    alive = performance.now();
    onMessage(msg);
  };
  worker.onerror = worker.onmessageerror = () => connect();
  send({ t: 'Open', epoch, run_id: runId, manifest, proxy: proxy || null, steal });
  if (document.hidden) send({ t: 'Visibility', hidden: true });
}

const send = (msg: ToWorker) => worker?.postMessage(msg);

function command(body: CommandBody, target = runId ?? ''): Promise<Outcome> {
  const cmd: Command = { run_id: target, command_id: crypto.randomUUID(), expected_rev: store.accepted?.rev ?? 0, body };
  return new Promise((resolve) => {
    pending.set(cmd.command_id, resolve);
    send({ t: 'Command', ...cmd });
  });
}

/** Живость Worker: нет `Pong` за 2 с — Worker завершается, запускается новый, дальше путь восстановления. */
function ping() {
  if (!alive || document.hidden) return;
  const n = ++pingN;
  send({ t: 'Ping', n });
  setTimeout(() => {
    if (pongN < n && pingN === n && !document.hidden) connect();
  }, 2000);
}
setInterval(ping, 5000);
addEventListener('pageshow', ping);
document.addEventListener('visibilitychange', () => {
  send({ t: 'Visibility', hidden: document.hidden });
  if (!document.hidden) ping();
});

function switchRun(id: string) {
  localStorage.setItem('bs.run', id);
  // Переход к другой партии — полная перезагрузка: двух комплектов на одной странице не бывает.
  location.href = `?run=${encodeURIComponent(id)}`;
}

async function create(body: CommandBody) {
  const id = crypto.randomUUID();
  const out = await command(body, id);
  if (out.t === 'Accepted') switchRun(id);
  else toast(`Не получилось: ${out.detail ?? out.reason}`);
}

const scenarios = Object.entries(manifest.scenarios).map(([id, s]) => [id, s.title] as [string, string]);

// ---- запуск

async function start() {
  const runs = await readRuns();
  state.runs.value = runs;
  const entry = runs.find((r) => r.run_id === wantedRun && r.status === 'ready') as (RunInfo & { scenario: string }) | undefined;
  runId = entry?.run_id ?? null;
  connect();
  if (!entry) return startScreen();

  const files = manifest.scenarios[entry.scenario];
  const get = (f: { url: string; sri: string }) => fetch(f.url, { integrity: f.sri });
  const [meta, bin, pack] = await Promise.all([get(files.geo_json).then((r) => r.json() as Promise<GeoMeta>), get(files.geo_bin).then((r) => r.arrayBuffer()), get(files.pack).then((r) => r.json())]);
  const geo = new Geo(meta, bin);
  const stateIdx = new Map<string, number>(pack.states.map((s: { id: string }, i: number) => [s.id, i]));
  const names = {
    state: (id: string) => pack.states[stateIdx.get(id) ?? -1]?.name ?? id,
    node: (id: string) => geo.nodes.get(id)?.name ?? id,
    asset: (id: string) => pack.assets.find((a: { id: string }) => a.id === id)?.name ?? id,
  };
  const player = stateIdx.get(pack.player)!;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const clock = new Clock(store, { tDay: T_DAY_MS, tJump: T_JUMP_MS, maxWaiting: MAX_WAITING, graph: geo, instant: () => document.hidden || reduced.matches });

  // Карта видна до ответа Worker: публичная статика пакета — владельцы регионов на старте.
  const initial = new Map<string, RegionView>(pack.regions.map((r: { id: string; owner: string }) => [r.id, { owner: r.owner, info_day: 0, own: r.owner === pack.player, war: false, disputed: false, front: 0, age: 0 }]));
  const shownRegions = () => store.shown?.regions ?? initial;

  const selectedMarker = () => (state.sel.value?.t === 'marker' ? store.shown?.markers.get(state.sel.value.key) : undefined);
  const draftPath = (): string[] => state.draft.value?.preview?.orders[0]?.edges ?? [];
  let snap: string | null = null;

  const map = new MapView(el.map, geo, store, clock, palette(pack.states.length, player), {
    ownerIndex: (id) => (id === null ? player : (stateIdx.get(id) ?? 255)),
    player: () => player,
    selected: () => {
      const s = state.sel.value;
      const region = s?.t === 'state' ? ([...shownRegions()].find(([, r]) => r.owner === s.id)?.[0] ?? null) : null;
      return { marker: s?.t === 'marker' ? s.key : null, region };
    },
    routes: () => {
      const out: Route[] = [];
      const edges = (path: string[]) => path.slice(1).map((n, i) => geo.edge(path[i], n)?.id).filter(Boolean) as string[];
      for (const p of store.shown?.panel.values() ?? []) if (p.t === 'Order' && p.v.path.length) for (const e of edges(p.v.path)) out.push({ edge: e, color: [0.71, 0.33, 0.18, p.v.staged ? 0.75 : 0.5], half: 1.4, dash: p.v.staged ? 12 : 0 });
      const target = snap ?? ('Move' in (state.draft.value?.candidate ?? {}) ? (state.draft.value!.candidate as { Move: { to: string } }).Move.to : null);
      // Призрак пути — только когда получены move_options показанной ревизии.
      const ghost = draftPath().length ? draftPath() : (state.options.value?.targets.find((t) => t.node === target)?.edges ?? []);
      for (const e of ghost) out.push({ edge: e, color: [0.71, 0.33, 0.18, 0.95], half: 2, dash: 0 });
      return out;
    },
    draggable: (key) => state.sel.value?.t === 'marker' && state.sel.value.key === key && !!state.options.value && store.actionable && state.writer.value,
    tap,
    dragOver: (x, y) => (snap = map.snapTarget(x, y, state.options.value?.targets.map((t) => t.node) ?? [])),
    drop: (node) => {
      snap = null;
      const m = selectedMarker();
      if (node && m?.t === 'Own') moveDraft(m.asset, node);
    },
    dragCancel: () => (snap = null),
    metric: (name, value) => send({ t: 'Metric', name, value: Math.round(value) }),
  });

  const saved = JSON.parse(sessionStorage.getItem('bs.cam') ?? 'null');
  const capital = geo.nodes.get(pack.states[player].capital);
  map.cam.resize(el.map.clientWidth, el.map.clientHeight, 120);
  if (saved) map.cam.centerOn(saved[0], saved[1], saved[2]);
  else if (capital) map.cam.centerOn(capital.x, capital.y, Math.max(map.cam.minScale, el.map.clientWidth / 1500));
  map.invalidate();
  // Три момента готовности: карта видна → карту можно двигать → можно отдать приказ.
  requestAnimationFrame(() => (performance.mark('bs:map_visible'), performance.mark('bs:map_movable')));

  // ---- превью и приказы

  const batch = () => JSON.stringify([...(store.shown?.panel ?? [])].filter(([, p]) => p.t === 'Order' && p.v.staged).map(([k]) => k));
  let previewAt = 0;
  const previews = new PreviewQueue({
    send: (req_id, rev, intents) => send({ t: 'Preview', req_id, rev, intents }),
    rev: () => store.shown?.rev ?? -1,
    batch,
    show: (candidate, preview) => {
      const d = state.draft.value;
      if (!d || JSON.stringify(d.candidate) !== JSON.stringify(candidate)) return;
      state.draft.value = { ...d, preview };
      // Проверенное превью: от смены кандидата до первого кадра с действительным результатом.
      requestAnimationFrame(() => send({ t: 'Metric', name: 'preview_ms', value: Math.round(performance.now() - previewAt) }));
    },
  });

  function startDraft(candidate: OrderKind, stances: Stance[]) {
    previewAt = performance.now();
    state.draft.value = { candidate, preview: null, stances };
    state.open.value = true;
    previews.request(candidate);
    map.invalidate();
  }

  function moveDraft(asset: string, to: string) {
    const t = state.options.value?.targets.find((x) => x.node === to);
    if (t) startDraft({ Move: { asset, to, stance: 'Hold' } }, t.stances);
  }

  function discard() {
    previews.clear();
    state.draft.value = null;
    map.invalidate();
  }

  let optionsReq = 0;
  function requestOptions() {
    const m = selectedMarker();
    state.options.value = null;
    map.setTargets(new Set());
    if (m?.t === 'Own' && m.free && store.actionable) send({ t: 'MoveOptions', req_id: ++optionsReq, rev: store.shown!.rev, asset_id: m.asset });
  }

  function select(sel: Sel) {
    discard();
    state.sel.value = sel;
    if (sel) state.open.value = true;
    requestOptions();
    map.invalidate();
  }

  function tap(hit: Hit) {
    const m = selectedMarker();
    if (hit?.kind === 'node' && m?.t === 'Own' && state.options.value?.targets.some((t) => t.node === hit.id)) return moveDraft(m.asset, hit.id);
    if (hit?.kind === 'marker') return select(state.sel.value?.t === 'marker' && state.sel.value.key === hit.key ? null : { t: 'marker', key: hit.key });
    if (hit?.kind === 'node') return select({ t: 'node', id: hit.id });
    const owner = hit ? shownRegions().get(hit.id)?.owner : null;
    select(owner ? { t: 'state', id: owner } : null);
  }

  let advanceAt = 0;
  let sawDay = false;
  async function act(a: string, target: HTMLElement) {
    const [kind, ...rest] = a.split(':');
    const arg = rest.join(':');
    const shown = store.shown;
    switch (kind) {
      case 'grip':
        state.open.value = !state.open.value;
        break;
      case 'tab':
        discard();
        state.sel.value = null;
        map.setTargets(new Set());
        state.tab.value = arg as TabId;
        state.open.value = true;
        if (arg === 'run') state.runs.value = await readRuns();
        break;
      case 'desel':
        select(null);
        break;
      case 'sel':
        select({ t: 'state', id: rest[1] });
        break;
      case 'act': {
        const action = shown && findAction(shown, arg);
        if (action?.intent) startDraft(action.intent, []);
        break;
      }
      case 'stance': {
        const d = state.draft.value;
        if (d && 'Move' in d.candidate) startDraft({ Move: { ...d.candidate.Move, stance: arg as Stance } }, d.stances);
        break;
      }
      case 'discard':
        discard();
        break;
      case 'commit': {
        const d = state.draft.value;
        // Кнопка сразу в состоянии «сохраняется»; повторное нажатие не создаёт новой команды.
        if (!d || state.saving.value) break;
        state.saving.value = true;
        const out = await command({ t: 'Commit', intents: [d.candidate] });
        state.saving.value = false;
        if (out.t === 'Accepted') {
          state.draft.value = null;
          state.sel.value = null;
          map.setTargets(new Set());
        } else toast(`Приказ не принят: ${out.detail ?? out.reason}`);
        break;
      }
      case 'cancel': {
        const out = await command({ t: 'Cancel', order_id: Number(arg) });
        if (out.t !== 'Accepted') toast(`Отмена не принята: ${out.detail ?? out.reason}`);
        break;
      }
      case 'adv': {
        select(null);
        state.tab.value = 'turn';
        advanceAt = performance.now();
        sawDay = false;
        const out = await command({ t: 'Advance', mode: arg === 'Next' ? 'Next' : { Days: Number(arg) } });
        send({ t: 'Metric', name: 't1_ui', value: Math.round(performance.now() - advanceAt) });
        if (out.t !== 'Accepted') toast(`Промотка не началась: ${out.detail ?? out.reason}`);
        break;
      }
      case 'report': {
        const opened = new Map(state.opened.value);
        if (opened.has(arg)) opened.delete(arg);
        else opened.set(arg, store.texts.get(arg) ?? null);
        state.opened.value = opened;
        break;
      }
      case 'fork':
        await create({ t: 'Fork', day: Number(arg) });
        break;
      case 'new':
        await create({ t: 'NewRun', scenario: rest[0], seed: null, daily: rest[2] === 'daily', mode: rest[1] as 'Scripted' | 'Llm' });
        break;
      case 'open':
        switchRun(arg);
        break;
      case 'export':
        send({ t: 'Export', run_id: runId! });
        break;
      case 'steal':
        connect(true);
        break;
      case 'import':
        (target as HTMLInputElement).files?.[0]?.text().then((file) => create({ t: 'Import', file }));
        break;
    }
  }
  const delegate = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (t && (e.type === 'change') === (t.dataset.a === 'import')) void act(t.dataset.a!, t);
  };
  el.sheet.addEventListener('click', delegate);
  el.sheet.addEventListener('change', delegate);

  // ---- сообщения Worker

  const accept = (u: ViewUpdate) => {
    // Обновление с чужим `base_rev` отбрасывается; ответ на `Resync` — снимок.
    if (!store.update(u)) return send({ t: 'Resync', have_rev: store.accepted?.rev ?? 0 });
    clock.accept(performance.now());
    map.invalidate();
  };
  onMessage = (msg) => {
    switch (msg.t) {
      case 'ViewSnapshot':
        store.snapshot(msg);
        clock.reset();
        map.invalidate();
        break;
      case 'ViewUpdate':
        accept(msg);
        break;
      case 'CommandResult':
        if (msg.update) accept(msg.update);
        if (msg.outcome.t === 'Rejected' && msg.outcome.reason === 'Stale') send({ t: 'Resync', have_rev: store.accepted?.rev ?? 0 });
        pending.get(msg.command_id)?.(msg.outcome);
        pending.delete(msg.command_id);
        break;
      case 'PreviewResult':
        previews.result(msg.req_id, msg.rev, msg.preview);
        break;
      case 'MoveOptionsResult': {
        const m = selectedMarker();
        // Устаревший ответ (другая ревизия или актив) отбрасывается.
        if (msg.req_id !== optionsReq || msg.rev !== store.shown?.rev || m?.t !== 'Own' || m.asset !== msg.asset_id) break;
        state.options.value = msg.options;
        map.setTargets(new Set(msg.options.targets.map((t) => t.node)));
        break;
      }
      case 'ReportText':
        store.text(msg.report_id, msg.text);
        break;
      case 'Advancing':
        state.waiting.value = msg.waiting_ops;
        break;
      case 'Opened':
        state.writer.value = msg.writer;
        break;
      case 'Exported': {
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([msg.file], { type: 'application/x-ndjson' })), download: `branchstate-${entry.scenario}-${store.shown?.date ?? ''}.jsonl` });
        a.click();
        URL.revokeObjectURL(a.href);
        break;
      }
      case 'Pong':
        pongN = msg.n;
        break;
      case 'Error':
        toast(msg.code === 'storage' ? 'Ошибка хранения: ход не сохранён. Освободите место и нажмите «Дальше».' : msg.code === 'quota_low' ? 'Место в хранилище браузера заканчивается — сделайте экспорт партии.' : `Ошибка: ${msg.code}`);
        break;
    }
  };

  // ---- отображение показанной ревизии

  let canOrder = false;
  let persisted = false;
  effect(() => {
    store.shownRev.value;
    store.textsRev.value;
    const shown = store.shown;
    if (!shown) return;
    const ctx: SheetCtx = {
      state: shown,
      actionable: store.actionable,
      writer: state.writer.value,
      tab: state.tab.value,
      sel: state.sel.value,
      draft: state.draft.value,
      saving: state.saving.value,
      options: state.options.value,
      waiting: state.waiting.value,
      texts: store.texts,
      opened: state.opened.value,
      names,
      date: (day) => dateRu(shown.date, day - shown.day, false),
      runs: state.runs.value,
      scenarios,
      llm: !!proxy,
      runId,
    };
    el.top.innerHTML = topBar(shown);
    const scroll = body.scrollTop;
    body.innerHTML = sheetBody(ctx);
    body.scrollTop = scroll;
    tabBar.innerHTML = tabs(ctx);
    el.sheet.classList.toggle('open', state.open.value);
    // Шторка не меняет размер канваса: координатор знает видимую часть карты над ней.
    el.map.dataset.inset = String(el.sheet.offsetHeight);
    map.invalidate();

    if (store.actionable && !canOrder) {
      canOrder = true;
      performance.mark('bs:can_order');
      for (const name of ['map_visible', 'map_movable', 'can_order']) send({ t: 'Metric', name, value: Math.round(performance.getEntriesByName(`bs:${name}`)[0]?.startTime ?? 0) });
    }
    if (shown.panel.has('summary') && !persisted) {
      persisted = true;
      // `persist()` недоступен в Worker: его вызывает главный поток после первой завершённой партии.
      void navigator.storage?.persist?.().then((ok) => ok || toast('Чтобы партии не пропали, добавьте игру на экран «Домой» или сделайте экспорт.'));
    }
  });

  // Новая показанная ревизия: старые варианты и превью убираются, для выбранного актива запрашиваются заново.
  let lastRev = -1;
  let lastDay = -1;
  effect(() => {
    store.shownRev.value;
    const shown = store.shown;
    if (!shown || shown.rev === lastRev) return;
    lastRev = shown.rev;
    if (advanceAt && shown.day !== lastDay && lastDay >= 0 && !sawDay) {
      sawDay = true;
      send({ t: 'Metric', name: 't2_ui', value: Math.round(performance.now() - advanceAt) });
    }
    if (advanceAt && store.actionable) {
      send({ t: 'Metric', name: 't3_ui', value: Math.round(performance.now() - advanceAt) });
      send({ t: 'Metric', name: 'anim_merges', value: clock.merges });
      send({ t: 'Metric', name: 'gl_context_losses', value: map.renderer.losses });
      advanceAt = 0;
    }
    lastDay = shown.day;
    const sel = state.sel.value;
    if (sel?.t === 'marker' && !shown.markers.has(sel.key)) state.sel.value = null;
    queueMicrotask(() => {
      requestOptions();
      const d = state.draft.value;
      if (d) startDraft(d.candidate, d.stances);
    });
  });
}

function startScreen() {
  const screen = $('<div id="start"><div></div></div>');
  const render = () => (screen.firstElementChild!.innerHTML = `<h1>BranchState</h1><p class="mut">Управление кризисом до большой войны.</p>${runTab({ runs: state.runs.value, scenarios, llm: !!proxy, runId: null })}`);
  render();
  document.body.append(screen);
  onMessage = (msg) => {
    if (msg.t === 'CommandResult') {
      pending.get(msg.command_id)?.(msg.outcome);
      pending.delete(msg.command_id);
    } else if (msg.t === 'Error') toast(`Ошибка: ${msg.code}`);
  };
  const handle = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!t) return;
    const [kind, ...rest] = t.dataset.a!.split(':');
    if (kind === 'new' && e.type === 'click') void create({ t: 'NewRun', scenario: rest[0], seed: null, daily: rest[2] === 'daily', mode: rest[1] as 'Scripted' | 'Llm' });
    if (kind === 'open' && e.type === 'click') switchRun(rest.join(':'));
    if (kind === 'import' && e.type === 'change') void (t as HTMLInputElement).files?.[0]?.text().then((file) => create({ t: 'Import', file }));
  };
  screen.addEventListener('click', handle);
  screen.addEventListener('change', handle);
}

addEventListener('error', (e) => send({ t: 'Metric', name: `error:${String(e.message).slice(0, 60)}`, value: 1 }));
addEventListener('unhandledrejection', (e) => send({ t: 'Metric', name: `rejection:${String(e.reason).slice(0, 60)}`, value: 1 }));
start().catch((e) => toast(`Не удалось запустить игру: ${e.message ?? e}`));
