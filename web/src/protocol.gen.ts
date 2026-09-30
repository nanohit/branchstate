// Сгенерировано из Rust: cargo run -p branchstate-core --features ts --bin gen-ts. Не править руками.

export const PROTOCOL_VERSION = 1;
export const ENGINE_VERSION = "0.1.0";

export type AStatus = "Active" | "Violated" | "Ended";

export type Act = { "Order": OrderKind } | { "Offer": string } | { "Declare": string } | { "Respond": { template: string | null, from: string | null, accept: boolean, } } | { "CounterWith": { template: string, with: string, } } | { "EngageAt": { asset: string, enemy: string, } } | "Honor";

export type Action = { id: string, 
/**
 * Объект действия: `asset:<id>`, `state:<id>`, `proposal:<n>`, `order:<n>` или `self`.
 */
object: string, label: string, kind: OrderTag, 
/**
 * Готовое намерение; `None` у `Move` — цель выбирается через `move_options`.
 */
intent: OrderKind | null, cost: number, };

export type ActorInput = { "Model": JsonValue } | "Fallback";

export type AdvanceMode = "Next" | { "Days": number };

export type Agreement = { id: number, parties: Array<string>, terms: Array<Term>, since: number, status: AStatus, public: boolean, template: string | null, 
/**
 * Приказы сторон, создавшие соглашение: `Cancel` такого приказа отменяет платежи стороны.
 */
orders: Array<number>, };

export type AgreementView = { id: number, parties: Array<string>, label: string, terms: Array<string>, status: AStatus, public: boolean, };

export type AssetKind = "Fleet" | "Flotilla" | "Army" | "Convoy";

export type Brief = { day: number, state: string, goal: string, resources: { [key in Res]?: number }, initiative: number, plan: Array<Step>, triggers: Array<Trigger>, assets: Array<BriefAsset>, contacts: Array<Contact>, wars: Array<[string, string]>, mobilization: { [key in string]: number }, relations: Array<BriefRelation>, beliefs: Array<BriefBelief>, news: Array<BriefNews>, commitments: Array<Commitment>, agreements: Array<Agreement>, proposals: Array<Proposal>, menu: Array<MenuItem>, };

export type BriefAsset = { id: string, kind: AssetKind, at: string, free: boolean, stance: Stance | null, };

export type BriefBelief = { about: string, prop: Prop, confidence: number, };

export type BriefNews = { id: number, kind: EventKind, day: number, channel: Channel, actor: string | null, target: string | null, node: string | null, asset: string | null, amount: number, template: string | null, };

export type BriefRelation = { about: string, kind: MemKind, weight: number, day: number, };

export type CStatus = "Active" | "Fulfilled" | "Broken" | "Expired";

export type CanonState = "Matches" | "Contradicts" | "Undetermined";

export type Channel = "Direct" | "Seen" | "Embassy" | "Telegraph" | "Press" | "Leak" | "Inquiry";

export type CheckpointView = { id: string, date: string, label: string, state: CanonState, };

export type Claim = { "Demand": { terms: Array<Term>, } } | { "Pledge": { term: Term, } } | { "Support": { of: string, } } | { "Warning": { kind: OrderTag, target: string | null, } } | { "NoIntent": { kind: OrderTag, target: string | null, } } | { "Deny": { kind: EventKind, } };

export type Class = "GreatPower" | "Minor";

export type Command = { run_id: string, command_id: string, expected_rev: number, body: CommandBody, };

export type CommandBody = { "t": "Commit", intents: Array<OrderKind>, } | { "t": "Cancel", order_id: number, } | { "t": "Advance", mode: AdvanceMode, } | { "t": "Fork", day: number, } | { "t": "NewRun", scenario: string, seed: number | null, daily: boolean, mode: RunMode, sandbox: boolean, } | { "t": "Import", file: string, };

export type Commitment = { id: number, agreement: number, term: number, debtor: string, creditor: string, status: CStatus, paid: number, due: Due | null, };

export type CommitmentView = { id: number, text: string, mine: boolean, other: string, due: string | null, against: string | null, };

export type Cond = "Always" | { "Day": { from: number, } } | { "Learned": { kind: EventKind, actor: string | null, target: string | null, node: string | null, refid: string | null, within: number | null, } } | { "Pending": { template: string | null, from: string | null, } } | { "War": { a: string, b: string, } } | { "Mob": { state: string, min: number, } } | { "ResBelow": { res: Res, value: number, } } | { "AssetAt": { asset: string, node: string, } } | { "ContactAt": { owner: string, node: string, } } | { "Agreed": { with: string, template: string | null, } } | "Due" | { "Cargo": { asset: string, min: number, } } | { "Not": Cond } | { "All": Array<Cond> } | { "Any": Array<Cond> };

