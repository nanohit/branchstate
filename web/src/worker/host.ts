// Адаптер Worker: владеет ядром, журналом и сетью. Интерфейсу уходят только сообщения протокола.
// Восстановление не зависит от событий страницы: всё, от чего зависит продолжение, записано до исполнения.

import type {
  ActorInput,
  AdvanceMode,
  Command,
  CommandBody,
  DayRecord,
  DecideRequest,
  FromWorker,
  JsonValue,
  OrderKind,
  Outcome,
  Phase,
  Report,
  RunHeader,
  RunMode,
  RuntimeManifest,
  StopReason,
  ToWorker,
  ViewUpdate,
} from '../protocol.gen.ts';
import { ENGINE_VERSION } from '../protocol.gen.ts';
import { Fenced, type Faults, RunStore, done, isStorageError, openRun, openShell, req } from './db.ts';
import { OpsClient } from './ops.ts';

/** Ядро WASM: синхронные вызовы с JSON. */
export interface Core {
  snapshot(): Uint8Array;
  set_epoch(epoch: string): void;
  rev(): number;
  day(): number;
  ended(): boolean;
  hash(): string;
  pack_version(): string;
  view(): string;
  staged(): string;
  commit(intents: string): string;
  cancel(orderId: number): string;
  preview(intents: string): string;
  move_options(asset: string): string;
  needs(): string;
  autopilot(): string;
  step(inputs: string): string;
  replay(record: string): void;
  stop(reasons: string): string;
  set_phase(phase: string): string;
  resume(phase: string, stop: string, intents: string, rev: number): void;
  narrate_brief(reportId: string): string;
  accept_narration(reportId: string, narration: string): string;
  free(): void;
}

export interface CoreFactory {
  create(pack: string, seed: number, runId: string): Core;
  restore(pack: string, snapshot: Uint8Array, runId: string, rev: number, stop: string): Core;
}

export type RunIndexEntry = {
  run_id: string;
  runtime_manifest_id: string;
  title: string;
  scenario: string;
  updated_at: number;
  status: 'creating' | 'ready';
  creation_command_id: string;
  request_hash: string;
  seed: number;
  mode: RunMode;
  day?: number;
  ended?: boolean;
};

type Advance = { advance_id: string; mode: AdvanceMode; from_day: number; until: 'Stop' | { Day: number }; base_rev: number; budget_ms: number; spent_ms: number };

/** Единственная запись состояния хода партии. */
export type TurnOp = {
  run_id: string;
  writer_epoch: number;
  phase: Phase;
  rev: number;
  stop: { day: number; reasons: StopReason[] };
  intents: OrderKind[];
  advance?: Advance;
};

type OpRecord = { op_id: string; kind: 'decide' | 'narrate'; day: number; actor: string; request: JsonValue; state: 'unsent' | 'sent' | 'answered'; response?: JsonValue | null };
type DayInput = { source: 'model' | 'fallback'; data?: JsonValue; op_id?: string };
type SnapshotRec = { day: number; bytes: Uint8Array; rev: number; stop: StopReason[]; fork?: boolean };
type CommandRec = { request: string; outcome: Outcome; rev: number };

export type Deps = {
  idb: IDBFactory;
  locks: LockManager;
  fetch: typeof fetch;
  post: (msg: FromWorker) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  uuid: () => string;
  randomSeed: () => number;
  /** Сегодняшняя дата UTC «ГГГГ-ММ-ДД» — сид ежедневной партии. */
  today: () => string;
  loadCore: (manifest: RuntimeManifest) => Promise<CoreFactory>;
  loadPack: (manifest: RuntimeManifest, scenario: string) => Promise<string>;
  storageEstimate?: () => Promise<{ usage?: number; quota?: number }>;
  faults?: Faults;
  /** Бюджеты промотки и восстановления, мс; по умолчанию — гипотезы спеки. */
  budget?: { advance: number; recovery: number };
};

/** Общий бюджет промотки D и бюджет восстановления — гипотезы. */
export const BUDGET_MS = 6000;
export const RECOVERY_BUDGET_MS = 2000;
const MIN_SHARE_MS = 300;
const SNAPSHOTS_KEPT = 20;
const EVENTS_EVERY_MS = 30_000;
const OP_GIVE_UP_MS = 60_000;

