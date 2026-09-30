//! Приказы: проверка намерений, превью и меню. Все три — функции наблюдения (L4, L7, L10):
//! типа истинного мира у этого модуля нет.

use crate::ids::*;
use crate::model::*;
use crate::observe::{covers, Observation};
use crate::pack::{Pack, TemplateBody};
use crate::resolve::instantiate;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

data! {
    pub enum Reason {
        NotYours, Busy, NoInitiative, NoFunds, NoPath, UnknownTarget, BadParams,
        OpenProposal, Paused, TooSoon, NotPending, AlreadyAtWar, InTransition, Unavailable, Duplicate,
    }

    pub struct Reject { pub index: u32, pub reason: Reason }

    /// Что `resolve` зарезервирует под один приказ.
    pub struct OrderInfo {
        pub cost: u8,
        pub pay: i32,
        pub path: Vec<NodeId>,
        pub edges: Vec<EdgeId>,
        pub arrive: Option<Day>,
        pub asset: Option<AssetId>,
    }

    pub struct Accepted { pub initiative_left: u8, pub treasury_left: i32, pub orders: Vec<OrderInfo> }

    pub struct OrderPreview {
        pub name: String,
        // Гарантировано: совпадает с `resolve` всегда.
        pub cost: u8,
        pub reserved: Option<(AssetId, Day)>,
        /// Видимость действия: открытое или тихое.
        pub open: bool,
        /// Свои обязательства, которые приказ нарушит.
        pub breaches: Vec<CommitmentId>,
        /// Обязательства, которые возникнут у отдающего приказ.
        pub creates: Vec<Term>,
        // Оценка: совпадает с `resolve`, если нет скрытых препятствий и чужих действий.
        pub path: Vec<NodeId>,
        pub edges: Vec<EdgeId>,
        pub arrive: Option<Day>,
        /// Известные блокады на пути.
        pub blocked_by: Vec<AssetId>,
        /// Чей узел на пути без известного доступа: вход будет нарушением границы.
        pub incursion: Option<StateId>,
        /// Кто заметит сразу — из тех, чьё присутствие известно.
        pub notice: Vec<StateId>,
    }

    pub struct Preview {
        pub reject: Option<Reject>,
        pub orders: Vec<OrderPreview>,
        pub initiative_left: u8,
        pub treasury_left: i32,
        /// День, на который верны оценки: «по вашим данным на день X».
        pub as_of: Day,
    }

    pub struct Action {
        pub id: String,
        /// Объект действия: `asset:<id>`, `state:<id>`, `proposal:<n>`, `order:<n>` или `self`.
        pub object: String,
        pub label: String,
        pub kind: OrderTag,
        /// Готовое намерение; `None` у `Move` — цель выбирается через `move_options`.
        pub intent: Option<OrderKind>,
        pub cost: u8,
    }

    pub struct MoveTarget {
        pub node: NodeId,
        pub path: Vec<NodeId>,
        pub edges: Vec<EdgeId>,
        pub days: i32,
        pub arrive: Day,
        pub stances: Vec<Stance>,
        pub incursion: Option<StateId>,
    }

    pub struct MoveOptions { pub asset: AssetId, pub targets: Vec<MoveTarget> }
}

fn terms_ok(pack: &Pack, obs: &Observation, other: StateId, terms: &[Term]) -> bool {
    let me = obs.actor;
    let n_states = pack.states.len();
    !terms.is_empty()
        && terms.iter().all(|t| {
            let d = t.debtor();
            let ok_party = (d == me || d == other) && t.states().iter().all(|s| s.ix() < n_states);
            let ok_shape = match t {
                Term::Access { grantor, party, node, .. } => grantor != party && node.ix() < pack.nodes.len() && [me, other].contains(party),
                Term::Passage { grantor, party, route, .. } => grantor != party && !route.is_empty() && route.iter().all(|n| n.ix() < pack.nodes.len()) && [me, other].contains(party),
                Term::Pay { from, to, amount, every, times } => from != to && *amount > 0 && *times >= 1 && (*times == 1 || *every >= 1) && [me, other].contains(to),
                Term::Guarantee { guarantor, protected, window, .. } => guarantor != protected && *window >= 1,
                Term::Refrain { .. } => true,
            };
            ok_party && ok_shape && t.until().is_none_or(|u| u > obs.day)
        })
}