export type Contact = { asset: string, owner: string, kind: AssetKind, node: string, day: number, stance: Stance | null, moving: boolean, };

export type CoreTypes = { record: DayRecord, header: RunHeader, decide: DecideRequest, narrate: NarrateBrief, narration: Narration, };

export type DayInputs = { player: Array<OrderKind>, actors: { [key in string]: ActorInput }, };

export type DayRecord = { day: number, inputs: DayInputs, hash: string, sources: { [key in string]: Source }, 
/**
 * Отказы проверки ответов моделей.
 */
rejected: { [key in string]: string }, 
/**
 * Остановки после дня: жёсткие прерывают и «Ждать N дней», мягкие — только «Дальше».
 */
hard: Array<StopReason>, soft: Array<StopReason>, };

export type DecideRequest = { actor: string, persona: string, tier: Tier, obs_hash: string, brief: Brief, };

export type DeclKind = "Note" | "Ultimatum" | "Guarantee" | "Denial";

export type Due = { by: number, against: string, node: string | null, };

export type Echo = { kind: EventKind, actor: string | null, target: string | null, node: string | null, day: number, outcome: number, };

export type EndReason = "EndEvent" | "GoalAchieved" | "GoalFailed" | "Horizon" | "Crisis";

export type EventKind = "Arrived" | "Incursion" | "Demonstration" | "BlockadeSet" | "Blocked" | "Battle" | "AssetLost" | "Occupied" | "HostilitiesOpened" | "WarDeclared" | "EngageFailed" | "OrderFailed" | "Proposed" | "ProposalAccepted" | "ProposalRejected" | "ProposalCountered" | "ProposalExpired" | "ProposalWithdrawn" | "AgreementMade" | "AgreementConflict" | "Declared" | "ThreatUnanswered" | "MobilizationStarted" | "MobilizationChanged" | "Paid" | "PaymentFailed" | "CommitmentDue" | "Fulfilled" | "Breach" | "Expired" | "UpkeepUnpaid" | "CabinetDemand" | "GovernmentCrisis" | "CargoLoaded" | "CargoUnloaded" | "Inquiry" | "GoalAchieved" | "GoalFailed";

export type FileRef = { url: string, sri: string, };

export type FromWorker = { "t": "ViewSnapshot" } & ViewSnapshot | { "t": "ViewUpdate" } & ViewUpdate | { "t": "CommandResult", run_id: string, epoch: string, command_id: string, outcome: Outcome, update: ViewUpdate | null, } | { "t": "PreviewResult", run_id: string, epoch: string, req_id: number, rev: number, preview: Preview, } | { "t": "MoveOptionsResult", run_id: string, epoch: string, req_id: number, rev: number, asset_id: string, options: MoveOptions, } | { "t": "ReportText", run_id: string, epoch: string, report_id: string, text: string, } | { "t": "Exported", run_id: string, epoch: string, file: string, } | { "t": "Pong", n: number, epoch: string, phase: Phase | null, } | { "t": "Advancing", run_id: string, epoch: string, advance_id: string, day: number, waiting_ops: number, } | { "t": "Opened", run_id: string | null, epoch: string, writer: boolean, } | { "t": "Error", epoch: string, code: string, recoverable: boolean, };

export type GTrigger = "War" | "Blockade" | "Incursion";

export type GoalStatus = "Open" | { "Achieved": number } | { "Failed": number };

export type GoalView = { label: string, status: GoalStatus, until: string, };

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]: JsonValue } | null;

export type MapPatch = { regions: Array<Op<string, RegionView>>, markers: Array<Op<string, Marker>>, };

export type MapView = { regions: { [key in string]: RegionView }, markers: { [key in string]: Marker }, };

export type Marker = { "t": "Own", asset: string, name: string, kind: AssetKind, pos: Pos, stance: Stance | null, free: boolean, busy_until: number | null, path: Array<string>, cargo: number, } | { "t": "Foreign", asset: string, name: string, owner: string, kind: AssetKind, node: string, info_day: number, stance: Stance | null, } | { "t": "Unknown", node: string, info_day: number, kind: AssetKind, } | { "t": "Flash", node: string, kind: EventKind, day: number, };

