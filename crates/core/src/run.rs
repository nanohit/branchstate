//! Партия: состояние ядра, шаг дня, остановки, журнал, воспроизведение, снимки.

use crate::agents::{self, DecideRequest, Tier};
use crate::goals::{self, Summary};
use crate::ids::*;
use crate::knowledge;
use crate::model::*;
use crate::observe::{observe, Observation};
use crate::orders::{self, Reject};
use crate::pack::Pack;
use crate::reports::{self, Report};
use crate::resolve::{self, Batch};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::rc::Rc;

data! {
    /// Решение актора, которому сегодня нужен пересмотр: ответ модели или резервная политика.
    pub enum ActorInput { Model(serde_json::Value), Fallback }

    /// Все внешние входы дня (L1): намерения игрока и результаты операций.
    #[derive(Default)]
    pub struct DayInputs {
        #[serde(default)] pub player: Vec<OrderKind>,
        #[serde(default)] pub actors: BTreeMap<StateId, ActorInput>,
    }

    pub enum StopReason {
        Ended,
        /// Адресованное игроку предложение.
        Proposal,
        /// Событие, помеченное сценарием как требующее решения.
        Event(EventKind),
        /// Срок своего обязательства наступает завтра.
        CommitmentDue,
        /// Завершился свой приказ.
        OrderDone,
        /// Прошло `stop_after_days` дней.
        Days,
    }

    /// Запись дня в журнале. `sources` — чем на самом деле решал каждый актор.
    pub struct DayRecord {
        pub day: Day,
        pub inputs: DayInputs,
        pub hash: String,
        pub sources: BTreeMap<StateId, Source>,
        /// Отказы проверки ответов моделей.
        pub rejected: BTreeMap<StateId, String>,
        /// Остановки после дня: жёсткие прерывают и «Ждать N дней», мягкие — только «Дальше».
        pub hard: Vec<StopReason>,
        pub soft: Vec<StopReason>,
    }
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    seed: u64,
    world: World,
    minds: Minds,
    report_from: Day,
    last_stop: Day,
    reports: Vec<Report>,
}

pub struct Run {
    pub pack: Rc<Pack>,
    pub seed: u64,
    pub world: World,
    pub minds: Minds,
    /// Принятый пакет приказов этой остановки: (локальный id, намерение).
    pub staged: Vec<(u32, OrderKind)>,
    staged_seq: u32,
    /// Донесения прошлых остановок и день, с которого копится текущая.
    pub reports: Vec<Report>,
    pub report_from: Day,
    pub last_stop: Day,
}