/// Проверяет только то, что актор контролирует и знает. Скрытые факты не проверяются:
/// приказ, упёршийся в неизвестное препятствие, принимается и терпит неудачу в `resolve`.
pub fn validate_intent(pack: &Pack, obs: &Observation, intents: &[OrderKind]) -> Result<Accepted, Reject> {
    let me = obs.actor;
    let mut init = obs.me.init;
    let mut funds = obs.res(Res::Treasury);
    let mut used: BTreeSet<AssetId> = BTreeSet::new();
    let mut answered: BTreeSet<ProposalId> = BTreeSet::new();
    let mut proposed: BTreeSet<StateId> = BTreeSet::new();
    let mut cancelled: BTreeSet<OrderId> = BTreeSet::new();
    let mut mobilized = false;
    let mut out = Vec::with_capacity(intents.len());

    for (index, kind) in intents.iter().enumerate() {
        let err = |reason| Err(Reject { index: index as u32, reason });
        let cost = pack.cost(kind.tag());
        if cost > init {
            return err(Reason::NoInitiative);
        }
        let mut info = OrderInfo { cost, pay: 0, path: Vec::new(), edges: Vec::new(), arrive: None, asset: None };
        let state_ok = |s: StateId| s != me && s.ix() < pack.states.len();
        let own_free = |id: AssetId, used: &BTreeSet<AssetId>| match obs.asset(id) {
            None => Err(Reason::NotYours),
            Some(a) if !obs.free(a) || used.contains(&id) => Err(Reason::Busy),
            Some(a) => Ok(a),
        };
        let open_to = |to: StateId, proposed: &BTreeSet<StateId>| {
            if proposed.contains(&to) || obs.proposals.iter().any(|p| p.from == me && p.to == to && p.status == PStatus::Pending && !p.ultimatum) {
                Err(Reason::OpenProposal)
            } else if obs.pause.get(&to).is_some_and(|&until| until > obs.day) {
                Err(Reason::Paused)
            } else {
                Ok(())
            }
        };
        let pending = |id: ProposalId, answered: &BTreeSet<ProposalId>| {
            obs.proposals.iter().find(|p| p.id == id && p.to == me && p.status == PStatus::Pending && p.expires >= obs.day && !answered.contains(&id)).ok_or(Reason::NotPending)
        };

        match kind {
            OrderKind::Move { asset, to, stance } => {
                let a = match own_free(*asset, &used) {
                    Ok(a) => a,
                    Err(r) => return err(r),
                };
                if to.ix() >= pack.nodes.len() || !a.kind.stances().contains(stance) {
                    return err(Reason::BadParams);
                }
                let Some(path) = pack.path(a.kind.mode(), a.at, *to) else { return err(Reason::NoPath) };
                used.insert(*asset);
                info.arrive = Some(obs.day + path.days);
                info.path = path.nodes;
                info.edges = path.edges;
                info.asset = Some(*asset);
            }
            OrderKind::Engage { asset, target } => {
                let a = match own_free(*asset, &used) {
                    Ok(a) => a,
                    Err(r) => return err(r),
                };
                let Some(c) = obs.contact(*target) else { return err(Reason::UnknownTarget) };
                if c.node != a.at {
                    return err(Reason::UnknownTarget);
                }
                if a.kind == AssetKind::Convoy || a.kind.mode() != c.kind.mode() {
                    return err(Reason::BadParams);
                }
                used.insert(*asset);
                info.asset = Some(*asset);
            }
            OrderKind::Propose { to, terms, expires, .. } => {
                if !state_ok(*to) || !terms_ok(pack, obs, *to, terms) {
                    return err(Reason::BadParams);
                }
                if let Err(r) = open_to(*to, &proposed) {
                    return err(r);
                }
                if *expires < obs.day + pack.embassy_delay(me, *to) + 1 {
                    return err(Reason::TooSoon);
                }
                proposed.insert(*to);
            }
            OrderKind::Accept { proposal } | OrderKind::Reject { proposal } => {
                if let Err(r) = pending(*proposal, &answered) {
                    return err(r);
                }
                answered.insert(*proposal);
            }
            OrderKind::Counter { proposal, terms, expires, .. } => {
                let from = match pending(*proposal, &answered) {
                    Ok(p) => p.from,
                    Err(r) => return err(r),
                };
                if !terms_ok(pack, obs, from, terms) {
                    return err(Reason::BadParams);
                }
                if let Err(r) = open_to(from, &proposed) {
                    return err(r);
                }
                if *expires < obs.day + pack.embassy_delay(me, from) + 1 {
                    return err(Reason::TooSoon);
                }
                answered.insert(*proposal);
                proposed.insert(from);
            }
            OrderKind::Declare { to, kind, claim, deadline, .. } => {
                if !state_ok(*to) {
                    return err(Reason::BadParams);
                }
                let ok = match (kind, claim) {
                    (DeclKind::Ultimatum, Claim::Demand { terms }) => {
                        if !terms_ok(pack, obs, *to, terms) || terms.iter().any(|t| t.debtor() != *to) {
                            return err(Reason::BadParams);
                        }
                        match deadline {
                            Some(d) if *d > obs.day + pack.embassy_delay(me, *to) => true,
                            Some(_) => return err(Reason::TooSoon),
                            None => false,
                        }
                    }
                    (DeclKind::Guarantee, Claim::Pledge { term: term @ Term::Guarantee { guarantor, .. } }) => *guarantor == me && terms_ok(pack, obs, *to, std::slice::from_ref(term)),
                    (DeclKind::Note, Claim::Support { of }) => of.ix() < pack.states.len(),
                    (DeclKind::Note, Claim::Warning { .. } | Claim::NoIntent { .. }) => true,
                    (DeclKind::Denial, Claim::Deny { .. }) => true,
                    _ => false,
                };
                if !ok {
                    return err(Reason::BadParams);
                }
            }
            OrderKind::DeclareWar { target } => {
                if !state_ok(*target) {
                    return err(Reason::BadParams);
                }
                if obs.at_war(me, *target) {
                    return err(Reason::AlreadyAtWar);
                }
            }
            OrderKind::Mobilize { delta } => {
                let Some(&level) = obs.me.res.get(&Res::Mobilization) else { return err(Reason::Unavailable) };
                if delta.abs() != 1 || !(0..=3).contains(&(level + *delta as i32)) {
                    return err(Reason::BadParams);
                }
                if obs.me.mob_target.is_some() || mobilized {
                    return err(Reason::InTransition);
                }
                mobilized = true;
            }
            OrderKind::Pay { to, amount } => {
                if !state_ok(*to) || *amount <= 0 {
                    return err(Reason::BadParams);
                }
                if *amount > funds {
                    return err(Reason::NoFunds);
                }
                funds -= amount;
                info.pay = *amount;
            }
            OrderKind::Inquire { target } => {
                if !state_ok(*target) {
                    return err(Reason::BadParams);
                }
            }
            OrderKind::Cancel { order } => {
                if !cancellable(obs, *order) {
                    return err(Reason::Unavailable);
                }
                if !cancelled.insert(*order) {
                    return err(Reason::Duplicate);
                }
            }
        }
        init -= cost;
        out.push(info);
    }
    Ok(Accepted { initiative_left: init, treasury_left: funds, orders: out })
}