const hashSeed = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export class Host {
  private d: Deps;
  private factory: CoreFactory | null = null;
  private manifest!: RuntimeManifest;
  private epoch = '';
  private runId: string | null = null;
  private header: RunHeader | null = null;
  private core: Core | null = null;
  private store: RunStore | null = null;
  private turn: TurnOp | null = null;
  private writer = false;
  private wantWriter = false;
  private hidden = false;
  private release: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private loop: Promise<void> | null = null;
  private ops: OpsClient | null = null;
  private running = new Map<string, { settled: Promise<void>; abort: AbortController }>();
  private events: JsonValue[] = [];
  private eventsSent = 0;
  private options = new Map<string, string>();
  private optionsRev = -1;
  private wake: (() => void) | null = null;

  constructor(deps: Deps) {
    this.d = deps;
  }

  /** Вход сообщений интерфейса. Команды и открытие идут по очереди; запросы без эффектов — сразу. */
  handle(msg: ToWorker): Promise<void> {
    switch (msg.t) {
      case 'Ping':
        this.d.post({ t: 'Pong', n: msg.n, epoch: this.epoch, phase: this.turn?.phase ?? null });
        return Promise.resolve();
      case 'Preview':
        if (this.core) this.post({ t: 'PreviewResult', run_id: this.runId!, epoch: this.epoch, req_id: msg.req_id, rev: this.core.rev(), preview: JSON.parse(this.core.preview(JSON.stringify(msg.intents))) });
        return Promise.resolve();
      case 'MoveOptions': {
        if (!this.core) return Promise.resolve();
        // Расчёт ограничен выбранным активом и переиспользуется, пока ревизия не изменилась.
        if (this.optionsRev !== this.core.rev()) this.options.clear();
        this.optionsRev = this.core.rev();
        const cached = this.options.get(msg.asset_id) ?? this.core.move_options(JSON.stringify(msg.asset_id));
        this.options.set(msg.asset_id, cached);
        this.post({ t: 'MoveOptionsResult', run_id: this.runId!, epoch: this.epoch, req_id: msg.req_id, rev: this.core.rev(), asset_id: msg.asset_id, options: JSON.parse(cached) });
        return Promise.resolve();
      }
      case 'Metric':
        this.event(msg.name, { value: msg.value });
        return Promise.resolve();
      case 'Visibility':
        return this.enqueue(() => this.visibility(msg.hidden));
      case 'Resync':
        return this.enqueue(async () => {
          if (this.core) this.postSnapshot();
        });
      case 'Open':
        return this.enqueue(() => this.open(msg));
      case 'Export':
        return this.enqueue(async () => this.post({ t: 'Exported', run_id: msg.run_id, epoch: this.epoch, file: await this.exportRun(msg.run_id) }));
      case 'Command':
        return this.enqueue(() => this.command(msg));
    }
  }

  /** Намерения игрока от резервной политики его персонажа — автопилот автопрогонов. */
  autopilot(): OrderKind[] {
    return this.core && this.turn?.phase === 'AtStop' ? JSON.parse(this.core.autopilot()) : [];
  }

  /** Ожидание конца промотки — для тестов и автопрогонов. */
  idle(): Promise<void> {
    return this.queue.then(() => this.loop ?? undefined).then(() => this.queue);
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job).catch((e) => this.fail(e));
    return this.queue;
  }

  private post(msg: FromWorker) {
    this.d.post(msg);
  }

  private postSnapshot() {
    this.post({ t: 'ViewSnapshot', ...JSON.parse(this.core!.view()) });
  }

  private fail(e: unknown) {
    if (e instanceof Fenced) return this.lostWriter();
    this.post({ t: 'Error', epoch: this.epoch, code: e instanceof Error ? e.message : String(e), recoverable: true });
  }

  private event(name: string, props: Record<string, JsonValue> = {}) {
    this.events.push({ name, t: Math.round(this.d.now()), run: this.runId, manifest: this.manifest?.id ?? null, ...props });
  }

  private flushEvents() {
    this.eventsSent = this.d.now();
    const batch = this.events.splice(0);
    if (batch.length && this.ops) void this.ops.events(batch);
  }

  // ---- открытие, блокировки, восстановление

  private async shell() {
    return openShell(this.d.idb);
  }

  private async indexGet(runId: string): Promise<RunIndexEntry | undefined> {
    const db = await this.shell();
    const entry = await req(db.transaction('runs_index').objectStore('runs_index').get(runId));
    db.close();
    return entry;
  }

  private async indexPut(entry: RunIndexEntry) {
    const db = await this.shell();
    const tx = db.transaction('runs_index', 'readwrite');
    tx.objectStore('runs_index').put(entry, entry.run_id);
    await done(tx);
    db.close();
  }

  private async open(msg: Extract<ToWorker, { t: 'Open' }>) {
    await this.close();
    this.epoch = msg.epoch;
    this.manifest = msg.manifest;
    this.factory ??= await this.d.loadCore(msg.manifest);
    this.ops = null;
    if (msg.proxy) {
      const token = {
        get: async () => {
          const db = await this.shell();
          const t = await req(db.transaction('settings').objectStore('settings').get('token'));
          db.close();
          return t as string | undefined;
        },
        set: async (t: string) => {
          const db = await this.shell();
          const tx = db.transaction('settings', 'readwrite');
          tx.objectStore('settings').put(t, 'token');
          await done(tx);
          db.close();
        },
      };
      this.ops = new OpsClient(msg.proxy, { fetch: this.d.fetch, sleep: this.d.sleep, token });
    }
    await this.finishCreations();
    const entry = msg.run_id ? await this.indexGet(msg.run_id) : undefined;
    if (!entry || entry.status !== 'ready') {
      this.post({ t: 'Opened', run_id: null, epoch: this.epoch, writer: false });
      return;
    }
    if (entry.runtime_manifest_id !== msg.manifest.id) throw new Error('wrong_manifest');
    this.runId = entry.run_id;
    this.wantWriter = true;
    this.store = new RunStore(await openRun(this.d.idb, entry.run_id), this.d.faults);
    this.header = (await this.store.get<RunHeader>('meta', 'header'))!;
    await this.becomeWriter(msg.steal);
    await this.recover();
    this.announce();
    this.event('open', { day: this.core!.day(), writer: this.writer });
  }

  private announce() {
    this.post({ t: 'Opened', run_id: this.runId, epoch: this.epoch, writer: this.writer });
    this.postSnapshot();
    void this.replayNarrations();
    if (this.writer && this.turn?.phase === 'Advancing') this.startLoop(true);
  }

  private async close() {
    this.wantWriter = false;
    this.writer = false;
    this.wake?.();
    await this.loop;
    for (const op of this.running.values()) op.abort.abort();
    this.running.clear();
    this.release?.();
    this.release = null;
    this.writer = false;
    this.core?.free();
    this.core = null;
    this.store?.db.close();
    this.store = null;
    this.turn = null;
    this.runId = null;
  }

  /** Писатель партии держит Web Lock `run:<id>`; безопасность держится на ограждающем номере, а не на блокировке. */
  private async becomeWriter(steal: boolean) {
    const name = `run:${this.runId}`;
    const got = await new Promise<boolean>((resolve) => {
      this.d.locks
        .request(name, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
          if (!lock) return resolve(false);
          resolve(true);
          return new Promise<void>((release) => {
            this.release = release;
          });
        })
        .catch(() => {
          resolve(false);
          this.lostWriter();
        });
    });
    this.writer = got;
    if (got) await this.store!.bumpEpoch();
  }

  /** `steal` не останавливает код старого писателя: обнаружив потерю владения, он переходит в просмотр. */
  private lostWriter() {
    if (!this.writer) return;
    this.writer = false;
    this.release?.();
    this.release = null;
    this.wake?.();
    this.post({ t: 'Opened', run_id: this.runId, epoch: this.epoch, writer: false });
  }

  /** Последний снимок, дни журнала после него по записанным входам, затем записанный `TurnOp`. */
  private async recover() {
    const store = this.store!;
    const pack = await this.d.loadPack(this.manifest, this.header!.scenario);
    const turn = (await store.get<TurnOp>('turn_op', this.runId!))!;
    const snaps = (await store.keys('snapshots')) as number[];
    const latest = (await store.get<SnapshotRec>('snapshots', Math.max(...snaps)))!;
    this.core?.free();
    const core = this.factory!.restore(pack, latest.bytes, this.runId!, latest.rev, JSON.stringify(latest.stop));
    for (const rec of await store.all<DayRecord>('days')) if (rec.day >= core.day()) core.replay(JSON.stringify(rec));
    const phase: Phase = turn.phase === 'Advancing' ? 'Advancing' : 'AtStop';
    core.resume(JSON.stringify(phase), JSON.stringify(turn.phase === 'Advancing' ? [] : turn.stop.reasons), JSON.stringify(turn.phase === 'AtStop' ? turn.intents : []), turn.rev);
    core.set_epoch(this.epoch);
    this.core = core;
    this.turn = turn;
  }

  /** При скрытии вкладки писатель завершает текущую транзакцию и отпускает блокировку; при возврате — всё заново. */
  private async visibility(hidden: boolean) {
    this.hidden = hidden;
    if (!this.runId || !this.wantWriter) return;
    if (hidden) {
      this.wake?.();
      await this.loop;
      this.release?.();
      this.release = null;
      this.writer = false;
    } else if (!this.writer) {
      await this.becomeWriter(false);
      await this.recover();
      this.announce();
    }
  }

  // ---- команды

  private reply(cmd: Command, outcome: Outcome, update: ViewUpdate | null = null) {
    this.post({ t: 'CommandResult', run_id: cmd.run_id, epoch: this.epoch, command_id: cmd.command_id, outcome, update });
  }

  private async command(cmd: Command) {
    const body = cmd.body;
    if (body.t === 'NewRun' || body.t === 'Import' || body.t === 'Fork') return this.createRun(cmd, body);
    const rejected = (reason: Extract<Outcome, { t: 'Rejected' }>['reason'], detail: string | null = null): Outcome => ({ t: 'Rejected', reason, current_rev: this.core?.rev() ?? null, detail });
    if (!this.core || !this.store || cmd.run_id !== this.runId) return this.reply(cmd, rejected('Invalid', 'партия не открыта'));
    const request = JSON.stringify(body);
    // Повтор распознаётся до проверки ревизии: тот же id и запрос возвращают сохранённый исход без эффекта.
    const prior = await this.store.get<CommandRec>('commands', cmd.command_id);
    if (prior) return this.reply(cmd, prior.request === request ? prior.outcome : rejected('CommandConflict'));
    if (!this.writer) return this.reply(cmd, rejected('NotWriter'));
    if (cmd.expected_rev !== this.core.rev()) return this.reply(cmd, rejected('Stale'));
    if (body.t === 'Advance' && this.turn!.phase === 'Advancing' && !this.loop) {
      // Промотка остановилась на ошибке хранения: «Дальше» продолжает записанную промотку.
      const outcome: Outcome = { t: 'Accepted' };
      try {
        await this.store.write(['commands'], (s) => void s.commands.put({ request, outcome, rev: this.core!.rev() } satisfies CommandRec, cmd.command_id));
      } catch (e) {
        if (e instanceof Fenced) this.lostWriter();
        return this.reply(cmd, rejected(e instanceof Fenced ? 'NotWriter' : 'Storage'));
      }
      this.reply(cmd, outcome);
      return this.startLoop(true);
    }
    if (this.turn!.phase !== 'AtStop') return this.reply(cmd, rejected('Busy'));

    const t0 = this.d.now();
    let update: ViewUpdate | null = null;
    let outcome: Outcome = { t: 'Accepted' };
    const turn: TurnOp = { ...this.turn!, writer_epoch: this.store.epoch };
    if (body.t === 'Commit' || body.t === 'Cancel') {
      const res = JSON.parse(body.t === 'Commit' ? this.core.commit(JSON.stringify(body.intents)) : this.core.cancel(body.order_id));
      if (res.reject) outcome = rejected('Invalid', res.reject.reason);
      update = res.update ?? null;
      turn.intents = JSON.parse(this.core.staged());
    } else {
      update = JSON.parse(this.core.set_phase('"Advancing"'));
      const from = this.core.day();
      turn.phase = 'Advancing';
      turn.advance = { advance_id: this.d.uuid(), mode: body.mode, from_day: from, until: body.mode === 'Next' ? 'Stop' : { Day: from + body.mode.Days }, base_rev: cmd.expected_rev, budget_ms: this.d.budget?.advance ?? BUDGET_MS, spent_ms: 0 };
    }
    turn.rev = this.core.rev();
    try {
      // Эффект, запись команды и `TurnOp` — одна транзакция; ответ только после её `complete`.
      await this.store.write(['commands', 'turn_op'], (s) => {
        s.commands.put({ request, outcome, rev: turn.rev } satisfies CommandRec, cmd.command_id);
        s.turn_op.put(turn, turn.run_id);
      });
    } catch (e) {
      // Ничего не показывается как сохранённое: состояние возвращается к последнему записанному.
      if (e instanceof Fenced) this.lostWriter();
      await this.recover();
      this.reply(cmd, rejected(e instanceof Fenced ? 'NotWriter' : 'Storage'));
      this.postSnapshot();
      return;
    }
    this.turn = turn;
    this.reply(cmd, outcome, update);
    if (body.t === 'Advance') {
      this.event('t1', { value: Math.round(this.d.now() - t0) });
      this.startLoop(false);
    } else if (outcome.t === 'Accepted') {
      this.event(body.t === 'Commit' ? 'order' : 'cancel');
    }
  }

  // ---- промотка

  private startLoop(recovering: boolean) {
    this.loop = this.advance(recovering)
      .catch((e) => {
        if (e instanceof Fenced) return this.lostWriter();
        // Ошибка записи: промотка останавливается на последнем записанном дне.
        this.post({ t: 'Error', epoch: this.epoch, code: isStorageError(e) ? 'storage' : String(e), recoverable: true });
        return this.recover().then(() => this.postSnapshot());
      })
      .finally(() => {
        this.loop = null;
      });
  }

  private llm() {
    return this.header?.mode === 'Llm' && this.ops !== null;
  }

  private async advance(recovering: boolean) {
    const core = this.core!;
    const store = this.store!;
    const adv = this.turn!.advance!;
    const started = this.d.now();
    let first = true;
    while (this.writer && !this.hidden && this.turn!.phase === 'Advancing') {
      const day = core.day();
      const needs: DecideRequest[] = this.llm() ? JSON.parse(core.needs()) : [];
      const actors: Record<string, ActorInput> = {};
      if (needs.length) {
        // Доля бюджета дня — две трети оставшегося: чаще всего день с операциями в промотке один.
        // При восстановлении — не больше бюджета восстановления.
        const share = Math.max(MIN_SHARE_MS, ((adv.budget_ms - adv.spent_ms) * 2) / 3);
        this.post({ t: 'Advancing', run_id: this.runId!, epoch: this.epoch, advance_id: adv.advance_id, day, waiting_ops: needs.length });
        adv.spent_ms += await this.collect(day, needs, recovering ? Math.min(share, this.d.budget?.recovery ?? RECOVERY_BUDGET_MS) : share);
        if (!this.writer || this.hidden) break;
        for (const n of needs) {
          const row = (await store.get<DayInput>('day_inputs', [day, n.actor]))!;
          actors[n.actor] = row.source === 'model' ? { Model: row.data! } : 'Fallback';
        }
      }
      recovering = false;
      const player = day === adv.from_day ? this.turn!.intents : [];
      const res: { record: DayRecord; update: ViewUpdate | null } = JSON.parse(core.step(JSON.stringify({ player, actors })));
      const rec = res.record;
      const reasons: StopReason[] = [...rec.hard, ...(adv.mode === 'Next' ? rec.soft : [])];
      if (adv.until !== 'Stop' && core.day() >= adv.until.Day && !reasons.length) reasons.push('Days');
      const stop = reasons.length > 0;
      const stopUpdate: ViewUpdate | null = stop ? JSON.parse(core.stop(JSON.stringify(reasons))) : null;
      const turn: TurnOp = stop
        ? { run_id: this.runId!, writer_epoch: store.epoch, phase: core.ended() ? 'Ended' : 'AtStop', rev: core.rev(), stop: { day: core.day(), reasons }, intents: [] }
        : { ...this.turn!, writer_epoch: store.epoch, rev: core.rev(), intents: [], advance: adv };
      const snapshot: SnapshotRec | null = stop ? { day: core.day(), bytes: core.snapshot(), rev: core.rev(), stop: reasons } : null;
      // Разрешение дня — одна транзакция: журнал, `TurnOp`, снимок на остановке. Сеть — вне транзакции.
      await store.write(['days', 'turn_op', 'snapshots'], async (s) => {
        s.days.put(rec, rec.day);
        s.turn_op.put(turn, turn.run_id);
        if (snapshot) {
          s.snapshots.put(snapshot, snapshot.day);
          const old = ((await req(s.snapshots.getAll())) as SnapshotRec[]).filter((x) => !x.fork && x.day !== snapshot.day);
          for (const x of old.slice(0, Math.max(0, old.length - SNAPSHOTS_KEPT + 1))) s.snapshots.delete(x.day);
        }
      });
      this.turn = turn;
      if (res.update) this.post({ t: 'ViewUpdate', ...res.update });
      if (first) this.event('t2', { value: Math.round(this.d.now() - started) });
      first = false;
      if (Object.keys(rec.rejected).length) this.event('model_rejected', { day, actors: Object.keys(rec.rejected).length });
      this.event('day', { day, fallback: Object.values(rec.sources).filter((s) => s === 'Fallback').length, model: Object.values(rec.sources).filter((s) => s === 'Model').length });
      // Заранее: операции следующего дня уходят сразу после разрешения, ещё до того, как игрок увидит результат.
      if (this.llm() && !core.ended()) for (const n of JSON.parse(core.needs()) as DecideRequest[]) void this.ensureOp(core.day(), n);
      if (stop) {
        if (stopUpdate) this.post({ t: 'ViewUpdate', ...stopUpdate });
        this.event('t3', { value: Math.round(this.d.now() - started) });
        this.event(core.ended() ? 'end' : 'stop', { day: core.day() });
        // Литературные версии — для донесений этой промотки, попавших в итоговый список остановки.
        await this.afterStop((JSON.parse(core.view()).reports as Report[]).filter((r) => r.day > adv.from_day));
        return;
      }
      if (this.d.now() - this.eventsSent > EVENTS_EVERY_MS) this.flushEvents();
      // Уступить цикл событий: Ping, Resync и скрытие вкладки обслуживаются между днями.
      await this.d.sleep(0);
    }
  }

  private async afterStop(reports: Report[]) {
    const entry = await this.indexGet(this.runId!);
    if (entry) await this.indexPut({ ...entry, updated_at: Date.now(), day: this.core!.day(), ended: this.core!.ended() });
    const est = await this.d.storageEstimate?.().catch(() => undefined);
    if (est?.quota && est.usage && est.usage / est.quota > 0.9) this.post({ t: 'Error', epoch: this.epoch, code: 'quota_low', recoverable: true });
    if (this.llm()) for (const r of reports) void this.narrate(r.report_id);
    this.flushEvents();
  }

  /** Операция записывается в `ops` до отправки; её параметры после этого не меняются. */
  private async ensureOp(day: number, need: DecideRequest): Promise<string> {
    const op_id = `${this.runId}:${day}:${need.actor}`;
    if (this.running.has(op_id)) return op_id;
    const store = this.store!;
    let op = await store.get<OpRecord>('ops', op_id);
    if (!op) {
      op = { op_id, kind: 'decide', day, actor: need.actor, state: 'unsent', request: { op_id, kind: 'decide', pack_version: this.header!.pack_version, persona_id: need.persona, tier: need.tier, observation: need.brief as unknown as JsonValue } };
      await store.write(['ops'], (s) => void s.ops.put(op, op_id));
    }
    if (op.state !== 'answered') this.launch(op);
    return op_id;
  }

  private launch(op: OpRecord) {
    const abort = new AbortController();
    const settled = (async () => {
      if (op.state === 'unsent') await this.store!.write(['ops'], (s) => void s.ops.put({ ...op, state: 'sent' }, op.op_id));
      // Поздний ответ ещё полезен для анализа, но ждать его бесконечно незачем.
      const response = await this.ops!.run(op.request as never, AbortSignal.any([abort.signal, AbortSignal.timeout(OP_GIVE_UP_MS)]));
      if (abort.signal.aborted) return;
      // Ответ сохраняется всегда — поздний тоже, для анализа; применит ли его день, решает правило выбора.
      await this.store!.write(['ops'], (s) => void s.ops.put({ ...op, state: 'answered', response }, op.op_id));
    })().catch((e) => {
      if (e instanceof Fenced) this.lostWriter();
    });
    this.running.set(op.op_id, { settled, abort });
    void settled.finally(() => {
      this.wake?.();
    });
  }

  /**
   * Правило выбора результата: пока выбор для (день, актор) не записан, берётся любой полученный допустимый
   * ответ; когда доля бюджета дня истекла — записывается `fallback`. Запись неизменяема: поздний ответ
   * ничего не меняет. Бюджет тратится только при видимой вкладке. Возвращает потраченное время.
   */
  private async collect(day: number, needs: DecideRequest[], share: number): Promise<number> {
    const store = this.store!;
    const ids = new Map<string, string>();
    for (const n of needs) ids.set(n.actor, await this.ensureOp(day, n));
    let spent = 0;
    for (;;) {
      let open = 0;
      for (const [actor, op_id] of ids) {
        if (await store.get<DayInput>('day_inputs', [day, actor])) continue;
        const op = await store.get<OpRecord>('ops', op_id);
        const answered = op?.state === 'answered';
        if (!answered && spent < share) {
          open++;
          continue;
        }
        const row: DayInput = answered && op.response != null ? { source: 'model', data: op.response, op_id } : { source: 'fallback', op_id };
        // Выбор источника записывается до использования и больше не меняется.
        await store.write(['day_inputs'], async (s) => {
          if (!(await req(s.day_inputs.get([day, actor])))) s.day_inputs.put(row, [day, actor]);
        });
      }
      if (!open || !this.writer || this.hidden) return spent;
      const t = this.d.now();
      await Promise.race([new Promise<void>((r) => (this.wake = r)), this.d.sleep(Math.min(100, share - spent))]);
      this.wake = null;
      spent += this.d.now() - t;
    }
  }

  // ---- донесения: литературная версия не блокирует ход

  private async narrate(reportId: string) {
    const brief = JSON.parse(this.core!.narrate_brief(reportId));
    if (!brief) return;
    const op_id = `${this.runId}:n:${reportId}`;
    const request = { op_id, kind: 'narrate' as const, pack_version: this.header!.pack_version, persona_id: '', tier: 'Small', observation: brief };
    const runId = this.runId;
    try {
      let op = await this.store!.get<OpRecord>('ops', op_id);
      if (!op) {
        op = { op_id, kind: 'narrate', day: this.core!.day(), actor: reportId, state: 'sent', request };
        await this.store!.write(['ops'], (s) => void s.ops.put(op, op_id));
      }
      const response = op.state === 'answered' ? op.response : await this.ops!.run(request, AbortSignal.timeout(60_000));
      if (runId !== this.runId || !this.core || response == null) return;
      if (op.state !== 'answered') await this.store!.write(['ops'], (s) => void s.ops.put({ ...op, state: 'answered', response }, op_id));
      const text: string | null = JSON.parse(this.core.accept_narration(reportId, JSON.stringify(response)));
      if (text) this.post({ t: 'ReportText', run_id: runId!, epoch: this.epoch, report_id: reportId, text });
    } catch (e) {
      if (e instanceof Fenced) this.lostWriter();
    }
  }

  /** После открытия: уже полученные литературные тексты прикрепляются к донесениям заново. */
  private async replayNarrations() {
    const core = this.core;
    if (!core || !this.store) return;
    for (const op of await this.store.all<OpRecord>('ops')) {
      if (op.kind !== 'narrate' || op.state !== 'answered' || op.response == null || core !== this.core) continue;
      const text: string | null = JSON.parse(core.accept_narration(op.actor, JSON.stringify(op.response)));
      if (text) this.post({ t: 'ReportText', run_id: this.runId!, epoch: this.epoch, report_id: op.actor, text });
    }
  }

  // ---- создание партий: между базами IndexedDB нет общей транзакции

  /** После сбоя: готовая база со статусом `creating` допубликовывается. */
  private async finishCreations() {
    const db = await this.shell();
    const entries: RunIndexEntry[] = await req(db.transaction('runs_index').objectStore('runs_index').getAll());
    db.close();
    for (const e of entries.filter((e) => e.status === 'creating')) {
      const run = await openRun(this.d.idb, e.run_id);
      const ready = await req(run.transaction('meta').objectStore('meta').get('init_done'));
      run.close();
      if (ready) await this.indexPut({ ...e, status: 'ready' });
    }
  }

  private async createRun(cmd: Command, body: Extract<CommandBody, { t: 'NewRun' | 'Import' | 'Fork' }>) {
    const reject = (reason: 'Invalid' | 'CommandConflict' | 'Storage', detail: string | null = null) => this.reply(cmd, { t: 'Rejected', reason, current_rev: null, detail });
    const request = JSON.stringify(body);
    const factory = this.factory!;

    // Что создаём: заголовок партии, начальное ядро и дни журнала до него.
    let header: RunHeader;
    let lines: string[] = [];
    if (body.t === 'Import') {
      lines = body.file.split('\n').filter((l) => l.trim());
      try {
        header = { ...JSON.parse(lines.shift()!), runtime_manifest_id: this.manifest.id, parent_id: null, fork_day: null };
      } catch {
        return reject('Invalid', 'файл партии не читается');
      }
      const sc = this.manifest.scenarios[header.scenario];
      if (!sc || sc.pack_version !== header.pack_version || header.engine_version !== ENGINE_VERSION) return reject('Invalid', 'партия записана другим комплектом версий');
    } else if (body.t === 'Fork') {
      if (!this.core || !this.header || body.day < 0 || body.day > this.core.day()) return reject('Invalid', 'развилка возможна только на прошедшей границе дня');
      header = { ...this.header, parent_id: this.runId, fork_day: body.day };
    } else {
      const sc = this.manifest.scenarios[body.scenario];
      if (!sc) return reject('Invalid', 'нет такого сценария');
      const seed = body.seed ?? (body.daily ? hashSeed(`${body.scenario}:${this.d.today()}`) : this.d.randomSeed());
      header = { format: 1, scenario: body.scenario, pack_version: sc.pack_version, engine_version: ENGINE_VERSION, runtime_manifest_id: this.manifest.id, seed, mode: body.mode, parent_id: null, fork_day: null };
    }

    // 1. Индекс: связь команды с постоянным целевым run_id, хэш запроса, статус `creating`.
    const shell = await this.shell();
    const tx = shell.transaction('runs_index', 'readwrite');
    const index = tx.objectStore('runs_index');
    const all: RunIndexEntry[] = await req(index.getAll());
    let entry = all.find((e) => e.creation_command_id === cmd.command_id);
    if (entry && entry.request_hash !== request) {
      shell.close();
      return reject('CommandConflict');
    }
    if (!entry) {
      entry = {
        run_id: cmd.run_id,
        runtime_manifest_id: this.manifest.id,
        title: this.manifest.scenarios[header.scenario].title,
        scenario: header.scenario,
        updated_at: Date.now(),
        status: 'creating',
        creation_command_id: cmd.command_id,
        request_hash: request,
        seed: header.seed,
        mode: header.mode,
      };
      index.put(entry, entry.run_id);
    }
    await done(tx);
    shell.close();
    // Повтор продолжает ту же операцию с тем же сидом и не создаёт новую партию.
    header.seed = entry.seed;
    const runId = entry.run_id;

    if (entry.status === 'creating') {
      // 2. Начальные данные и отметка завершения инициализации — под блокировкой целевой партии.
      const pack = await this.d.loadPack(this.manifest, header.scenario);
      let core: Core;
      const days: DayRecord[] = [];
      try {
        if (body.t === 'Fork') {
          core = await this.rebuild(pack, body.day, runId);
        } else {
          core = factory.create(pack, header.seed, runId);
          for (const line of lines) {
            core.replay(line);
            days.push(JSON.parse(line));
          }
        }
      } catch (e) {
        return reject('Invalid', e instanceof Error ? e.message : String(e));
      }
      try {
        await this.d.locks.request(`run:${runId}`, async () => {
          const db = await openRun(this.d.idb, runId);
          const t = db.transaction(['meta', 'turn_op', 'snapshots', 'days'], 'readwrite');
          if (!(await req(t.objectStore('meta').get('init_done')))) {
            const turn: TurnOp = { run_id: runId, writer_epoch: 0, phase: core.ended() ? 'Ended' : 'AtStop', rev: core.rev(), stop: { day: core.day(), reasons: [] }, intents: [] };
            t.objectStore('meta').put(header, 'header');
            t.objectStore('meta').put(0, 'writer_epoch');
            t.objectStore('turn_op').put(turn, runId);
            // Начальный снимок — точка развилки: он не удаляется, и любую границу дня можно восстановить.
            t.objectStore('snapshots').put({ day: core.day(), bytes: core.snapshot(), rev: core.rev(), stop: [], fork: true } satisfies SnapshotRec, core.day());
            for (const d of days) t.objectStore('days').put(d, d.day);
            t.objectStore('meta').put(true, 'init_done');
            this.d.faults?.beforeCommit?.(['init']);
          }
          await done(t);
          db.close();
        });
      } catch {
        core.free();
        return reject('Storage');
      }
      const day = core.day();
      core.free();
      // 3. Публикация статуса `ready` — только после инициализации.
      this.d.faults?.beforeCommit?.(['publish']);
      await this.indexPut({ ...entry, status: 'ready', day });
    }
    this.reply(cmd, { t: 'Accepted' });
    this.event(body.t === 'Fork' ? 'fork' : 'start', { scenario: header.scenario });
  }

  /** Состояние открытой партии на границе дня `day`: ближайший снимок не позже дня и дни журнала после него. */
  private async rebuild(pack: string, day: number, runId: string): Promise<Core> {
    const store = this.store!;
    const snaps = ((await store.keys('snapshots')) as number[]).filter((d) => d <= day);
    if (!snaps.length) throw new Error('нет снимка не позже дня развилки');
    const snap = (await store.get<SnapshotRec>('snapshots', Math.max(...snaps)))!;
    const core = this.factory!.restore(pack, snap.bytes, runId, 1, '[]');
    for (const rec of await store.all<DayRecord>('days')) if (rec.day >= core.day() && rec.day < day) core.replay(JSON.stringify(rec));
    if (core.day() !== day) throw new Error('журнал не покрывает день развилки');
    core.stop('[]');
    return core;
  }

  /** Файл партии — JSON Lines: заголовок и дни. Дни до развилки читаются у родителя. */
  private async exportRun(runId: string): Promise<string> {
    const chain: { header: RunHeader; days: DayRecord[] }[] = [];
    for (let id: string | null = runId, before = Infinity; id; ) {
      const db = await openRun(this.d.idb, id);
      const header: RunHeader = await req(db.transaction('meta').objectStore('meta').get('header'));
      const days: DayRecord[] = await req(db.transaction('days').objectStore('days').getAll());
      db.close();
      chain.unshift({ header, days: days.filter((d) => d.day < before) });
      before = header.fork_day ?? 0;
      id = header.parent_id;
    }
    const header = { ...chain[chain.length - 1].header, parent_id: null, fork_day: null };
    return [JSON.stringify(header), ...chain.flatMap((c) => c.days.map((d) => JSON.stringify(d)))].join('\n') + '\n';
  }
}
