//! Типы мира, знания и приказов. Только данные; логика — в соседних модулях.

use crate::ids::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

macro_rules! data {
    ($($item:item)*) => {$(
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[cfg_attr(feature = "ts", derive(ts_rs::TS))]
        $item
    )*};
}
macro_rules! tag {
    ($($item:item)*) => {$(
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        #[cfg_attr(feature = "ts", derive(ts_rs::TS))]
        $item
    )*};
}
pub(crate) use data;

tag! {
    pub enum Class { GreatPower, Minor }
    pub enum Res { Treasury, Mobilization, Pressure, Food }
    #[serde(rename_all = "lowercase")]
    pub enum Mode { Rail, Sea }
    pub enum AssetKind { Fleet, Flotilla, Army, Convoy }
    pub enum Stance { Hold, Demonstrate, Escort, Blockade }
    /// Вид приказа без параметров: таблица стоимости, `Refrain`, действия гаранта.
    /// `Blockade`, `Demonstrate`, `Escort` — `Move` с такой стойкой.
    pub enum OrderTag {
        Move, Engage, Propose, Accept, Reject, Counter, Declare, DeclareWar, Mobilize, Pay, Inquire, Cancel,
        Blockade, Demonstrate, Escort,
    }
    pub enum DeclKind { Note, Ultimatum, Guarantee, Denial }
    pub enum GTrigger { War, Blockade, Incursion }
    pub enum PStatus { Pending, Accepted, Rejected, Countered, Expired, Withdrawn }
    pub enum AStatus { Active, Violated, Ended }
    pub enum CStatus { Active, Fulfilled, Broken, Expired }
    pub enum OStatus { Active, Done, Failed, Cancelled }
    pub enum Source { Player, Plan, Model, Fallback, Rule }
    pub enum Channel { Direct, Seen, Embassy, Telegraph, Press, Leak, Inquiry }
    pub enum EventKind {
        Arrived, Incursion, Demonstration, BlockadeSet, Blocked, Battle, AssetLost, Occupied,
        HostilitiesOpened, WarDeclared, EngageFailed, OrderFailed,
        Proposed, ProposalAccepted, ProposalRejected, ProposalCountered, ProposalExpired, ProposalWithdrawn,
        AgreementMade, AgreementConflict, Declared, ThreatUnanswered,
        MobilizationStarted, MobilizationChanged, Paid, PaymentFailed,
        CommitmentDue, Fulfilled, Breach, Expired,
        UpkeepUnpaid, CabinetDemand, GovernmentCrisis, CargoLoaded, CargoUnloaded, Inquiry,
        GoalAchieved, GoalFailed,
    }
    pub enum RuleTag { Start, Interaction, Schedule, Deadline, Upkeep, Threshold, Trade, Drift, Goal }
    pub enum MemKind { Grievance, Favor, Promise, Breach }
    pub enum CanonState { Matches, Contradicts, Undetermined }
    /// Суждение агента о державе: перечисление, а не свободный текст.
    pub enum Prop { Hostile, Friendly, Bluffing, Resolved, WillAttack, WillYield, Unreliable, Reliable }
}

impl AssetKind {
    pub fn mode(self) -> Mode {
        if self == AssetKind::Army { Mode::Rail } else { Mode::Sea }
    }
    pub fn warship(self) -> bool {
        matches!(self, AssetKind::Fleet | AssetKind::Flotilla)
    }
    pub fn bit(self) -> u8 {
        1 << self as u8
    }
    pub fn stances(self) -> &'static [Stance] {
        match self {
            AssetKind::Convoy => &[Stance::Hold],
            AssetKind::Army => &[Stance::Hold, Stance::Demonstrate],
            _ => &[Stance::Hold, Stance::Demonstrate, Stance::Escort, Stance::Blockade],
        }
    }
}

