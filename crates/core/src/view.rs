//! Проекция `PlayerView`: всё, что видит игрок, — функция его наблюдения; изменения —
//! разность двух представлений. Здесь только смысл, без цветов и длительностей.

use crate::goals::Summary;
use crate::ids::*;
use crate::model::*;
use crate::observe::Observation;
use crate::orders::{self, Action, MoveOptions, Preview, Reject};
use crate::pack::Pack;
use crate::reports::{date_ru, Report};
use crate::run::{DayInputs, DayRecord, Run, StopReason, STAGED_BIT};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

data! {
    pub enum Phase { AtStop, Advancing, Ended }

    #[serde(tag = "t")]
    pub enum Pos {
        Node { node: NodeId },
        /// На ребре на границе дня: пройдено `progress` из `days`.
        Edge { edge: EdgeId, from: NodeId, to: NodeId, progress: u8, days: u8 },
    }

    #[serde(tag = "t")]
    pub enum Marker {
        /// Свой актив — точно, с фактическим путём.
        Own { asset: AssetId, name: String, kind: AssetKind, pos: Pos, stance: Option<Stance>, free: bool, busy_until: Option<Day>, path: Vec<NodeId>, cargo: i32 },
        /// Чужой актив по последним сведениям.
        Foreign { asset: AssetId, name: String, owner: StateId, kind: AssetKind, node: NodeId, info_day: Day, stance: Option<Stance> },
        /// Неопознанное наблюдение.
        Unknown { node: NodeId, info_day: Day, kind: AssetKind },
        /// Событие в узле из `claims` — в день, когда игрок о нём узнал.
        Flash { node: NodeId, kind: EventKind, day: Day },
    }

    pub struct RegionView {
        /// Известный владелец; `None` — неизвестно.
        pub owner: Option<StateId>,
        pub info_day: Day,
        pub own: bool,
        pub war: bool,
        pub disputed: bool,
        /// Класс фронта: 0 — нет, 1 — граница воюющих, 2 — фронт игрока.
        pub front: u8,
        /// Давность сведений 0–3.
        pub age: u8,
    }

    pub struct MapView { pub regions: BTreeMap<RegionId, RegionView>, pub markers: BTreeMap<String, Marker> }

    pub struct GoalView { pub label: String, pub status: GoalStatus, pub until: String }

    pub struct MeView {
        pub state: StateId,
        pub name: String,
        pub scenario: String,
        pub resources: BTreeMap<Res, i32>,
        pub initiative: u8,
        pub capacity: u8,
        /// Инициатива и казна за вычетом резерва принятых приказов.
        pub initiative_left: u8,
        pub treasury_left: i32,
        pub mob_target: Option<(i32, Day)>,
        /// Цель партии; в песочнице её нет.
        pub goal: Option<GoalView>,
    }

    pub struct OrderView {
        pub id: u32,
        pub name: String,
        /// В планах этой остановки (ещё не исполняется).
        pub staged: bool,
        pub cost: u8,
        pub asset: Option<AssetId>,
        pub path: Vec<NodeId>,
        pub arrive: Option<String>,
    }

    pub struct ProposalView {
        pub id: u32,
        pub from: StateId,
        pub to: StateId,
        pub label: String,
        pub terms: Vec<String>,
        pub expires: String,
        pub status: PStatus,
        pub ultimatum: bool,
    }

    pub struct AgreementView { pub id: u32, pub parties: Vec<StateId>, pub label: String, pub terms: Vec<String>, pub status: AStatus, pub public: bool }

    pub struct CommitmentView { pub id: u32, pub text: String, pub mine: bool, pub other: StateId, pub due: Option<String>, pub against: Option<StateId> }

    pub struct PowerView {
        pub state: StateId,
        pub name: String,
        pub class: Class,
        pub persona: Option<String>,
        /// Известная ступень мобилизации и день сведений.
        pub mob: Option<(i32, Day)>,
        pub at_war_with_me: bool,
        pub wars: Vec<StateId>,
    }

    #[serde(tag = "t", content = "v")]
    pub enum PanelItem {
        Me(MeView),
        Order(OrderView),
        Proposal(ProposalView),
        Agreement(AgreementView),
        Commitment(CommitmentView),
        Power(PowerView),
        /// Доступные действия одного объекта.
        Actions(Vec<Action>),
        Stop(Vec<StopReason>),
        Summary(Summary),
    }

    pub struct PlayerView {
        pub day: Day,
        pub date: String,
        pub phase: Phase,
        pub map: MapView,
        pub panel: BTreeMap<String, PanelItem>,
        pub reports: Vec<Report>,
    }

    pub enum Op<K, V> { Upsert(K, V), Remove(K) }

    pub struct MapPatch { pub regions: Vec<Op<RegionId, RegionView>>, pub markers: Vec<Op<String, Marker>> }

    pub struct ViewSnapshot {
        pub run_id: String,
        pub epoch: String,
        pub rev: u32,
        pub day: Day,
        pub date: String,
        pub phase: Phase,
        pub map: MapView,
        pub panel: BTreeMap<String, PanelItem>,
        pub reports: Vec<Report>,
    }

    pub struct ViewUpdate {
        pub run_id: String,
        pub epoch: String,
        pub base_rev: u32,
        pub rev: u32,
        pub day: Day,
        pub date: String,
        pub phase: Phase,
        pub map_patch: MapPatch,
        pub panel_patch: Vec<Op<String, PanelItem>>,
        pub reports: Vec<Report>,
    }
}