/// Свой приказ, который можно отменить: движение, переход мобилизации, ждущее предложение
/// или приказ, создавший соглашение, по которому актор платит.
fn cancellable(obs: &Observation, order: OrderId) -> bool {
    let active = obs.orders.iter().find(|o| o.id == order);
    match active.map(|o| &o.kind) {
        Some(OrderKind::Move { .. } | OrderKind::Mobilize { .. }) => true,
        Some(OrderKind::Propose { .. } | OrderKind::Counter { .. } | OrderKind::Declare { .. }) => obs.proposals.iter().any(|p| p.order == order && p.status == PStatus::Pending),
        _ => pays(obs).any(|(a, _)| a.orders.contains(&order)),
    }
}

/// Действующие соглашения, по которым актор платит, и приказ актора, создавший каждое.
fn pays(obs: &Observation) -> impl Iterator<Item = (&Agreement, &Commitment)> {
    obs.commitments.iter().filter(|c| c.debtor == obs.actor && c.status == CStatus::Active).filter_map(|c| {
        let a = obs.agreements.iter().find(|a| a.id == c.agreement)?;
        matches!(a.terms[c.term as usize], Term::Pay { .. }).then_some((a, c))
    })
}

fn name_of(pack: &Pack, space: Space, ix: usize) -> &str {
    match space {
        Space::State => &pack.states[ix].name,
        Space::Node => &pack.nodes[ix].name,
        Space::Asset => &pack.assets[ix].name,
        _ => "",
    }
}

fn at(pack: &Pack, node: NodeId) -> String {
    let n = &pack.nodes[node.ix()];
    match &n.gen {
        Some(g) => format!("у {g}"),
        None => format!("— {}", n.name),
    }
}