/// Id приказа в планах: старший бит отличает его от приказов мира.
pub const STAGED_BIT: u32 = 1 << 31;
const REPORTS_KEPT: usize = 40;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Run {
    pub fn new(pack: Rc<Pack>, seed: u64) -> Run {
        let world = resolve::new_world(&pack);
        let minds = knowledge::new_minds(&pack, &world);
        Run { pack, seed, world, minds, staged: Vec::new(), staged_seq: 0, reports: Vec::new(), report_from: 0, last_stop: 0 }
    }

    pub fn day(&self) -> Day {
        self.world.day
    }

    pub fn ended(&self) -> bool {
        self.world.ended.is_some()
    }

    pub fn observation(&self, actor: StateId) -> Observation {
        observe(&self.world, &self.minds, actor)
    }

    pub fn player_obs(&self) -> Observation {
        self.observation(self.pack.player)
    }

    /// Хэш состояния: blake3 от канонической сериализации postcard. В него не входят ревизии
    /// представления, планы интерфейса и часы ожидания.
    pub fn hash(&self) -> String {
        let bytes = postcard::to_allocvec(&(&self.world, &self.minds)).expect("postcard");
        hex(blake3::hash(&bytes).as_bytes())
    }

    pub fn snapshot(&self) -> Vec<u8> {
        postcard::to_allocvec(&(self.seed, &self.world, &self.minds, self.report_from, self.last_stop, &self.reports)).expect("postcard")
    }

    pub fn restore(pack: Rc<Pack>, bytes: &[u8]) -> Result<Run, String> {
        let s: Snapshot = postcard::from_bytes(bytes).map_err(|e| e.to_string())?;
        Ok(Run { pack, seed: s.seed, world: s.world, minds: s.minds, staged: Vec::new(), staged_seq: 0, reports: s.reports, report_from: s.report_from, last_stop: s.last_stop })
    }

    // ---- приказы игрока на остановке

    pub fn staged_kinds(&self) -> Vec<OrderKind> {
        self.staged.iter().map(|(_, k)| k.clone()).collect()
    }

    /// Принять пакет намерений поверх уже принятых: проверка по наблюдению на эту остановку.
    pub fn commit(&mut self, intents: &[OrderKind]) -> Result<(), Reject> {
        let mut batch = self.staged_kinds();
        let base = batch.len() as u32;
        batch.extend(intents.iter().cloned());
        orders::validate_intent(&self.pack, &self.player_obs(), &batch).map_err(|r| Reject { index: r.index.saturating_sub(base), reason: r.reason })?;
        for k in intents {
            self.staged_seq += 1;
            self.staged.push((STAGED_BIT | self.staged_seq, k.clone()));
        }
        Ok(())
    }

    /// Убрать приказ из планов. Приказ мира отменяется намерением `Cancel` через `commit`.
    pub fn uncommit(&mut self, id: u32) -> bool {
        let n = self.staged.len();
        self.staged.retain(|(i, _)| *i != id);
        self.staged.len() != n
    }

    pub fn preview(&self, intents: &[OrderKind]) -> orders::Preview {
        let mut batch = self.staged_kinds();
        let base = batch.len();
        batch.extend(intents.iter().cloned());
        let mut p = orders::preview(&self.pack, &self.player_obs(), &batch);
        p.orders.drain(..base.min(p.orders.len()));
        if let Some(r) = &mut p.reject {
            r.index = r.index.saturating_sub(base as u32);
        }
        p
    }

    /// Намерения игрока от резервной политики его персонажа: автопрогоны и автопилот.
    pub fn autopilot(&self) -> Vec<OrderKind> {
        let player = self.pack.player;
        match self.world.states[player.ix()].persona {
            Some(p) => agents::continue_plan(&self.pack, &self.player_obs(), &knowledge::default_plan(&self.pack, p, self.day()), self.seed).intents,
            None => Vec::new(),
        }
    }

    // ---- день

    /// Акторы, которым сегодня нужен пересмотр, и их запросы `decide`.
    pub fn needs(&self) -> Vec<DecideRequest> {
        let player = self.pack.player;
        self.pack
            .state_ids()
            .filter(|&s| s != player && !self.minds.actors[s.ix()].review.is_empty())
            .filter_map(|s| {
                let persona = self.world.states[s.ix()].persona?;
                let obs = self.observation(s);
                if !agents::can_act(&self.pack, &obs) {
                    return None;
                }
                let m = &self.minds.actors[s.ix()];
                // Крупная модель — когда игрок адресат или цель.
                let about_player = obs.proposals.iter().any(|p| p.from == player && p.to == s && p.status == PStatus::Pending)
                    || obs.news.iter().any(|k| k.received == obs.day && (k.claims.actor == Some(player) || k.claims.target == Some(player)));
                let obs_hash = hex(&blake3::hash(&postcard::to_allocvec(&obs).expect("postcard")).as_bytes()[..16]);
                Some(DecideRequest { actor: s, persona, tier: if about_player { Tier::Large } else { Tier::Small }, obs_hash, brief: agents::brief(&self.pack, &obs, &m.review) })
            })
            .collect()
    }

    /// Разрешить один день. Порядок прихода входов не влияет на результат: они собраны
    /// в словарь по актору и применяются в каноническом порядке.
    pub fn step(&mut self, inputs: &DayInputs) -> DayRecord {
        let pack = self.pack.clone();
        let day = self.world.day;
        let player = pack.player;
        let mut batches: BTreeMap<StateId, Batch> = BTreeMap::new();
        let mut sources = BTreeMap::new();
        let mut rejected = BTreeMap::new();

        // 1–2. Наблюдения на начало дня и намерения каждого актора по своему наблюдению.
        for s in pack.state_ids() {
            let obs = self.observation(s);
            if s == player {
                // Пакет игрока проверен при приёме; повторная проверка отсекает намерения чужого журнала.
                let mut ok: Vec<OrderKind> = Vec::new();
                for k in &inputs.player {
                    ok.push(k.clone());
                    if orders::validate_intent(&pack, &obs, &ok).is_err() {
                        ok.pop();
                    }
                }
                batches.insert(s, Batch { source: Source::Player, intents: ok });
                continue;
            }
            let Some(persona) = self.world.states[s.ix()].persona else { continue };
            let m = &mut self.minds.actors[s.ix()];
            // Пересмотр откладывается, пока актору нечем действовать: меню пусто — решать нечего.
            let review = !m.review.is_empty() && agents::can_act(&pack, &obs);
            let (source, intents) = if review {
                m.review.clear();
                m.last_review = day;
                let applied = match inputs.actors.get(&s) {
                    Some(ActorInput::Model(raw)) => agents::apply_model(&pack, &obs, raw.clone()).map_err(|e| {
                        rejected.insert(s, e);
                    }),
                    _ => Err(()),
                };
                match applied {
                    Ok(a) => {
                        m.plan = a.plan;
                        m.beliefs = a.beliefs;
                        (Source::Model, a.intents)
                    }
                    Err(()) => {
                        let out = agents::continue_plan(&pack, &obs, &knowledge::default_plan(&pack, persona, day), self.seed);
                        m.plan = out.plan;
                        (Source::Fallback, out.intents)
                    }
                }
            } else {
                let out = agents::continue_plan(&pack, &obs, &m.plan, self.seed);
                m.plan = out.plan;
                for t in out.triggers {
                    if !m.review.contains(&t) {
                        m.review.push(t);
                    }
                }
                (Source::Plan, out.intents)
            };
            sources.insert(s, source);
            batches.insert(s, Batch { source, intents });
        }

        // 3–7. Факты меняет только `resolve`.
        let first_event = self.world.events.len();
        let personas: Vec<Option<PersonaId>> = self.world.states.iter().map(|s| s.persona).collect();
        resolve::resolve_day(&pack, &mut self.world, self.seed, &batches);
        // 8. Доставка сведений и триггеры пересмотра.
        knowledge::deliver_day(&pack, &self.world, &mut self.minds, self.seed, day);
        // Сменившийся персонаж приходит без плана и обещаний предшественника.
        for s in pack.state_ids() {
            if let (Some(p), true) = (self.world.states[s.ix()].persona, self.world.states[s.ix()].persona != personas[s.ix()]) {
                let m = &mut self.minds.actors[s.ix()];
                m.plan = knowledge::default_plan(&pack, p, day + 1);
                m.memories.retain(|x| x.kind != MemKind::Promise);
                m.beliefs.clear();
                m.review.clear();
            }
        }
        self.staged.clear();

        let (hard, soft) = self.stops(day, first_event);
        DayRecord { day, inputs: inputs.clone(), hash: self.hash(), sources, rejected, hard, soft }
    }

    /// Остановки после дня `day`. Они ничего не меняют в мире (L12).
    fn stops(&self, day: Day, first_event: usize) -> (Vec<StopReason>, Vec<StopReason>) {
        let pack = &self.pack;
        let player = pack.player;
        let m = &self.minds.actors[player.ix()];
        let mut hard = Vec::new();
        let mut soft = Vec::new();
        if self.world.ended.is_some() {
            hard.push(StopReason::Ended);
        }
        // Прямое следствие собственного приказа остановки не требует: игрок сам его отдал.
        let own_order = |k: &Knowledge| {
            self.world.events[k.event as usize].causes.iter().any(|c| matches!(c, Cause::Order(o) if self.world.orders.get(o).is_some_and(|o| o.actor == player)))
        };
        for k in m.knowledge.iter().filter(|k| k.received == day + 1) {
            if k.kind == EventKind::Proposed && k.claims.target == Some(player) {
                hard.push(StopReason::Proposal);
            } else if pack.params.stop_events.contains(&k.kind) && !own_order(k) {
                hard.push(StopReason::Event(k.kind));
            }
        }
        if self.world.commitments.values().any(|c| c.debtor == player && c.status == CStatus::Active && c.due.as_ref().is_some_and(|d| d.by == day + 1 || d.by == day + 2)) {
            hard.push(StopReason::CommitmentDue);
        }
        let done = self.world.events[first_event..].iter().any(|e| e.f.actor == Some(player) && matches!(e.kind, EventKind::Arrived | EventKind::OrderFailed | EventKind::EngageFailed))
            || self.world.events[first_event..].iter().any(|e| e.kind == EventKind::Blocked && e.f.target == Some(player))
            || self.world.events[first_event..].iter().any(|e| e.kind == EventKind::MobilizationChanged && e.f.actor == Some(player));
        if done {
            soft.push(StopReason::OrderDone);
        }
        if day + 1 - self.last_stop >= pack.params.stop_after_days as Day {
            soft.push(StopReason::Days);
        }
        hard.dedup();
        (hard, soft)
    }

    /// Текущие донесения: прошлых остановок и копящиеся с последней.
    pub fn current_reports(&self) -> Vec<Report> {
        let mut out = self.reports.clone();
        out.extend(reports::reports(&self.pack, &self.player_obs(), self.report_from));
        out
    }

    /// Зафиксировать остановку: донесения интервала уходят в историю.
    pub fn mark_stop(&mut self) {
        let mut all = self.current_reports();
        if all.len() > REPORTS_KEPT {
            all.drain(..all.len() - REPORTS_KEPT);
        }
        self.reports = all;
        self.report_from = self.world.day;
        self.last_stop = self.world.day;
    }

    pub fn summary(&self) -> Option<Summary> {
        let end = self.world.ended.as_ref()?;
        let pack = &self.pack;
        let obs = self.player_obs();
        // Цепочка причин ключевого исхода: от события конца к намерению, решению или правилу.
        let mut chain = Vec::new();
        let mut cur = end.event.or_else(|| self.world.events.iter().rev().find(|e| matches!(e.kind, EventKind::GoalAchieved | EventKind::GoalFailed)).map(|e| e.id));
        while let Some(id) = cur.filter(|_| chain.len() < 12) {
            let e = &self.world.events[id as usize];
            let k = Knowledge { id: 0, event: id, kind: e.kind, event_day: e.day, received: e.day, channel: Channel::Direct, claims: e.f.clone() };
            chain.push(format!("{}: {} ({})", reports::date_ru(pack, e.day.max(0)), reports::sentence(pack, &obs, &k), reports::title_of(e.kind)));
            cur = None;
            for c in &e.causes {
                match c {
                    Cause::Event(prev) => cur = Some(*prev),
                    Cause::Order(o) => {
                        if let Some(o) = self.world.orders.get(o) {
                            chain.push(format!("{}: приказ — {} ({})", reports::date_ru(pack, o.day), orders::act_name(pack, &obs, &o.kind), pack.states[o.actor.ix()].name));
                        }
                    }
                    Cause::Rule(tag) => chain.push(format!(
                        "правило сценария: {}",
                        match tag {
                            RuleTag::Start => "начальные условия",
                            RuleTag::Interaction => "встреча сил",
                            RuleTag::Schedule => "график",
                            RuleTag::Deadline => "истёкший срок",
                            RuleTag::Upkeep => "содержание",
                            RuleTag::Threshold => "порог ресурса",
                            RuleTag::Trade => "торговля",
                            RuleTag::Drift => "дрейф",
                            RuleTag::Goal => "цель партии",
                        }
                    )),
                    Cause::Decision(s, d) => chain.push(format!("{}: решение — {}", reports::date_ru(pack, *d), pack.states[s.ix()].name)),
                }
            }
        }
        Some(Summary { reason: end.reason.clone(), day: end.day, goal: self.world.goal.clone(), goal_label: pack.goal.as_ref().map(|g| g.label.clone()).unwrap_or_default(), checkpoints: goals::canon(pack, &self.world), chain })
    }
}