fn order_tag_ru(t: OrderTag) -> &'static str {
    match t {
        OrderTag::Move => "перемещение",
        OrderTag::Engage => "атака",
        OrderTag::Propose => "предложение",
        OrderTag::Accept => "согласие",
        OrderTag::Reject => "отказ",
        OrderTag::Counter => "встречное предложение",
        OrderTag::Declare => "заявление",
        OrderTag::DeclareWar => "объявление войны",
        OrderTag::Mobilize => "мобилизация",
        OrderTag::Pay => "платёж",
        OrderTag::Inquire => "разведка",
        OrderTag::Cancel => "отмена",
        OrderTag::Blockade => "блокада",
        OrderTag::Demonstrate => "демонстрация силы",
        OrderTag::Escort => "эскорт",
    }
}

/// Условие соглашения одной строкой.
pub fn term_text(pack: &Pack, t: &Term) -> String {
    let st = |s: &StateId| pack.states[s.ix()].name.as_str();
    let nd = |n: &NodeId| pack.nodes[n.ix()].name.as_str();
    match t {
        Term::Access { grantor, party, node, exclusive, until } => {
            format!("Доступ{}: {} пускает {} — {}, до {}", if *exclusive { " (исключительный)" } else { "" }, st(grantor), st(party), nd(node), date_ru(pack, *until))
        }
        Term::Passage { grantor, party, route, until } => {
            format!("Проход: {} пропускает {} — {}, до {}", st(grantor), st(party), route.iter().map(nd).collect::<Vec<_>>().join(", "), date_ru(pack, *until))
        }
        Term::Pay { from, to, amount, every, times } if *times <= 1 || *every == 0 => format!("Платёж: {} → {}, {amount}", st(from), st(to)),
        Term::Pay { from, to, amount, every, times } => format!("Платежи: {} → {}, по {amount} каждые {every} дн., {times} раз", st(from), st(to)),
        Term::Guarantee { guarantor, protected, trigger, window, until } => {
            let trig = match trigger {
                GTrigger::War => "при войне",
                GTrigger::Blockade => "при блокаде",
                GTrigger::Incursion => "при нарушении границы",
            };
            format!("Гарантия: гарант — {}, под защитой — {}, {trig}; на ответ {window} дн., до {}", st(guarantor), st(protected), date_ru(pack, *until))
        }
        Term::Refrain { party, kind, target, until } => {
            let against = target.as_ref().map_or(String::new(), |t| format!(" (цель — {})", st(t)));
            format!("Отказ от действия «{}»{against}: {}, до {}", order_tag_ru(*kind), st(party), date_ru(pack, *until))
        }
    }
}