/// Название действия: детерминированно, без модели.
pub fn act_name(pack: &Pack, obs: &Observation, kind: &OrderKind) -> String {
    let state = |s: StateId| name_of(pack, Space::State, s.ix());
    let tpl = |t: &Option<TemplateId>| t.map(|t| pack.template(t).label.clone());
    let proposal = |id: ProposalId| obs.proposals.iter().find(|p| p.id == id).and_then(|p| tpl(&p.template)).unwrap_or_else(|| format!("предложение №{id}"));
    match kind {
        OrderKind::Move { asset, to, stance } => {
            let a = name_of(pack, Space::Asset, asset.ix());
            match stance {
                Stance::Hold => format!("Переход: {a} → {}", pack.nodes[to.ix()].name),
                Stance::Demonstrate => format!("Демонстрация {}", at(pack, *to)),
                Stance::Escort => format!("Эскорт {}", at(pack, *to)),
                Stance::Blockade => format!("Блокада {}", at(pack, *to)),
            }
        }
        OrderKind::Engage { asset, target } => format!("Атака: {} против {}", name_of(pack, Space::Asset, asset.ix()), name_of(pack, Space::Asset, target.ix())),
        OrderKind::Propose { to, template, .. } => tpl(template).unwrap_or_else(|| format!("Предложение: {}", state(*to))),
        OrderKind::Accept { proposal: p } => format!("Принять: {}", proposal(*p)),
        OrderKind::Reject { proposal: p } => format!("Отклонить: {}", proposal(*p)),
        OrderKind::Counter { template, .. } => tpl(template).map_or_else(|| "Встречное предложение".to_string(), |l| format!("Встречное: {l}")),
        OrderKind::Declare { to, template, .. } => tpl(template).unwrap_or_else(|| format!("Заявление: {}", state(*to))),
        OrderKind::DeclareWar { target } => format!("Объявление войны: {}", state(*target)),
        OrderKind::Mobilize { delta } => {
            let level = obs.res(Res::Mobilization) + *delta as i32;
            format!("{}: ступень {level}", if *delta > 0 { "Мобилизация" } else { "Демобилизация" })
        }
        OrderKind::Pay { to, amount } => format!("Платёж: {}, {amount}", state(*to)),
        OrderKind::Inquire { target } => format!("Разведка: {}", state(*target)),
        OrderKind::Cancel { order } => match obs.orders.iter().find(|o| o.id == *order) {
            Some(o) => format!("Отмена: {}", act_name(pack, obs, &o.kind)),
            None => "Отмена платежей по соглашению".to_string(),
        },
    }
}

fn target_state(pack: &Pack, obs: &Observation, kind: &OrderKind) -> Option<StateId> {
    match kind {
        OrderKind::DeclareWar { target } | OrderKind::Inquire { target } => Some(*target),
        OrderKind::Engage { target, .. } => Some(pack.assets[target.ix()].owner),
        OrderKind::Move { to, .. } => obs.node_owner(pack, *to).filter(|s| *s != obs.actor),
        OrderKind::Declare { to, .. } | OrderKind::Propose { to, .. } | OrderKind::Pay { to, .. } => Some(*to),
        _ => None,
    }
}

/// Первый чужой узел пути без известного доступа и без войны с владельцем.
fn incursion(pack: &Pack, obs: &Observation, path: &[NodeId]) -> Option<StateId> {
    path.iter().skip(1).find_map(|&n| obs.node_owner(pack, n).filter(|&o| o != obs.actor && !obs.at_war(o, obs.actor) && !obs.has_access(o, n)))
}