export type MeView = { state: string, name: string, scenario: string, resources: { [key in Res]?: number }, initiative: number, capacity: number, 
/**
 * Инициатива и казна за вычетом резерва принятых приказов.
 */
initiative_left: number, treasury_left: number, mob_target: [number, number] | null, 
/**
 * Цель партии; в песочнице её нет.
 */
goal: GoalView | null, };

export type MemKind = "Grievance" | "Favor" | "Promise" | "Breach";

export type MenuItem = { id: string, intent: OrderKind, };

export type MoveOptions = { asset: string, targets: Array<MoveTarget>, };

export type MoveTarget = { node: string, path: Array<string>, edges: Array<string>, days: number, arrive: number, stances: Array<Stance>, incursion: string | null, };

export type NarrateBrief = { echo: Echo, channel: Channel, template: string | null, };

export type Narration = { text: string, echo: Echo, };

export type Op<K, V> = { "Upsert": [K, V] } | { "Remove": K };

export type OrderKind = { "Move": { asset: string, to: string, stance: Stance, } } | { "Engage": { asset: string, target: string, } } | { "Propose": { to: string, terms: Array<Term>, expires: number, template: string | null, } } | { "Accept": { proposal: number, } } | { "Reject": { proposal: number, } } | { "Counter": { proposal: number, terms: Array<Term>, expires: number, template: string | null, } } | { "Declare": { to: string, kind: DeclKind, claim: Claim, deadline: number | null, template: string | null, } } | { "DeclareWar": { target: string, } } | { "Mobilize": { delta: number, } } | { "Pay": { to: string, amount: number, } } | { "Inquire": { target: string, } } | { "Cancel": { order: number, } };

export type OrderPreview = { name: string, cost: number, reserved: [string, number] | null, 
/**
 * Видимость действия: открытое или тихое.
 */
open: boolean, 
/**
 * Свои обязательства, которые приказ нарушит.
 */
breaches: Array<number>, 
/**
 * Обязательства, которые возникнут у отдающего приказ.
 */
creates: Array<Term>, path: Array<string>, edges: Array<string>, arrive: number | null, 
/**
 * Известные блокады на пути.
 */
blocked_by: Array<string>, 
/**
 * Чей узел на пути без известного доступа: вход будет нарушением границы.
 */
incursion: string | null, 
/**
 * Кто заметит сразу — из тех, чьё присутствие известно.
 */
notice: Array<string>, };

export type OrderTag = "Move" | "Engage" | "Propose" | "Accept" | "Reject" | "Counter" | "Declare" | "DeclareWar" | "Mobilize" | "Pay" | "Inquire" | "Cancel" | "Blockade" | "Demonstrate" | "Escort";

export type OrderView = { id: number, name: string, 
/**
 * В планах этой остановки (ещё не исполняется).
 */
staged: boolean, cost: number, asset: string | null, path: Array<string>, arrive: string | null, };

export type Outcome = { "t": "Accepted" } | { "t": "Rejected", reason: RejectCode, current_rev: number | null, detail: string | null, };

export type PStatus = "Pending" | "Accepted" | "Rejected" | "Countered" | "Expired" | "Withdrawn";

export type PanelItem = { "t": "Me", "v": MeView } | { "t": "Order", "v": OrderView } | { "t": "Proposal", "v": ProposalView } | { "t": "Agreement", "v": AgreementView } | { "t": "Commitment", "v": CommitmentView } | { "t": "Power", "v": PowerView } | { "t": "Actions", "v": Array<Action> } | { "t": "Stop", "v": Array<StopReason> } | { "t": "Summary", "v": Summary };

export type Phase = "AtStop" | "Advancing" | "Ended";

export type Pos = { "t": "Node", node: string, } | { "t": "Edge", edge: string, from: string, to: string, progress: number, days: number, };

export type PowerView = { state: string, name: string, class: Class, persona: string | null, 
/**
 * Известная ступень мобилизации и день сведений.
 */
mob: [number, number] | null, at_war_with_me: boolean, wars: Array<string>, };

export type Preview = { reject: Reject | null, orders: Array<OrderPreview>, initiative_left: number, treasury_left: number, 
/**
 * День, на который верны оценки: «по вашим данным на день X».
 */
as_of: number, };

export type Prop = "Hostile" | "Friendly" | "Bluffing" | "Resolved" | "WillAttack" | "WillYield" | "Unreliable" | "Reliable";

export type Proposal = { id: number, from: string, to: string, terms: Array<Term>, created: number, expires: number, status: PStatus, template: string | null, ultimatum: boolean, counter_of: number | null, order: number, };

export type ProposalView = { id: number, from: string, to: string, label: string, terms: Array<string>, expires: string, status: PStatus, ultimatum: boolean, };