fn label_of(pack: &Pack, t: Option<TemplateId>, fallback: &str) -> String {
    t.map_or_else(|| fallback.to_string(), |t| pack.template(t).label.clone())
}

fn asset_key(pack: &Pack, a: AssetId) -> &str {
    pack.lex.name(Space::Asset, a.0)
}

/// Соседство регионов по графу: ребро соединяет узлы двух регионов.
fn region_links(pack: &Pack) -> BTreeSet<(RegionId, RegionId)> {
    pack.edges.iter().filter_map(|e| Some((pack.nodes[e.a.ix()].region?, pack.nodes[e.b.ix()].region?))).filter(|(a, b)| a != b).flat_map(|(a, b)| [(a, b), (b, a)]).collect()
}

fn map_view(pack: &Pack, obs: &Observation) -> MapView {
    let me = obs.actor;
    let links = region_links(pack);
    let army_in = |r: RegionId, enemy_of: StateId| {
        let inside = |n: NodeId| pack.nodes[n.ix()].region == Some(r);
        obs.contacts.iter().any(|c| c.kind == AssetKind::Army && inside(c.node) && obs.at_war(c.owner, enemy_of))
            || (obs.at_war(me, enemy_of) && obs.assets.iter().any(|a| a.kind == AssetKind::Army && inside(a.at)))
    };
    let regions = (0..pack.regions.len() as u16)
        .map(RegionId)
        .map(|r| {
            let (owner, info_day) = obs.regions[r.ix()];
            let own = owner == me;
            let front = links.iter().filter(|(a, _)| *a == r).map(|(_, b)| obs.regions[b.ix()].0).filter(|&o| obs.at_war(owner, o)).map(|o| if own || o == me { 2 } else { 1 }).max().unwrap_or(0);
            let age = match obs.day - info_day {
                _ if own => 0,
                i32::MIN..=7 => 0,
                8..=14 => 1,
                15..=30 => 2,
                _ => 3,
            };
            (r, RegionView { owner: Some(owner), info_day: if own { obs.day } else { info_day }, own, war: obs.at_war(me, owner), disputed: army_in(r, owner), front, age })
        })
        .collect();

    let mut markers = BTreeMap::new();
    for a in &obs.assets {
        let (pos, stance, path, busy) = match &a.status {
            Status::Moving { path, leg, progress, arrive, .. } => {
                let (from, to) = (path[*leg as usize], path[*leg as usize + 1]);
                let pos = match pack.edge_between(from, to).filter(|_| *progress > 0) {
                    Some(edge) => Pos::Edge { edge, from, to, progress: *progress, days: pack.edges[edge.ix()].days },
                    None => Pos::Node { node: a.at },
                };
                (pos, None, path[*leg as usize..].to_vec(), Some(*arrive))
            }
            Status::Stationed { stance } => (Pos::Node { node: a.at }, Some(*stance), Vec::new(), None),
            Status::Idle => (Pos::Node { node: a.at }, None, Vec::new(), None),
        };
        let name = pack.assets[a.id.ix()].name.clone();
        markers.insert(format!("a:{}", asset_key(pack, a.id)), Marker::Own { asset: a.id, name, kind: a.kind, pos, stance, free: obs.free(a), busy_until: busy, path, cargo: a.cargo });
    }
    for c in &obs.contacts {
        let name = pack.assets[c.asset.ix()].name.clone();
        markers.insert(format!("c:{}", asset_key(pack, c.asset)), Marker::Foreign { asset: c.asset, name, owner: c.owner, kind: c.kind, node: c.node, info_day: c.day, stance: c.stance });
    }
    for s in &obs.sightings {
        markers.insert(format!("u:{}", s.id), Marker::Unknown { node: s.node, info_day: s.day, kind: s.kind });
    }
    for k in obs.news.iter().filter(|k| k.received == obs.day && k.channel != Channel::Direct && pack.params.weights.contains_key(&k.kind)) {
        if let Some(node) = k.claims.node {
            markers.insert(format!("e:{}", k.id), Marker::Flash { node, kind: k.kind, day: k.received });
        }
    }
    MapView { regions, markers }
}