pub fn preview(pack: &Pack, obs: &Observation, intents: &[OrderKind]) -> Preview {
    let me = obs.actor;
    let empty = Accepted { initiative_left: obs.me.init, treasury_left: obs.res(Res::Treasury), orders: Vec::new() };
    let (acc, reject) = match validate_intent(pack, obs, intents) {
        Ok(a) => (a, None),
        Err(r) => (empty, Some(r)),
    };
    let orders = intents
        .iter()
        .zip(&acc.orders)
        .map(|(kind, info)| {
            let mut p = OrderPreview {
                name: act_name(pack, obs, kind),
                cost: info.cost,
                reserved: None,
                open: false,
                breaches: Vec::new(),
                creates: Vec::new(),
                path: info.path.clone(),
                edges: info.edges.clone(),
                arrive: info.arrive,
                blocked_by: Vec::new(),
                incursion: None,
                notice: Vec::new(),
            };
            let target = target_state(pack, obs, kind);
            for c in obs.commitments.iter().filter(|c| c.debtor == me && c.status == CStatus::Active) {
                let Some(ag) = obs.agreements.iter().find(|a| a.id == c.agreement) else { continue };
                let breach = match (&ag.terms[c.term as usize], kind) {
                    (Term::Refrain { kind: tag, target: t, .. }, k) => k.is(*tag) && t.is_none_or(|t| target == Some(t)),
                    (term @ (Term::Access { party, .. } | Term::Passage { party, .. }), OrderKind::Engage { asset, target }) => {
                        pack.assets[target.ix()].owner == *party && obs.asset(*asset).is_some_and(|a| covers(term, me, *party, a.at))
                    }
                    (Term::Pay { .. }, OrderKind::Cancel { order }) => ag.orders.contains(order),
                    _ => false,
                };
                if breach {
                    p.breaches.push(c.id);
                }
            }
            match kind {
                OrderKind::Move { asset, to, stance } => {
                    p.reserved = info.arrive.map(|d| (*asset, d));
                    p.incursion = incursion(pack, obs, &info.path);
                    p.open = *stance != Stance::Hold || p.incursion.is_some();
                    let kind = obs.asset(*asset).map(|a| a.kind);
                    if kind == Some(AssetKind::Convoy) {
                        p.blocked_by = obs.contacts.iter().filter(|c| c.stance == Some(Stance::Blockade) && info.path[1..].contains(&c.node) && !obs.has_access(c.owner, c.node)).map(|c| c.asset).collect();
                    }
                    let mut notice: BTreeSet<StateId> = obs.contacts.iter().filter(|c| info.path[1..].contains(&c.node)).map(|c| c.owner).collect();
                    notice.extend(obs.node_owner(pack, *to).filter(|s| *s != me));
                    p.notice = notice.into_iter().collect();
                }
                OrderKind::Engage { asset, target } => {
                    p.open = true;
                    p.reserved = Some((*asset, obs.day + 1));
                    p.notice = vec![pack.assets[target.ix()].owner];
                }
                OrderKind::Mobilize { delta } => p.open = !(*delta > 0 && obs.res(Res::Mobilization) == 0),
                OrderKind::DeclareWar { target } => {
                    p.open = true;
                    p.notice = vec![*target];
                }
                OrderKind::Declare { kind, claim, .. } => {
                    p.open = matches!(kind, DeclKind::Ultimatum | DeclKind::Guarantee);
                    if let Claim::Pledge { term } = claim {
                        p.creates.push(term.clone());
                    }
                }
                OrderKind::Accept { proposal } => {
                    if let Some(prop) = obs.proposals.iter().find(|x| x.id == *proposal) {
                        p.creates = prop.terms.iter().filter(|t| t.debtor() == me).cloned().collect();
                    }
                }
                _ => {}
            }
            p
        })
        .collect();
    Preview { reject, orders, initiative_left: acc.initiative_left, treasury_left: acc.treasury_left, as_of: obs.day }
}

fn sid(pack: &Pack, s: StateId) -> &str {
    pack.lex.name(Space::State, s.0 as u16)
}