export type Reason = "NotYours" | "Busy" | "NoInitiative" | "NoFunds" | "NoPath" | "UnknownTarget" | "BadParams" | "OpenProposal" | "Paused" | "TooSoon" | "NotPending" | "AlreadyAtWar" | "InTransition" | "Unavailable" | "Duplicate";

export type RegionView = { 
/**
 * Известный владелец; `None` — неизвестно.
 */
owner: string | null, info_day: number, own: boolean, war: boolean, disputed: boolean, 
/**
 * Класс фронта: 0 — нет, 1 — граница воюющих, 2 — фронт игрока.
 */
front: number, 
/**
 * Давность сведений 0–3.
 */
age: number, };

export type Reject = { index: number, reason: Reason, };

export type RejectCode = "Stale" | "CommandConflict" | "Invalid" | "Storage" | "NotWriter" | "Busy";

export type Report = { report_id: string, day: number, title: string, facts: string, kind: EventKind, actor: string | null, target: string | null, node: string | null, event_day: number, channel: Channel, 
/**
 * Исход для эха литературной версии: поле `amount` главного события.
 */
outcome: number, 
/**
 * Шаблон заявления или предложения — посредник возьмёт его название из своей копии пакета.
 */
template: string | null, weight: number, };

export type Res = "Treasury" | "Mobilization" | "Pressure" | "Food";

export type RunHeader = { format: number, scenario: string, pack_version: string, engine_version: string, runtime_manifest_id: string, seed: number, mode: RunMode, sandbox: boolean, parent_id: string | null, fork_day: number | null, };

export type RunMode = "Scripted" | "Llm";

export type RuntimeManifest = { id: string, protocol: number, engine_version: string, ui: FileRef, core: FileRef, wasm: FileRef, fonts: Array<FileRef>, scenarios: { [key in string]: ScenarioFiles }, };

export type ScenarioFiles = { title: string, sandbox: string | null, pack_version: string, pack: FileRef, geo_bin: FileRef, geo_json: FileRef, };

export type Source = "Player" | "Plan" | "Model" | "Fallback" | "Rule";

export type Stance = "Hold" | "Demonstrate" | "Escort" | "Blockade";

export type Step = { when: Cond, do: Act, 
/**
 * Одноразовый шаг удаляется после исполнения; шаги резервной политики повторяемы.
 */
once: boolean, 
/**
 * Вероятность срабатывания в день, промилле; `None` — всегда.
 */
chance: number | null, };

export type StopReason = "Ended" | "Proposal" | { "Event": EventKind } | "CommitmentDue" | "OrderDone" | "Days";

export type Summary = { reason: EndReason, day: number, goal: GoalStatus, goal_label: string, checkpoints: Array<CheckpointView>, 
/**
 * Цепочка причин ключевого исхода, от исхода к истоку.
 */
chain: Array<string>, };

export type Term = { "Access": { grantor: string, party: string, node: string, exclusive: boolean, until: number, } } | { "Passage": { grantor: string, party: string, route: Array<string>, until: number, } } | { "Pay": { from: string, to: string, amount: number, every: number, times: number, } } | { "Guarantee": { guarantor: string, protected: string, trigger: GTrigger, window: number, until: number, } } | { "Refrain": { party: string, kind: OrderTag, target: string | null, until: number, } };

export type Tier = "Small" | "Large";

export type ToWorker = { "t": "Open", epoch: string, run_id: string | null, manifest: RuntimeManifest, proxy: string | null, steal: boolean, } | { "t": "Command" } & Command | { "t": "Preview", req_id: number, rev: number, intents: Array<OrderKind>, } | { "t": "MoveOptions", req_id: number, rev: number, asset_id: string, } | { "t": "Resync", have_rev: number, } | { "t": "Export", run_id: string, } | { "t": "Ping", n: number, } | { "t": "Visibility", hidden: boolean, } | { "t": "Metric", name: string, value: number, };

export type Trigger = { "Learned": { kind: EventKind, actor: string | null, } } | "Proposal" | "CommitmentAtRisk" | "StepInvalid" | "PlanExhausted" | { "Days": { n: number, } };

export type ViewSnapshot = { run_id: string, epoch: string, rev: number, day: number, date: string, phase: Phase, map: MapView, panel: { [key in string]: PanelItem }, reports: Array<Report>, };

export type ViewUpdate = { run_id: string, epoch: string, base_rev: number, rev: number, day: number, date: string, phase: Phase, map_patch: MapPatch, panel_patch: Array<Op<string, PanelItem>>, reports: Array<Report>, };