/// Собирает представление игрока. Действия есть только на остановке.
pub fn player_view(run: &Run, phase: Phase, stop: &[StopReason]) -> PlayerView {
    let pack = &run.pack;
    let obs = run.player_obs();
    let me = obs.actor;
    let staged = run.staged_kinds();
    let mut panel: BTreeMap<String, PanelItem> = BTreeMap::new();

    let acc = orders::validate_intent(pack, &obs, &staged).ok();
    let def = &pack.states[me.ix()];
    panel.insert(
        "me".into(),
        PanelItem::Me(MeView {
            state: me,
            name: def.name.clone(),
            scenario: pack.title.clone(),
            resources: obs.me.res.clone(),
            initiative: obs.me.init,
            capacity: def.capacity,
            initiative_left: acc.as_ref().map_or(obs.me.init, |a| a.initiative_left),
            treasury_left: acc.as_ref().map_or(obs.res(Res::Treasury), |a| a.treasury_left),
            mob_target: obs.me.mob_target,
            goal: pack.goal.as_ref().map(|g| GoalView { label: g.label.clone(), status: run.world.goal.clone(), until: date_ru(pack, g.day) }),
        }),
    );

    let infos = acc.map(|a| a.orders).unwrap_or_default();
    for (i, (id, kind)) in run.staged.iter().enumerate() {
        let info = infos.get(i);
        panel.insert(
            format!("order:{id}"),
            PanelItem::Order(OrderView {
                id: *id,
                name: orders::act_name(pack, &obs, kind),
                staged: true,
                cost: pack.cost(kind.tag()),
                asset: info.and_then(|x| x.asset),
                path: info.map(|x| x.path.clone()).unwrap_or_default(),
                arrive: info.and_then(|x| x.arrive).map(|d| date_ru(pack, d)),
            }),
        );
    }
    for o in &obs.orders {
        let (asset, path, arrive) = match o.kind {
            OrderKind::Move { asset, .. } => match obs.asset(asset).map(|a| &a.status) {
                Some(Status::Moving { path, leg, arrive, .. }) => (Some(asset), path[*leg as usize..].to_vec(), Some(date_ru(pack, *arrive))),
                _ => (Some(asset), Vec::new(), None),
            },
            OrderKind::Mobilize { .. } => (None, Vec::new(), obs.me.mob_target.map(|t| date_ru(pack, t.1))),
            _ => (None, Vec::new(), None),
        };
        debug_assert!(o.id & STAGED_BIT == 0);
        panel.insert(format!("order:{}", o.id), PanelItem::Order(OrderView { id: o.id, name: orders::act_name(pack, &obs, &o.kind), staged: false, cost: 0, asset, path, arrive }));
    }

    for p in &obs.proposals {
        // Завершённые предложения остаются в карточках неделю.
        if p.status != PStatus::Pending && obs.day - p.expires > 7 {
            continue;
        }
        panel.insert(
            format!("proposal:{}", p.id),
            PanelItem::Proposal(ProposalView {
                id: p.id,
                from: p.from,
                to: p.to,
                label: label_of(pack, p.template, if p.ultimatum { "Ультиматум" } else { "Предложение" }),
                terms: p.terms.iter().map(|t| term_text(pack, t)).collect(),
                expires: date_ru(pack, p.expires),
                status: p.status,
                ultimatum: p.ultimatum,
            }),
        );
    }
    for a in obs.agreements.iter().filter(|a| a.status != AStatus::Ended) {
        panel.insert(
            format!("agreement:{}", a.id),
            PanelItem::Agreement(AgreementView { id: a.id, parties: a.parties.clone(), label: label_of(pack, a.template, "Соглашение"), terms: a.terms.iter().map(|t| term_text(pack, t)).collect(), status: a.status, public: a.public }),
        );
    }
    for c in obs.commitments.iter().filter(|c| c.status == CStatus::Active) {
        let Some(a) = obs.agreements.iter().find(|a| a.id == c.agreement) else { continue };
        let mine = c.debtor == me;
        panel.insert(
            format!("commitment:{}", c.id),
            PanelItem::Commitment(CommitmentView {
                id: c.id,
                text: term_text(pack, &a.terms[c.term as usize]),
                mine,
                other: if mine { c.creditor } else { c.debtor },
                due: c.due.as_ref().map(|d| date_ru(pack, d.by)),
                against: c.due.as_ref().map(|d| d.against),
            }),
        );
    }
    for p in pack.personas.iter().filter(|p| p.state != me && p.active) {
        let s = p.state;
        let def = &pack.states[s.ix()];
        panel.insert(
            format!("power:{}", pack.lex.name(Space::State, s.0 as u16)),
            PanelItem::Power(PowerView {
                state: s,
                name: def.name.clone(),
                class: def.class,
                persona: Some(format!("{}, {}", p.name, p.office)),
                mob: obs.mob.get(&s).copied(),
                at_war_with_me: obs.at_war(me, s),
                wars: obs.wars.iter().filter_map(|&(a, b)| if a == s { Some(b) } else if b == s { Some(a) } else { None }).collect(),
            }),
        );
    }
    if phase == Phase::AtStop {
        let mut by_object: BTreeMap<String, Vec<Action>> = BTreeMap::new();
        for a in orders::menu(pack, &obs, &staged) {
            by_object.entry(a.object.clone()).or_default().push(a);
        }
        for (object, actions) in by_object {
            panel.insert(format!("actions:{object}"), PanelItem::Actions(actions));
        }
    }
    if !stop.is_empty() {
        panel.insert("stop".into(), PanelItem::Stop(stop.to_vec()));
    }
    if let Some(s) = run.summary() {
        panel.insert("summary".into(), PanelItem::Summary(s));
    }

    PlayerView { day: obs.day, date: pack.date(obs.day), phase, map: map_view(pack, &obs), panel, reports: run.current_reports() }
}