/// Воспроизведение журнала: те же входы дают те же хэши на каждом дне (L1). Сети не касается.
pub fn replay(pack: Rc<Pack>, seed: u64, journal: &[DayRecord]) -> Result<Run, String> {
    let mut run = Run::new(pack, seed);
    replay_onto(&mut run, journal)?;
    Ok(run)
}

pub fn replay_onto(run: &mut Run, journal: &[DayRecord]) -> Result<(), String> {
    for rec in journal {
        if rec.day != run.day() {
            return Err(format!("журнал: ожидался день {}, в записи {}", run.day(), rec.day));
        }
        let got = run.step(&rec.inputs);
        if got.hash != rec.hash {
            return Err(format!("день {}: хэш {} не совпал с журналом {}", rec.day, got.hash, rec.hash));
        }
    }
    Ok(())
}

/// Инварианты законов после дня. Ошибка — нарушение закона.
pub fn check_laws(run: &Run) -> Result<(), String> {
    let (pack, w) = (&run.pack, &run.world);
    // L8: актив в одном месте; ресурс не ниже нуля.
    for a in &w.assets {
        if a.at.ix() >= pack.nodes.len() {
            return Err(format!("L8: актив {:?} вне графа", a.id));
        }
        if let Status::Moving { path, leg, .. } = &a.status {
            if path.get(*leg as usize) != Some(&a.at) || *leg as usize + 1 >= path.len() {
                return Err(format!("L8: актив {:?} не на своём пути", a.id));
            }
        }
        if a.cargo < 0 {
            return Err("L8: отрицательный груз".into());
        }
    }
    for (i, s) in w.states.iter().enumerate() {
        for (r, v) in &s.res {
            let ok = match r {
                Res::Mobilization => (0..=3).contains(v),
                Res::Pressure => (0..=100).contains(v),
                _ => *v >= 0,
            };
            if !ok {
                return Err(format!("L8: {} {r:?} = {v}", pack.states[i].name));
            }
        }
        if s.init > pack.states[i].capacity {
            return Err("L12: инициатива выше ёмкости".into());
        }
    }
    // L5: обязательство заканчивается записанным событием.
    for c in w.commitments.values().filter(|c| c.status != CStatus::Active) {
        let kind = match c.status {
            CStatus::Fulfilled => EventKind::Fulfilled,
            CStatus::Broken => EventKind::Breach,
            _ => EventKind::Expired,
        };
        if !w.events.iter().any(|e| e.kind == kind && e.f.refid == c.id) {
            return Err(format!("L5: обязательство {} закончилось без события", c.id));
        }
    }
    // L6: нет сирот — у события есть причина, и ссылки причин существуют.
    for e in &w.events {
        if e.causes.is_empty() {
            return Err(format!("L6: событие {} без причины", e.id));
        }
        for c in &e.causes {
            let ok = match c {
                Cause::Order(o) => w.orders.contains_key(o),
                Cause::Event(p) => *p < e.id,
                _ => true,
            };
            if !ok {
                return Err(format!("L6: событие {} ссылается на несуществующую причину", e.id));
            }
        }
    }
    Ok(())
}