impl EventKind {
    /// Событие в узле, которое видит свидетель с активом в этом узле.
    pub fn physical(self) -> bool {
        use EventKind::*;
        matches!(self, Arrived | Incursion | Demonstration | BlockadeSet | Blocked | Battle | AssetLost | Occupied)
    }
    /// Поля, которые может исказить доставка: (узел, масштаб).
    pub fn distortable(self) -> (bool, bool) {
        use EventKind::*;
        match self {
            Arrived | Incursion | Demonstration | BlockadeSet => (true, false),
            MobilizationStarted | MobilizationChanged | Battle => (false, true),
            _ => (false, false),
        }
    }
}

data! {
    pub enum Term {
        Access { grantor: StateId, party: StateId, node: NodeId, #[serde(default)] exclusive: bool, until: Day },
        Passage { grantor: StateId, party: StateId, route: Vec<NodeId>, until: Day },
        /// `every == 0` — разовый платёж; иначе `times` платежей через `every` дней.
        Pay { from: StateId, to: StateId, amount: i32, #[serde(default)] every: u8, #[serde(default = "one")] times: u8 },
        Guarantee { guarantor: StateId, protected: StateId, trigger: GTrigger, window: u8, until: Day },
        Refrain { party: StateId, kind: OrderTag, #[serde(default)] target: Option<StateId>, until: Day },
    }

    pub enum Claim {
        /// Ультиматум: принять условия до срока.
        Demand { terms: Vec<Term> },
        /// Односторонняя гарантия: условие `Term::Guarantee`.
        Pledge { term: Term },
        Support { of: StateId },
        Warning { kind: OrderTag, #[serde(default)] target: Option<StateId> },
        NoIntent { kind: OrderTag, #[serde(default)] target: Option<StateId> },
        Deny { kind: EventKind },
    }

    pub enum OrderKind {
        Move { asset: AssetId, to: NodeId, stance: Stance },
        Engage { asset: AssetId, target: AssetId },
        Propose { to: StateId, terms: Vec<Term>, expires: Day, #[serde(default)] template: Option<TemplateId> },
        Accept { proposal: ProposalId },
        Reject { proposal: ProposalId },
        Counter { proposal: ProposalId, terms: Vec<Term>, expires: Day, #[serde(default)] template: Option<TemplateId> },
        Declare { to: StateId, kind: DeclKind, claim: Claim, #[serde(default)] deadline: Option<Day>, #[serde(default)] template: Option<TemplateId> },
        DeclareWar { target: StateId },
        Mobilize { delta: i8 },
        Pay { to: StateId, amount: i32 },
        Inquire { target: StateId },
        Cancel { order: OrderId },
    }

    pub struct Intent { pub actor: StateId, pub kind: OrderKind }

    pub enum Status {
        Idle,
        /// `path[leg] → path[leg+1]` — текущее ребро, `progress` — пройдено дней на нём.
        Moving { path: Vec<NodeId>, leg: u16, progress: u8, arrive: Day, stance: Stance, order: OrderId },
        Stationed { stance: Stance },
    }

    pub struct Asset {
        pub id: AssetId,
        pub kind: AssetKind,
        pub owner: StateId,
        pub base: NodeId,
        pub at: NodeId,
        pub status: Status,
        pub reserved_until: Day,
        pub cargo: i32,
        pub alive: bool,
    }

    pub struct Order { pub id: OrderId, pub actor: StateId, pub kind: OrderKind, pub day: Day, pub status: OStatus, pub source: Source }

    pub struct Proposal {
        pub id: ProposalId,
        pub from: StateId,
        pub to: StateId,
        pub terms: Vec<Term>,
        pub created: Day,
        pub expires: Day,
        pub status: PStatus,
        pub template: Option<TemplateId>,
        pub ultimatum: bool,
        pub counter_of: Option<ProposalId>,
        pub order: OrderId,
    }

    pub struct Agreement {
        pub id: AgreementId,
        pub parties: Vec<StateId>,
        pub terms: Vec<Term>,
        pub since: Day,
        pub status: AStatus,
        pub public: bool,
        pub template: Option<TemplateId>,
        /// Приказы сторон, создавшие соглашение: `Cancel` такого приказа отменяет платежи стороны.
        pub orders: Vec<OrderId>,
    }

    pub struct Due { pub by: Day, pub against: StateId, pub node: Option<NodeId> }

    pub struct Commitment {
        pub id: CommitmentId,
        pub agreement: AgreementId,
        pub term: u8,
        pub debtor: StateId,
        pub creditor: StateId,
        pub status: CStatus,
        pub paid: u8,
        pub due: Option<Due>,
    }

    pub struct Hostility { pub a: StateId, pub b: StateId, pub since: Day }

    pub enum Visibility { Public, Private(Vec<StateId>), Secret }

    pub enum Cause { Order(OrderId), Event(EventId), Rule(RuleTag), Decision(StateId, Day) }

    /// Поля события. Они же — `claims` после доставки, возможно искажённые.
    #[derive(Default)]
    pub struct Facts {
        pub actor: Option<StateId>,
        pub target: Option<StateId>,
        pub node: Option<NodeId>,
        pub asset: Option<AssetId>,
        pub other: Option<AssetId>,
        pub amount: i32,
        /// Ссылка: предложение, соглашение, обязательство, приказ или шаблон — по виду события.
        pub refid: u32,
    }

    pub struct Event { pub id: EventId, pub day: Day, pub kind: EventKind, pub vis: Visibility, pub causes: Vec<Cause>, pub f: Facts }

    pub struct Threat { pub issuer: StateId, pub target: StateId, pub due: Day, pub event: EventId }

    pub struct StateDyn {
        pub res: BTreeMap<Res, i32>,
        pub init: u8,
        pub regen_clock: u8,
        /// Идущий переход мобилизации: (целевая ступень, день завершения).
        pub mob_target: Option<(i32, Day)>,
        pub persona: Option<PersonaId>,
    }

    pub struct Ending { pub day: Day, pub reason: EndReason, pub event: Option<EventId> }
    pub enum EndReason { EndEvent, GoalAchieved, GoalFailed, Horizon, Crisis }
    pub enum GoalStatus { Open, Achieved(Day), Failed(Day) }

    pub struct World {
        /// Следующий день к разрешению; дни `0..day` уже разрешены.
        pub day: Day,
        pub states: Vec<StateDyn>,
        pub region_owner: Vec<StateId>,
        pub assets: Vec<Asset>,
        pub orders: BTreeMap<OrderId, Order>,
        pub proposals: BTreeMap<ProposalId, Proposal>,
        pub agreements: BTreeMap<AgreementId, Agreement>,
        pub commitments: BTreeMap<CommitmentId, Commitment>,
        pub hostilities: Vec<Hostility>,
        pub events: Vec<Event>,
        pub threats: Vec<Threat>,
        pub goal: GoalStatus,
        /// Состояния контрольных точек канона; фиксируются в день точки.
        pub canon: Vec<CanonState>,
        pub ended: Option<Ending>,
        pub next_id: u32,
    }

    // ---- Minds

    pub struct Knowledge {
        pub id: KnowledgeId,
        pub event: EventId,
        pub kind: EventKind,
        pub event_day: Day,
        pub received: Day,
        pub channel: Channel,
        pub claims: Facts,
    }

    pub struct Delivery { pub event: EventId, pub due: Day, pub channel: Channel, pub claims: Facts }

    pub struct Contact {
        pub asset: AssetId,
        pub owner: StateId,
        pub kind: AssetKind,
        pub node: NodeId,
        pub day: Day,
        pub stance: Option<Stance>,
        pub moving: bool,
    }

    pub struct Sighting { pub id: u32, pub node: NodeId, pub day: Day, pub kind: AssetKind }

    pub struct Belief { pub about: StateId, pub prop: Prop, pub confidence: u8, pub sources: Vec<KnowledgeId>, pub reason: String }

    pub struct Memory { pub about: StateId, pub kind: MemKind, pub knowledge: KnowledgeId, pub weight: i32, pub day: Day }

    pub enum Cond {
        Always,
        Day { from: Day },
        /// Знает о событии вида `kind`; `within` — получено не раньше стольких дней назад.
        Learned {
            kind: EventKind,
            #[serde(default)] actor: Option<StateId>,
            #[serde(default)] target: Option<StateId>,
            #[serde(default)] node: Option<NodeId>,
            #[serde(default)] refid: Option<TemplateId>,
            #[serde(default)] within: Option<u8>,
        },
        /// Есть предложение, ждущее моего ответа.
        Pending { #[serde(default)] template: Option<TemplateId>, #[serde(default)] from: Option<StateId> },
        War { a: StateId, b: StateId },
        Mob { state: StateId, min: i32 },
        ResBelow { res: Res, value: i32 },
        AssetAt { asset: AssetId, node: NodeId },
        ContactAt { owner: StateId, node: NodeId },
        Agreed { with: StateId, #[serde(default)] template: Option<TemplateId> },
        /// Моё обязательство гаранта ждёт действия.
        Due,
        Cargo { asset: AssetId, min: i32 },
        Not(Box<Cond>),
        All(Vec<Cond>),
        Any(Vec<Cond>),
    }

    pub enum Trigger {
        Learned { kind: EventKind, #[serde(default)] actor: Option<StateId> },
        Proposal,
        CommitmentAtRisk,
        StepInvalid,
        PlanExhausted,
        Days { n: u8 },
    }

    pub enum Act {
        Order(OrderKind),
        Offer(TemplateId),
        Declare(TemplateId),
        Respond { #[serde(default)] template: Option<TemplateId>, #[serde(default)] from: Option<StateId>, accept: bool },
        CounterWith { template: TemplateId, with: TemplateId },
        /// Атаковать известный актив державы `enemy` в узле своего актива.
        EngageAt { asset: AssetId, enemy: StateId },
        /// Исполнить свою гарантию: объявить войну агрессору.
        Honor,
    }

    pub struct Step {
        pub when: Cond,
        #[serde(rename = "do")]
        pub act: Act,
        /// Одноразовый шаг удаляется после исполнения; шаги резервной политики повторяемы.
        #[serde(default)]
        pub once: bool,
        /// Вероятность срабатывания в день, промилле; `None` — всегда.
        #[serde(default)]
        pub chance: Option<u16>,
    }

    #[derive(Default)]
    pub struct Plan { pub goal: String, pub steps: Vec<Step>, pub review_if: Vec<Trigger>, pub since: Day, pub reason: String }

    #[derive(Default)]
    pub struct Mind {
        pub knowledge: Vec<Knowledge>,
        pub inbox: Vec<Delivery>,
        pub contacts: BTreeMap<AssetId, Contact>,
        /// Неопознанные наблюдения; ключ — истинный актив, в наблюдение он не попадает.
        pub sightings: BTreeMap<AssetId, Sighting>,
        pub regions: Vec<(StateId, Day)>,
        pub mob: BTreeMap<StateId, (i32, Day)>,
        pub wars: BTreeSet<(StateId, StateId)>,
        pub proposals: BTreeMap<ProposalId, PStatus>,
        pub agreements: BTreeMap<AgreementId, AStatus>,
        /// До какого дня нельзя снова предлагать этой державе (пауза после отказа).
        pub pause: BTreeMap<StateId, Day>,
        pub beliefs: Vec<Belief>,
        pub memories: Vec<Memory>,
        pub plan: Plan,
        /// Сработавшие триггеры пересмотра на следующий день.
        pub review: Vec<Trigger>,
        pub last_review: Day,
        pub next_id: u32,
    }

    #[derive(Default)]
    pub struct Minds { pub actors: Vec<Mind> }
}

fn one() -> u8 {
    1
}

pub fn pair(a: StateId, b: StateId) -> (StateId, StateId) {
    if a <= b { (a, b) } else { (b, a) }
}

impl Term {
    pub fn debtor(&self) -> StateId {
        match *self {
            Term::Access { grantor, .. } | Term::Passage { grantor, .. } => grantor,
            Term::Pay { from, .. } => from,
            Term::Guarantee { guarantor, .. } => guarantor,
            Term::Refrain { party, .. } => party,
        }
    }
    pub fn creditor(&self, parties: &[StateId]) -> StateId {
        let d = self.debtor();
        match *self {
            Term::Access { party, .. } | Term::Passage { party, .. } => party,
            Term::Pay { to, .. } => to,
            Term::Guarantee { protected, .. } => protected,
            Term::Refrain { .. } => parties.iter().copied().find(|&p| p != d).unwrap_or(d),
        }
    }
    pub fn until(&self) -> Option<Day> {
        match *self {
            Term::Access { until, .. } | Term::Passage { until, .. } | Term::Guarantee { until, .. } | Term::Refrain { until, .. } => Some(until),
            Term::Pay { .. } => None,
        }
    }
    /// Шаблон хранит сроки относительно дня создания; сдвиг делает их абсолютными.
    pub fn shifted(&self, day: Day) -> Term {
        let mut t = self.clone();
        match &mut t {
            Term::Access { until, .. } | Term::Passage { until, .. } | Term::Guarantee { until, .. } | Term::Refrain { until, .. } => *until += day,
            Term::Pay { .. } => {}
        }
        t
    }
    /// Державы, упомянутые в условии.
    pub fn states(&self) -> [StateId; 2] {
        match *self {
            Term::Access { grantor, party, .. } | Term::Passage { grantor, party, .. } => [grantor, party],
            Term::Pay { from, to, .. } => [from, to],
            Term::Guarantee { guarantor, protected, .. } => [guarantor, protected],
            Term::Refrain { party, target, .. } => [party, target.unwrap_or(party)],
        }
    }
}

impl OrderKind {
    pub fn tag(&self) -> OrderTag {
        match self {
            OrderKind::Move { .. } => OrderTag::Move,
            OrderKind::Engage { .. } => OrderTag::Engage,
            OrderKind::Propose { .. } => OrderTag::Propose,
            OrderKind::Accept { .. } => OrderTag::Accept,
            OrderKind::Reject { .. } => OrderTag::Reject,
            OrderKind::Counter { .. } => OrderTag::Counter,
            OrderKind::Declare { .. } => OrderTag::Declare,
            OrderKind::DeclareWar { .. } => OrderTag::DeclareWar,
            OrderKind::Mobilize { .. } => OrderTag::Mobilize,
            OrderKind::Pay { .. } => OrderTag::Pay,
            OrderKind::Inquire { .. } => OrderTag::Inquire,
            OrderKind::Cancel { .. } => OrderTag::Cancel,
        }
    }
    /// Совпадает ли приказ с видом из `Refrain` или из списка действий гаранта.
    pub fn is(&self, tag: OrderTag) -> bool {
        match (self, tag) {
            (OrderKind::Move { stance, .. }, OrderTag::Blockade) => *stance == Stance::Blockade,
            (OrderKind::Move { stance, .. }, OrderTag::Demonstrate) => *stance == Stance::Demonstrate,
            (OrderKind::Move { stance, .. }, OrderTag::Escort) => *stance == Stance::Escort,
            (OrderKind::Mobilize { delta }, OrderTag::Mobilize) => *delta > 0,
            _ => self.tag() == tag,
        }
    }
}

impl World {
    pub fn at_war(&self, a: StateId, b: StateId) -> bool {
        let (a, b) = pair(a, b);
        self.hostilities.iter().any(|h| h.a == a && h.b == b)
    }
    pub fn res(&self, s: StateId, r: Res) -> i32 {
        self.states[s.ix()].res.get(&r).copied().unwrap_or(0)
    }
    pub fn fresh_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }
}