fn diff_map<K: Ord + Clone, V: PartialEq + Clone>(old: &BTreeMap<K, V>, new: &BTreeMap<K, V>) -> Vec<Op<K, V>> {
    let mut ops: Vec<Op<K, V>> = old.keys().filter(|k| !new.contains_key(k)).map(|k| Op::Remove(k.clone())).collect();
    ops.extend(new.iter().filter(|(k, v)| old.get(k) != Some(v)).map(|(k, v)| Op::Upsert(k.clone(), v.clone())));
    ops
}

/// Сеанс представления партии: ревизия и последнее отданное представление.
pub struct Session {
    pub run: Run,
    pub run_id: String,
    pub epoch: String,
    pub rev: u32,
    pub phase: Phase,
    pub stop: Vec<StopReason>,
    view: PlayerView,
}

impl Session {
    pub fn new(run: Run, run_id: String, rev: u32, stop: Vec<StopReason>) -> Session {
        let phase = if run.ended() { Phase::Ended } else { Phase::AtStop };
        let view = player_view(&run, phase.clone(), &stop);
        Session { run, run_id, epoch: String::new(), rev, phase, stop, view }
    }

    pub fn snapshot(&self) -> ViewSnapshot {
        let v = self.view.clone();
        ViewSnapshot { run_id: self.run_id.clone(), epoch: self.epoch.clone(), rev: self.rev, day: v.day, date: v.date, phase: v.phase, map: v.map, panel: v.panel, reports: v.reports }
    }