/// Меню — `validate_intent`, применённый к кандидатам поверх уже отданных приказов (L10).
pub fn menu(pack: &Pack, obs: &Observation, staged: &[OrderKind]) -> Vec<Action> {
    let me = obs.actor;
    let mut cands: Vec<(String, String, Option<OrderKind>, OrderTag)> = Vec::new();

    let busy: BTreeSet<AssetId> = staged.iter().filter_map(|k| match k {
        OrderKind::Move { asset, .. } | OrderKind::Engage { asset, .. } => Some(*asset),
        _ => None,
    }).collect();
    for a in obs.assets.iter().filter(|a| obs.free(a) && !busy.contains(&a.id)) {
        let aid = pack.lex.name(Space::Asset, a.id.0);
        if !pack.reachable(a.kind.mode(), a.at).is_empty() {
            cands.push((format!("move:{aid}"), format!("asset:{aid}"), None, OrderTag::Move));
        }
        for c in obs.contacts.iter().filter(|c| c.node == a.at) {
            let tid = pack.lex.name(Space::Asset, c.asset.0);
            cands.push((format!("engage:{aid}:{tid}"), format!("asset:{aid}"), Some(OrderKind::Engage { asset: a.id, target: c.asset }), OrderTag::Engage));
        }
    }
    for delta in [1i8, -1] {
        cands.push((format!("mob:{delta:+}"), "self".into(), Some(OrderKind::Mobilize { delta }), OrderTag::Mobilize));
    }
    // Война и разведка предлагаются против держав с действующим лицом; пассивные — только статика карты.
    for s in pack.state_ids().filter(|&s| s != me && pack.personas.iter().any(|p| p.state == s)) {
        let obj = format!("state:{}", sid(pack, s));
        cands.push((format!("war:{}", sid(pack, s)), obj.clone(), Some(OrderKind::DeclareWar { target: s }), OrderTag::DeclareWar));
        cands.push((format!("inquire:{}", sid(pack, s)), obj.clone(), Some(OrderKind::Inquire { target: s }), OrderTag::Inquire));
    }
    for t in pack.templates.iter().filter(|t| t.from == me) {
        let is_counter = matches!(&t.body, TemplateBody::Offer { counter_to, .. } if !counter_to.is_empty());
        if is_counter {
            continue;
        }
        let Some(kind) = instantiate(pack, t.id, obs.day) else { continue };
        let tid = pack.lex.name(Space::Template, t.id.0);
        cands.push((format!("tpl:{tid}"), format!("state:{}", sid(pack, t.to)), Some(kind.clone()), kind.tag()));
    }
    for p in obs.proposals.iter().filter(|p| p.to == me && p.status == PStatus::Pending) {
        let obj = format!("proposal:{}", p.id);
        cands.push((format!("accept:{}", p.id), obj.clone(), Some(OrderKind::Accept { proposal: p.id }), OrderTag::Accept));
        cands.push((format!("reject:{}", p.id), obj.clone(), Some(OrderKind::Reject { proposal: p.id }), OrderTag::Reject));
        for t in &pack.templates {
            let TemplateBody::Offer { terms, expires, counter_to } = &t.body else { continue };
            if t.from == me && t.to == p.from && p.template.is_some_and(|pt| counter_to.contains(&pt)) {
                let kind = OrderKind::Counter { proposal: p.id, terms: terms.iter().map(|x| x.shifted(obs.day)).collect(), expires: obs.day + *expires as Day, template: Some(t.id) };
                cands.push((format!("counter:{}:{}", p.id, pack.lex.name(Space::Template, t.id.0)), obj.clone(), Some(kind), OrderTag::Counter));
            }
        }
    }
    let mut cancels: BTreeSet<OrderId> = obs.orders.iter().map(|o| o.id).collect();
    cancels.extend(pays(obs).filter_map(|(a, _)| a.orders.iter().copied().find(|id| !obs.orders.iter().any(|o| o.id == *id))));
    for id in cancels {
        cands.push((format!("cancel:{id}"), format!("order:{id}"), Some(OrderKind::Cancel { order: id }), OrderTag::Cancel));
    }

    let mut batch = staged.to_vec();
    cands
        .into_iter()
        .filter_map(|(id, object, intent, kind)| {
            let label = match &intent {
                Some(k) => {
                    batch.push(k.clone());
                    let ok = validate_intent(pack, obs, &batch).is_ok();
                    batch.pop();
                    if !ok {
                        return None;
                    }
                    act_name(pack, obs, k)
                }
                None => {
                    if pack.cost(kind) > validate_intent(pack, obs, staged).map_or(0, |a| a.initiative_left) {
                        return None;
                    }
                    "Переместить".to_string()
                }
            };
            Some(Action { id, object, label, kind, intent, cost: pack.cost(kind) })
        })
        .collect()
}

/// Цели, пути и оценки выбранного актива. Только публичный граф и наблюдение.
pub fn move_options(pack: &Pack, obs: &Observation, staged: &[OrderKind], asset: AssetId) -> MoveOptions {
    let mut out = MoveOptions { asset, targets: Vec::new() };
    let Some(a) = obs.asset(asset).filter(|a| obs.free(a)) else { return out };
    let mut batch = staged.to_vec();
    batch.push(OrderKind::Move { asset, to: a.at, stance: Stance::Hold });
    for path in pack.reachable(a.kind.mode(), a.at).into_iter().take(pack.params.max_move_targets as usize) {
        let to = *path.nodes.last().unwrap();
        *batch.last_mut().unwrap() = OrderKind::Move { asset, to, stance: Stance::Hold };
        if validate_intent(pack, obs, &batch).is_err() {
            break;
        }
        out.targets.push(MoveTarget {
            node: to,
            incursion: incursion(pack, obs, &path.nodes),
            arrive: obs.day + path.days,
            days: path.days,
            stances: a.kind.stances().to_vec(),
            path: path.nodes,
            edges: path.edges,
        });
    }
    out
}