    /// Пересчитать представление. Ревизия растёт, только если изменилось то, что влияет на решения игрока.
    pub fn refresh(&mut self) -> Option<ViewUpdate> {
        let new = player_view(&self.run, self.phase.clone(), &self.stop);
        if new == self.view {
            return None;
        }
        let old = std::mem::replace(&mut self.view, new);
        let new = &self.view;
        let base_rev = self.rev;
        self.rev += 1;
        Some(ViewUpdate {
            run_id: self.run_id.clone(),
            epoch: self.epoch.clone(),
            base_rev,
            rev: self.rev,
            day: new.day,
            date: new.date.clone(),
            phase: new.phase.clone(),
            map_patch: MapPatch { regions: diff_map(&old.map.regions, &new.map.regions), markers: diff_map(&old.map.markers, &new.map.markers) },
            panel_patch: diff_map(&old.panel, &new.panel),
            // Новые и изменившиеся донесения; интерфейс заменяет по `report_id`.
            reports: new.reports.iter().filter(|r| !old.reports.contains(r)).cloned().collect(),
        })
    }

    /// Принять пакет намерений: приказы в планах, резервы учтены, недоступные действия убраны.
    pub fn commit(&mut self, intents: &[OrderKind]) -> Result<Option<ViewUpdate>, Reject> {
        self.run.commit(intents)?;
        Ok(self.refresh())
    }

    /// Отмена: приказ из планов убирается и освобождает резерв; приказ мира отменяется намерением `Cancel`.
    pub fn cancel(&mut self, order_id: u32) -> Result<Option<ViewUpdate>, Reject> {
        if order_id & STAGED_BIT == 0 {
            return self.commit(&[OrderKind::Cancel { order: order_id }]);
        }
        if !self.run.uncommit(order_id) {
            return Err(Reject { index: 0, reason: crate::orders::Reason::Unavailable });
        }
        Ok(self.refresh())
    }

    pub fn preview(&self, intents: &[OrderKind]) -> Preview {
        self.run.preview(intents)
    }

    pub fn move_options(&self, asset: AssetId) -> MoveOptions {
        orders::move_options(&self.run.pack, &self.run.player_obs(), &self.run.staged_kinds(), asset)
    }

    /// Разрешить день; представление обновляется в фазе промотки.
    pub fn step(&mut self, inputs: &DayInputs) -> (DayRecord, Option<ViewUpdate>) {
        self.phase = Phase::Advancing;
        self.stop.clear();
        let rec = self.run.step(inputs);
        (rec, self.refresh())
    }

    /// Восстановление записанного состояния хода: приказы остановки на месте, фаза и ревизия — как записаны.
    pub fn resume(&mut self, phase: Phase, stop: Vec<StopReason>, intents: &[OrderKind], rev: u32) {
        for k in intents {
            let _ = self.run.commit(std::slice::from_ref(k));
        }
        self.phase = if self.run.ended() { Phase::Ended } else { phase };
        self.stop = stop;
        self.view = player_view(&self.run, self.phase.clone(), &self.stop);
        self.rev = rev.max(self.rev);
    }

    pub fn set_phase(&mut self, phase: Phase) -> Option<ViewUpdate> {
        self.phase = phase;
        self.refresh()
    }

    /// Остановка: донесения интервала зафиксированы, действия снова доступны.
    pub fn stop_here(&mut self, reasons: Vec<StopReason>) -> Option<ViewUpdate> {
        self.run.mark_stop();
        self.stop = reasons;
        self.phase = if self.run.ended() { Phase::Ended } else { Phase::AtStop };
        self.refresh()
    }
}
