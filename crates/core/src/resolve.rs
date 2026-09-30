//! Разрешение дня. Единственное место, где меняются факты мира (L3).

use crate::goals;
use crate::ids::*;
use crate::model::*;
use crate::observe::covers;
use crate::pack::{Pack, TemplateBody};
use crate::rng::{roll, seed_for, Rng};
use crate::rules::rules;
use std::collections::{BTreeMap, BTreeSet};

pub struct Ctx<'a> {
    pub pack: &'a Pack,
    pub w: &'a mut World,
    pub seed: u64,
    pub day: Day,
}

/// Намерения дня одного актора: уже проверены `validate_intent` по его наблюдению.
pub struct Batch {
    pub source: Source,
    pub intents: Vec<OrderKind>,
}

fn facts(actor: StateId) -> Facts {
    Facts { actor: Some(actor), ..Facts::default() }
}

impl Ctx<'_> {
    /// L6: у события всегда есть причина.
    pub fn emit(&mut self, kind: EventKind, vis: Visibility, causes: Vec<Cause>, f: Facts) -> EventId {
        debug_assert!(!causes.is_empty(), "событие без причины: {kind:?}");
        let id = self.w.events.len() as EventId;
        self.w.events.push(Event { id, day: self.day, kind, vis, causes, f });
        id
    }

    pub fn node_owner(&self, n: NodeId) -> Option<StateId> {
        self.pack.nodes[n.ix()].region.map(|r| self.w.region_owner[r.ix()])
    }

    pub fn has_access(&self, grantor: StateId, party: StateId, node: NodeId) -> bool {
        self.w.agreements.values().filter(|a| a.status == AStatus::Active).flat_map(|a| &a.terms).any(|t| covers(t, grantor, party, node))
    }

    pub fn strength(&self, a: &Asset) -> i32 {
        rules(self.pack.rules).strength(self.pack, self.w, a)
    }

    fn guarantees(&self, guarantor: StateId, protected: StateId) -> bool {
        self.w.commitments.values().any(|c| {
            c.status == CStatus::Active
                && c.debtor == guarantor
                && matches!(self.w.agreements[&c.agreement].terms[c.term as usize], Term::Guarantee { protected: p, .. } if p == protected)
        })
    }

    pub fn add_res(&mut self, s: StateId, r: Res, delta: i32) {
        if let Some(v) = self.w.states[s.ix()].res.get_mut(&r) {
            *v += delta;
        }
    }

    fn open_war(&mut self, a: StateId, b: StateId) {
        if !self.w.at_war(a, b) {
            let (x, y) = pair(a, b);
            self.w.hostilities.push(Hostility { a: x, b: y, since: self.day });
        }
    }

    fn finish(&mut self, order: OrderId, status: OStatus) {
        if let Some(o) = self.w.orders.get_mut(&order) {
            o.status = status;
        }
    }

    fn fail(&mut self, order: OrderId, actor: StateId) {
        self.finish(order, OStatus::Failed);
        self.emit(EventKind::OrderFailed, Visibility::Private(vec![actor]), vec![Cause::Order(order)], Facts { refid: order, ..facts(actor) });
    }

    /// Создаёт соглашение и обязательства по его условиям.
    pub fn make_agreement(&mut self, parties: Vec<StateId>, terms: Vec<Term>, public: bool, template: Option<TemplateId>, orders: Vec<OrderId>, cause: Cause) -> AgreementId {
        let id = self.w.fresh_id();
        for (i, t) in terms.iter().enumerate() {
            let cid = self.w.fresh_id();
            self.w.commitments.insert(
                cid,
                Commitment { id: cid, agreement: id, term: i as u8, debtor: t.debtor(), creditor: t.creditor(&parties), status: CStatus::Active, paid: 0, due: None },
            );
        }
        let vis = if public { Visibility::Public } else { Visibility::Private(parties.clone()) };
        let f = Facts { actor: Some(parties[0]), target: parties.get(1).copied(), refid: id, ..Facts::default() };
        self.w.agreements.insert(id, Agreement { id, parties, terms, since: self.day, status: AStatus::Active, public, template, orders });
        self.emit(EventKind::AgreementMade, vis, vec![cause], f);
        id
    }
}

fn in_node(a: &Asset) -> bool {
    a.alive && !matches!(a.status, Status::Moving { progress, .. } if progress > 0)
}

/// Держава, против которой направлен приказ, — для `Refrain` и гарантий.
fn order_target(ctx: &Ctx, o: &Order) -> Option<StateId> {
    match &o.kind {
        OrderKind::DeclareWar { target } | OrderKind::Inquire { target } => Some(*target),
        OrderKind::Engage { target, .. } => Some(ctx.pack.assets[target.ix()].owner),
        OrderKind::Move { to, .. } => ctx.node_owner(*to).filter(|s| *s != o.actor),
        OrderKind::Declare { to, .. } | OrderKind::Propose { to, .. } | OrderKind::Pay { to, .. } => Some(*to),
        _ => None,
    }
}

pub fn resolve_day(pack: &Pack, w: &mut World, seed: u64, batches: &BTreeMap<StateId, Batch>) {
    let day = w.day;
    let ctx = &mut Ctx { pack, w, seed, day };

    // 3. Приказы дня и резервы: инициатива, активы.
    let mut today: Vec<OrderId> = Vec::new();
    for (&actor, batch) in batches {
        for kind in &batch.intents {
            let id = ctx.w.fresh_id();
            let st = &mut ctx.w.states[actor.ix()];
            st.init = st.init.saturating_sub(pack.cost(kind.tag()));
            ctx.w.orders.insert(id, Order { id, actor, kind: kind.clone(), day, status: OStatus::Active, source: batch.source });
            today.push(id);
        }
    }
    let orders: Vec<Order> = today.iter().map(|id| ctx.w.orders[id].clone()).collect();

    // 4. Взаимодействия.
    let mut withdrawn: BTreeSet<ProposalId> = BTreeSet::new();
    for o in &orders {
        if let OrderKind::Cancel { order } = o.kind {
            cancel(ctx, o, order, &mut withdrawn);
        }
    }
    for o in &orders {
        match o.kind {
            OrderKind::DeclareWar { target } => {
                ctx.open_war(o.actor, target);
                ctx.emit(EventKind::WarDeclared, Visibility::Public, vec![Cause::Order(o.id)], Facts { target: Some(target), ..facts(o.actor) });
                ctx.finish(o.id, OStatus::Done);
            }
            OrderKind::Move { asset, to, stance } => start_move(ctx, o, asset, to, stance),
            _ => {}
        }
    }
    movement(ctx);
    for o in &orders {
        if let OrderKind::Engage { asset, target } = o.kind {
            engage(ctx, o, asset, target);
        }
    }
    battles(ctx);
    occupation(ctx);
    diplomacy(ctx, &orders, &withdrawn);
    for o in &orders {
        match o.kind {
            OrderKind::Mobilize { delta } => {
                let level = ctx.w.res(o.actor, Res::Mobilization) + delta as i32;
                let days = pack.num(o.actor, if delta > 0 { "mob_days" } else { "demob_days" }).max(1);
                ctx.w.states[o.actor.ix()].mob_target = Some((level, day + days));
                let vis = if delta > 0 && level == 1 { Visibility::Secret } else { Visibility::Public };
                ctx.emit(EventKind::MobilizationStarted, vis, vec![Cause::Order(o.id)], Facts { amount: level, ..facts(o.actor) });
            }
            OrderKind::Pay { to, amount } => {
                if ctx.w.res(o.actor, Res::Treasury) >= amount {
                    ctx.add_res(o.actor, Res::Treasury, -amount);
                    ctx.add_res(to, Res::Treasury, amount);
                    ctx.emit(EventKind::Paid, Visibility::Private(vec![o.actor, to]), vec![Cause::Order(o.id)], Facts { target: Some(to), amount, ..facts(o.actor) });
                    ctx.finish(o.id, OStatus::Done);
                } else {
                    ctx.fail(o.id, o.actor);
                }
            }
            OrderKind::Inquire { target } => {
                ctx.emit(EventKind::Inquiry, Visibility::Secret, vec![Cause::Order(o.id)], Facts { target: Some(target), ..facts(o.actor) });
                ctx.finish(o.id, OStatus::Done);
            }
            _ => {}
        }
    }

    // 6. Обязательства, сроки предложений, угрозы.
    commitments(ctx);
    expiries(ctx);

    // 7. Ресурсы за день и инициатива.
    rules(pack.rules).daily(ctx);
    for (s, def) in pack.states.iter().enumerate() {
        let st = &mut ctx.w.states[s];
        st.regen_clock += 1;
        if def.regen > 0 && st.regen_clock >= def.regen {
            st.regen_clock = 0;
            st.init = (st.init + 1).min(def.capacity);
        }
    }

    finish_day(ctx);
    ctx.w.day = day + 1;
}

fn cancel(ctx: &mut Ctx, o: &Order, target: OrderId, withdrawn: &mut BTreeSet<ProposalId>) {
    let Some(t) = ctx.w.orders.get(&target).cloned().filter(|t| t.actor == o.actor) else {
        return ctx.fail(o.id, o.actor);
    };
    let active = t.status == OStatus::Active;
    match t.kind {
        OrderKind::Move { asset, .. } if active => {
            // Актив доходит до ближайшего узла пути и останавливается.
            if let Status::Moving { path, leg, stance, .. } = &mut ctx.w.assets[asset.ix()].status {
                path.truncate(*leg as usize + 2);
                *stance = Stance::Hold;
            }
        }
        OrderKind::Mobilize { .. } if active => ctx.w.states[o.actor.ix()].mob_target = None,
        OrderKind::Propose { .. } | OrderKind::Counter { .. } | OrderKind::Accept { .. } | OrderKind::Declare { .. } => {
            // Отзыв своего ждущего предложения либо отмена своих платежей по соглашению:
            // нарушение фиксирует `commitments` по статусу приказа.
            if let Some(p) = ctx.w.proposals.values().find(|p| p.order == target && p.status == PStatus::Pending) {
                withdrawn.insert(p.id);
            } else if !pays_under(ctx.w, o.actor, target) {
                return ctx.fail(o.id, o.actor);
            }
        }
        _ => return ctx.fail(o.id, o.actor),
    }
    ctx.finish(target, OStatus::Cancelled);
    ctx.finish(o.id, OStatus::Done);
}

/// Есть ли у державы действующее обязательство платить по соглашению, созданному приказом.
pub fn pays_under(w: &World, actor: StateId, order: OrderId) -> bool {
    w.commitments.values().any(|c| {
        let ag = &w.agreements[&c.agreement];
        c.status == CStatus::Active && c.debtor == actor && ag.orders.contains(&order) && matches!(ag.terms[c.term as usize], Term::Pay { .. })
    })
}

fn start_move(ctx: &mut Ctx, o: &Order, asset: AssetId, to: NodeId, stance: Stance) {
    let a = &ctx.w.assets[asset.ix()];
    let Some(path) = ctx.pack.path(a.kind.mode(), a.at, to).filter(|_| a.alive) else {
        return ctx.fail(o.id, o.actor);
    };
    let arrive = ctx.day + path.days;
    let a = &mut ctx.w.assets[asset.ix()];
    a.status = Status::Moving { path: path.nodes, leg: 0, progress: 0, arrive, stance, order: o.id };
    a.reserved_until = arrive;
}

/// Все активы продвигаются одновременно; блокады действуют по положению на начало дня.
fn movement(ctx: &mut Ctx) {
    let stationed = |ctx: &Ctx, want: Stance| -> Vec<(NodeId, StateId, AssetId, i32)> {
        ctx.w.assets.iter().filter(|a| a.alive && a.status == Status::Stationed { stance: want }).map(|a| (a.at, a.owner, a.id, ctx.strength(a))).collect()
    };
    let blockades = stationed(ctx, Stance::Blockade);
    let escorts = stationed(ctx, Stance::Escort);

    for i in 0..ctx.w.assets.len() {
        let a = ctx.w.assets[i].clone();
        let Status::Moving { path, leg, progress, arrive, stance, order } = a.status.clone() else { continue };
        if !a.alive {
            continue;
        }
        let (from, next) = (path[leg as usize], path[leg as usize + 1]);
        let edge = ctx.pack.edge_between(from, next).expect("ребро пути");
        let progress = progress + 1;
        if progress < ctx.pack.edges[edge.ix()].days {
            ctx.w.assets[i].status = Status::Moving { path, leg, progress, arrive, stance, order };
            continue;
        }

        // Блокада останавливает конвой, если эскорт слабее. Сторона с доступом от блокирующего проходит.
        if a.kind == AssetKind::Convoy {
            let blockers: Vec<_> = blockades.iter().filter(|b| b.0 == next && b.1 != a.owner && !ctx.has_access(b.1, a.owner, next)).collect();
            let block: i32 = blockers.iter().map(|b| b.3).sum();
            let escort: i32 = escorts.iter().filter(|e| e.0 == next && (e.1 == a.owner || ctx.guarantees(e.1, a.owner))).map(|e| e.3).sum();
            if block > 0 && escort < block {
                let by = blockers[0];
                let st = &mut ctx.w.assets[i];
                st.status = Status::Idle;
                st.reserved_until = ctx.day + 1;
                ctx.finish(order, OStatus::Failed);
                ctx.emit(
                    EventKind::Blocked,
                    Visibility::Private(vec![by.1, a.owner]),
                    vec![Cause::Order(order), Cause::Rule(RuleTag::Interaction)],
                    Facts { actor: Some(by.1), target: Some(a.owner), node: Some(next), asset: Some(a.id), other: Some(by.2), ..Facts::default() },
                );
                continue;
            }
        }

        let owner = ctx.node_owner(next);
        if let Some(own) = owner.filter(|&own| own != a.owner && !ctx.w.at_war(own, a.owner) && !ctx.has_access(own, a.owner, next)) {
            ctx.emit(
                EventKind::Incursion,
                Visibility::Public,
                vec![Cause::Order(order)],
                Facts { target: Some(own), node: Some(next), asset: Some(a.id), ..facts(a.owner) },
            );
        }

        let leg = leg + 1;
        let st = &mut ctx.w.assets[i];
        st.at = next;
        if leg as usize + 1 < path.len() {
            st.status = Status::Moving { path, leg, progress: 0, arrive, stance, order };
            continue;
        }
        st.status = if stance == Stance::Hold { Status::Idle } else { Status::Stationed { stance } };
        st.reserved_until = ctx.day + 1;
        ctx.finish(order, OStatus::Done);
        let f = Facts { node: Some(next), asset: Some(a.id), ..facts(a.owner) };
        ctx.emit(EventKind::Arrived, Visibility::Private(vec![a.owner]), vec![Cause::Order(order)], f.clone());
        match stance {
            Stance::Demonstrate => {
                // Демонстрация адресована владельцу узла или ближайшему чужому соседу.
                let target = owner.filter(|&s| s != a.owner).or_else(|| ctx.pack.neighbors(next).iter().filter_map(|(n, _)| ctx.node_owner(*n)).find(|&s| s != a.owner));
                ctx.emit(EventKind::Demonstration, Visibility::Public, vec![Cause::Order(order)], Facts { target, ..f });
            }
            Stance::Blockade => {
                ctx.emit(EventKind::BlockadeSet, Visibility::Public, vec![Cause::Order(order)], f);
            }
            _ => {}
        }
    }
}

fn engage(ctx: &mut Ctx, o: &Order, asset: AssetId, target: AssetId) {
    let (x, t) = (&ctx.w.assets[asset.ix()], &ctx.w.assets[target.ix()]);
    if !(in_node(x) && in_node(t) && x.at == t.at) {
        ctx.finish(o.id, OStatus::Failed);
        ctx.emit(EventKind::EngageFailed, Visibility::Private(vec![o.actor]), vec![Cause::Order(o.id)], Facts { asset: Some(asset), other: Some(target), ..facts(o.actor) });
        return;
    }
    let (enemy, node) = (t.owner, x.at);
    if !ctx.w.at_war(o.actor, enemy) {
        ctx.open_war(o.actor, enemy);
        ctx.emit(
            EventKind::HostilitiesOpened,
            Visibility::Public,
            vec![Cause::Order(o.id)],
            Facts { target: Some(enemy), node: Some(node), asset: Some(asset), other: Some(target), ..facts(o.actor) },
        );
    }
    ctx.finish(o.id, OStatus::Done);
}

fn lose(ctx: &mut Ctx, asset: AssetId, by: StateId, cause: EventId) {
    let a = &mut ctx.w.assets[asset.ix()];
    a.alive = false;
    let (owner, node) = (a.owner, a.at);
    if let Status::Moving { order, .. } = a.status {
        ctx.finish(order, OStatus::Failed);
    }
    ctx.w.assets[asset.ix()].status = Status::Idle;
    ctx.emit(
        EventKind::AssetLost,
        Visibility::Private(vec![owner, by]),
        vec![Cause::Event(cause)],
        Facts { actor: Some(owner), target: Some(by), node: Some(node), asset: Some(asset), ..Facts::default() },
    );
}

/// Столкновения: активы воюющих держав в одном узле, отдельно на суше и на море.
fn battles(ctx: &mut Ctx) {
    let mut rng: Rng = seed_for(ctx.seed, ctx.day, "battle", None);
    for n in 0..ctx.pack.nodes.len() as u16 {
        let node = NodeId(n);
        let owners: BTreeSet<StateId> = ctx.w.assets.iter().filter(|a| in_node(a) && a.at == node).map(|a| a.owner).collect();
        for &a in &owners {
            for &b in owners.iter().filter(|&&b| b > a) {
                if !ctx.w.at_war(a, b) {
                    continue;
                }
                for mode in [Mode::Rail, Mode::Sea] {
                    let side = |ctx: &Ctx, s: StateId| -> Vec<(i32, AssetId)> {
                        let mut v: Vec<_> = ctx.w.assets.iter().filter(|x| in_node(x) && x.at == node && x.owner == s && x.kind.mode() == mode).map(|x| (ctx.strength(x), x.id)).collect();
                        v.sort();
                        v
                    };
                    let (sa, sb) = (side(ctx, a), side(ctx, b));
                    let (ta, tb): (i32, i32) = (sa.iter().map(|x| x.0).sum(), sb.iter().map(|x| x.0).sum());
                    if sa.is_empty() || sb.is_empty() || (ta == 0 && tb == 0) {
                        continue;
                    }
                    let ra = if ta > 0 { ta * 2 + roll(&mut rng, 6) as i32 } else { 0 };
                    let rb = if tb > 0 { tb * 2 + roll(&mut rng, 6) as i32 } else { 0 };
                    let outcome = (ra - rb).signum();
                    let war = ctx.w.events.iter().rev().find(|e| matches!(e.kind, EventKind::WarDeclared | EventKind::HostilitiesOpened) && pair_of(e) == Some(pair(a, b))).map(|e| e.id);
                    let mut causes = vec![Cause::Rule(RuleTag::Interaction)];
                    causes.extend(war.map(Cause::Event));
                    let ev = ctx.emit(
                        EventKind::Battle,
                        Visibility::Public,
                        causes,
                        Facts { actor: Some(a), target: Some(b), node: Some(node), asset: sa.last().map(|x| x.1), other: sb.last().map(|x| x.1), amount: outcome, refid: 0 },
                    );
                    match outcome {
                        1 => lose(ctx, sb[0].1, a, ev),
                        -1 => lose(ctx, sa[0].1, b, ev),
                        _ => {}
                    }
                }
            }
        }
    }
}

fn pair_of(e: &Event) -> Option<(StateId, StateId)> {
    Some(pair(e.f.actor?, e.f.target?))
}

/// Регион переходит к воюющей державе, чья армия стоит в его ключевом узле без защитников.
fn occupation(ctx: &mut Ctx) {
    for r in 0..ctx.pack.regions.len() {
        let owner = ctx.w.region_owner[r];
        let capital = ctx.pack.states[owner.ix()].capital;
        let nodes = || ctx.pack.nodes.iter().filter(|n| n.region == Some(RegionId(r as u16)));
        let Some(key) = nodes().find(|n| Some(n.id) == capital).or_else(|| nodes().next()).map(|n| n.id) else { continue };
        let armies = |ctx: &Ctx, s: StateId| ctx.w.assets.iter().any(|a| in_node(a) && a.at == key && a.owner == s && a.kind == AssetKind::Army);
        if armies(ctx, owner) {
            continue;
        }
        let Some(occupier) = ctx.pack.state_ids().find(|&s| s != owner && ctx.w.at_war(s, owner) && armies(ctx, s)) else { continue };
        ctx.w.region_owner[r] = occupier;
        ctx.emit(
            EventKind::Occupied,
            Visibility::Public,
            vec![Cause::Rule(RuleTag::Interaction)],
            Facts { target: Some(owner), node: Some(key), ..facts(occupier) },
        );
    }
}

fn diplomacy(ctx: &mut Ctx, orders: &[Order], withdrawn: &BTreeSet<ProposalId>) {
    let day = ctx.day;
    let private = |a: StateId, b: StateId| Visibility::Private(vec![a, b]);
    let is_public = |ctx: &Ctx, t: Option<TemplateId>| t.is_some_and(|t| ctx.pack.template(t).public);

    // Новые предложения, встречные и заявления.
    for o in orders {
        match &o.kind {
            OrderKind::Propose { to, terms, expires, template } => {
                new_proposal(ctx, o, *to, terms.clone(), *expires, *template, false, None);
            }
            OrderKind::Counter { proposal, terms, expires, template } => {
                let Some(orig) = ctx.w.proposals.get_mut(proposal).filter(|p| p.status == PStatus::Pending && p.to == o.actor) else {
                    ctx.fail(o.id, o.actor);
                    continue;
                };
                orig.status = PStatus::Countered;
                let (from, order) = (orig.from, orig.order);
                ctx.finish(order, OStatus::Done);
                ctx.emit(EventKind::ProposalCountered, private(o.actor, from), vec![Cause::Order(o.id)], Facts { target: Some(from), refid: *proposal, ..facts(o.actor) });
                new_proposal(ctx, o, from, terms.clone(), *expires, *template, false, Some(*proposal));
            }
            OrderKind::Declare { to, kind, claim, deadline, template } => {
                let vis = if is_public(ctx, *template) || matches!(kind, DeclKind::Ultimatum | DeclKind::Guarantee) { Visibility::Public } else { private(o.actor, *to) };
                let refid = template.map_or(0, |t| t.0 as u32 + 1);
                let ev = ctx.emit(EventKind::Declared, vis, vec![Cause::Order(o.id)], Facts { target: Some(*to), amount: *kind as i32, refid, ..facts(o.actor) });
                match claim {
                    Claim::Demand { terms } => new_proposal(ctx, o, *to, terms.clone(), deadline.unwrap_or(day + 1), *template, true, None),
                    Claim::Pledge { term } => {
                        ctx.make_agreement(vec![o.actor, *to], vec![term.clone()], true, *template, vec![o.id], Cause::Event(ev));
                    }
                    _ => {}
                }
                if !matches!(claim, Claim::Demand { .. }) {
                    ctx.finish(o.id, OStatus::Done);
                }
            }
            _ => {}
        }
    }

    // Отзыв против ответа в тот же день: действует то, что доставлено раньше; при равенстве — жеребьёвка.
    let mut ties: Rng = seed_for(ctx.seed, day, "ties", None);
    let answered: BTreeSet<ProposalId> = orders.iter().filter_map(|o| if let OrderKind::Accept { proposal } = o.kind { Some(proposal) } else { None }).collect();
    let mut withdraw_wins: BTreeSet<ProposalId> = BTreeSet::new();
    for &p in withdrawn {
        let prop = &ctx.w.proposals[&p];
        let wins = if answered.contains(&p) {
            let (dw, da) = (ctx.pack.embassy_delay(prop.from, prop.to), ctx.pack.embassy_delay(prop.to, prop.from));
            dw < da || (dw == da && roll(&mut ties, 2) == 0)
        } else {
            true
        };
        if wins {
            withdraw_wins.insert(p);
            let (from, to) = (prop.from, prop.to);
            let order = prop.order;
            ctx.w.proposals.get_mut(&p).unwrap().status = PStatus::Withdrawn;
            ctx.emit(EventKind::ProposalWithdrawn, private(from, to), vec![Cause::Order(order)], Facts { target: Some(to), refid: p, ..facts(from) });
        }
    }

    // Ответы. Исключающие условия: раньше созданное соглашение побеждает, в один день — жеребьёвка.
    let mut accepts: Vec<&Order> = orders.iter().filter(|o| matches!(o.kind, OrderKind::Accept { .. })).collect();
    for i in (1..accepts.len()).rev() {
        accepts.swap(i, roll(&mut ties, i as u32 + 1) as usize);
    }
    for o in accepts {
        let OrderKind::Accept { proposal } = o.kind else { continue };
        let ok = ctx.w.proposals.get(&proposal).is_some_and(|p| p.status == PStatus::Pending && p.to == o.actor && p.expires >= day);
        if !ok {
            ctx.fail(o.id, o.actor);
            continue;
        }
        let p = ctx.w.proposals[&proposal].clone();
        let clash = p.terms.iter().any(|t| match t {
            Term::Access { node, exclusive: true, .. } => ctx.w.agreements.values().filter(|a| a.status == AStatus::Active).flat_map(|a| &a.terms).any(|u| matches!(u, Term::Access { node: n, exclusive: true, .. } if n == node)),
            _ => false,
        });
        if clash {
            ctx.w.proposals.get_mut(&proposal).unwrap().status = PStatus::Rejected;
            ctx.finish(o.id, OStatus::Failed);
            ctx.emit(EventKind::AgreementConflict, private(p.from, p.to), vec![Cause::Order(o.id), Cause::Rule(RuleTag::Interaction)], Facts { target: Some(p.from), refid: proposal, ..facts(o.actor) });
            continue;
        }
        ctx.w.proposals.get_mut(&proposal).unwrap().status = PStatus::Accepted;
        let ev = ctx.emit(
            EventKind::ProposalAccepted,
            if p.ultimatum { Visibility::Public } else { private(p.from, p.to) },
            vec![Cause::Order(o.id)],
            Facts { target: Some(p.from), refid: proposal, amount: p.ultimatum as i32, ..facts(o.actor) },
        );
        let public = p.ultimatum || is_public(ctx, p.template);
        ctx.make_agreement(vec![p.from, p.to], p.terms, public, p.template, vec![p.order, o.id], Cause::Event(ev));
        ctx.finish(p.order, OStatus::Done);
        ctx.finish(o.id, OStatus::Done);
    }
    for o in orders {
        let OrderKind::Reject { proposal } = o.kind else { continue };
        let Some(p) = ctx.w.proposals.get_mut(&proposal).filter(|p| p.status == PStatus::Pending && p.to == o.actor) else {
            ctx.fail(o.id, o.actor);
            continue;
        };
        p.status = PStatus::Rejected;
        let (from, order, ultimatum) = (p.from, p.order, p.ultimatum);
        let ev = ctx.emit(EventKind::ProposalRejected, private(o.actor, from), vec![Cause::Order(o.id)], Facts { target: Some(from), refid: proposal, ..facts(o.actor) });
        ctx.finish(order, OStatus::Done);
        ctx.finish(o.id, OStatus::Done);
        if ultimatum {
            let due = day + ctx.pack.n("threat_grace");
            ctx.w.threats.push(Threat { issuer: from, target: o.actor, due, event: ev });
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn new_proposal(ctx: &mut Ctx, o: &Order, to: StateId, terms: Vec<Term>, expires: Day, template: Option<TemplateId>, ultimatum: bool, counter_of: Option<ProposalId>) {
    let id = ctx.w.fresh_id();
    ctx.w.proposals.insert(id, Proposal { id, from: o.actor, to, terms, created: ctx.day, expires, status: PStatus::Pending, template, ultimatum, counter_of, order: o.id });
    ctx.emit(EventKind::Proposed, Visibility::Private(vec![o.actor, to]), vec![Cause::Order(o.id)], Facts { target: Some(to), refid: id, amount: ultimatum as i32, ..facts(o.actor) });
}

fn commitments(ctx: &mut Ctx) {
    let day = ctx.day;
    let ids: Vec<CommitmentId> = ctx.w.commitments.values().filter(|c| c.status == CStatus::Active).map(|c| c.id).collect();
    let today: Vec<Order> = ctx.w.orders.values().filter(|o| o.day == day && o.status != OStatus::Failed).cloned().collect();
    let events_from = ctx.w.events.iter().position(|e| e.day == day).unwrap_or(ctx.w.events.len());

    for cid in ids {
        let c = ctx.w.commitments[&cid].clone();
        let ag = ctx.w.agreements[&c.agreement].clone();
        if ag.status != AStatus::Active {
            continue;
        }
        let term = &ag.terms[c.term as usize];
        // Some(true) — исполнено, Some(false) — нарушено.
        let mut verdict: Option<bool> = None;
        let mut cause = Cause::Rule(RuleTag::Deadline);
        match term {
            Term::Refrain { party, kind, target, until } => {
                if let Some(o) = today.iter().find(|o| o.actor == *party && o.kind.is(*kind) && target.is_none_or(|t| order_target(ctx, o) == Some(t))) {
                    verdict = Some(false);
                    cause = Cause::Order(o.id);
                } else if day >= *until {
                    verdict = Some(true);
                }
            }
            Term::Access { grantor, party, until, .. } | Term::Passage { grantor, party, until, .. } => {
                let hit = today.iter().find(|o| match o.kind {
                    OrderKind::Engage { asset, target } if o.actor == *grantor && o.status == OStatus::Done => {
                        ctx.pack.assets[target.ix()].owner == *party && covers(term, *grantor, *party, ctx.w.assets[asset.ix()].at)
                    }
                    _ => false,
                });
                if let Some(o) = hit {
                    verdict = Some(false);
                    cause = Cause::Order(o.id);
                } else if day >= *until {
                    verdict = Some(true);
                }
            }
            Term::Pay { from, to, amount, every, times } => {
                let cancelled = ag.orders.iter().find(|id| ctx.w.orders.get(id).is_some_and(|o| o.actor == *from && o.status == OStatus::Cancelled));
                if let Some(&o) = cancelled {
                    verdict = Some(false);
                    cause = Cause::Order(o);
                } else if day >= ag.since + c.paid as Day * *every as Day {
                    if ctx.w.res(*from, Res::Treasury) >= *amount {
                        ctx.add_res(*from, Res::Treasury, -*amount);
                        ctx.add_res(*to, Res::Treasury, *amount);
                        ctx.emit(EventKind::Paid, Visibility::Private(vec![*from, *to]), vec![Cause::Rule(RuleTag::Schedule)], Facts { target: Some(*to), amount: *amount, refid: cid, ..facts(*from) });
                        let paid = c.paid + 1;
                        ctx.w.commitments.get_mut(&cid).unwrap().paid = paid;
                        if paid >= *times {
                            verdict = Some(true);
                        }
                    } else {
                        let ev = ctx.emit(EventKind::PaymentFailed, Visibility::Private(vec![*from, *to]), vec![Cause::Rule(RuleTag::Schedule)], Facts { target: Some(*to), amount: *amount, refid: cid, ..facts(*from) });
                        verdict = Some(false);
                        cause = Cause::Event(ev);
                    }
                }
            }
            Term::Guarantee { guarantor, protected, trigger, window, until } => match &c.due {
                None => {
                    let hit = ctx.w.events[events_from..].iter().find(|e| {
                        e.f.target == Some(*protected)
                            && e.f.actor != Some(*guarantor)
                            && match trigger {
                                GTrigger::War => matches!(e.kind, EventKind::WarDeclared | EventKind::HostilitiesOpened),
                                GTrigger::Blockade => e.kind == EventKind::Blocked,
                                GTrigger::Incursion => e.kind == EventKind::Incursion,
                            }
                    });
                    if let Some(e) = hit {
                        let (ev, against, node) = (e.id, e.f.actor.unwrap_or(*protected), e.f.node);
                        ctx.w.commitments.get_mut(&cid).unwrap().due = Some(Due { by: day + *window as Day, against, node });
                        ctx.emit(EventKind::CommitmentDue, Visibility::Private(vec![*guarantor, *protected]), vec![Cause::Event(ev)], Facts { target: Some(against), refid: cid, amount: day + *window as Day, ..facts(*guarantor) });
                    } else if day >= *until {
                        expire(ctx, cid, Cause::Rule(RuleTag::Deadline));
                    }
                }
                Some(due) => {
                    let since = due.by - *window as Day;
                    let acted = ctx.w.orders.values().find(|o| {
                        o.actor == *guarantor
                            && o.day >= since
                            && o.status != OStatus::Failed
                            && ctx.pack.params.guarantee_acts.iter().any(|t| o.kind.is(*t))
                            && match o.kind {
                                OrderKind::Mobilize { .. } | OrderKind::Move { .. } => true,
                                _ => order_target(ctx, o) == Some(due.against),
                            }
                    });
                    if let Some(o) = acted {
                        verdict = Some(true);
                        cause = Cause::Order(o.id);
                    } else if day >= due.by {
                        verdict = Some(false);
                    }
                }
            },
        }
        match verdict {
            Some(true) => {
                ctx.w.commitments.get_mut(&cid).unwrap().status = CStatus::Fulfilled;
                ctx.emit(EventKind::Fulfilled, Visibility::Private(ag.parties.clone()), vec![cause], Facts { target: Some(c.creditor), refid: cid, ..facts(c.debtor) });
            }
            Some(false) => {
                ctx.w.commitments.get_mut(&cid).unwrap().status = CStatus::Broken;
                ctx.w.agreements.get_mut(&c.agreement).unwrap().status = AStatus::Violated;
                let vis = if ag.public { Visibility::Public } else { Visibility::Private(ag.parties.clone()) };
                let ev = ctx.emit(EventKind::Breach, vis, vec![cause], Facts { target: Some(c.creditor), refid: cid, ..facts(c.debtor) });
                // Пострадавшая сторона свободна от своих обязательств по соглашению.
                let rest: Vec<CommitmentId> = ctx.w.commitments.values().filter(|x| x.agreement == c.agreement && x.status == CStatus::Active).map(|x| x.id).collect();
                for id in rest {
                    expire(ctx, id, Cause::Event(ev));
                }
            }
            None => {}
        }
    }
    // Соглашение без действующих обязательств закончилось.
    let open: BTreeSet<AgreementId> = ctx.w.commitments.values().filter(|c| c.status == CStatus::Active).map(|c| c.agreement).collect();
    for a in ctx.w.agreements.values_mut() {
        if a.status == AStatus::Active && !open.contains(&a.id) {
            a.status = AStatus::Ended;
        }
    }
}

fn expire(ctx: &mut Ctx, cid: CommitmentId, cause: Cause) {
    let c = ctx.w.commitments.get_mut(&cid).unwrap();
    c.status = CStatus::Expired;
    let (debtor, creditor) = (c.debtor, c.creditor);
    ctx.emit(EventKind::Expired, Visibility::Private(vec![debtor, creditor]), vec![cause], Facts { target: Some(creditor), refid: cid, ..facts(debtor) });
}

/// Молчание до срока — отказ. Отвергнутый ультиматум без войны — угроза без ответа.
fn expiries(ctx: &mut Ctx) {
    let day = ctx.day;
    let expired: Vec<Proposal> = ctx.w.proposals.values().filter(|p| p.status == PStatus::Pending && p.expires <= day).cloned().collect();
    for p in expired {
        ctx.w.proposals.get_mut(&p.id).unwrap().status = PStatus::Expired;
        ctx.finish(p.order, OStatus::Done);
        let ev = ctx.emit(EventKind::ProposalExpired, Visibility::Private(vec![p.from, p.to]), vec![Cause::Rule(RuleTag::Deadline)], Facts { target: Some(p.from), refid: p.id, ..facts(p.to) });
        if p.ultimatum {
            let due = day + ctx.pack.n("threat_grace");
            ctx.w.threats.push(Threat { issuer: p.from, target: p.to, due, event: ev });
        }
    }
    let (due, rest): (Vec<Threat>, Vec<Threat>) = std::mem::take(&mut ctx.w.threats).into_iter().partition(|t| t.due <= day);
    ctx.w.threats = rest;
    for t in due {
        if !ctx.w.at_war(t.issuer, t.target) {
            ctx.emit(EventKind::ThreatUnanswered, Visibility::Public, vec![Cause::Event(t.event), Cause::Rule(RuleTag::Deadline)], Facts { target: Some(t.target), ..facts(t.issuer) });
        }
    }
}

/// Канон, цель и конец партии — по миру после дня.
fn finish_day(ctx: &mut Ctx) {
    let (pack, day) = (ctx.pack, ctx.day);
    for (i, c) in pack.canon.iter().enumerate() {
        if c.day == day {
            ctx.w.canon[i] = if c.pred.eval(pack, ctx.w) { CanonState::Matches } else { CanonState::Contradicts };
        }
    }
    let goal = goals::goal_status(pack, ctx.w, day);
    if goal != ctx.w.goal {
        ctx.w.goal = goal.clone();
        let kind = if matches!(goal, GoalStatus::Achieved(_)) { EventKind::GoalAchieved } else { EventKind::GoalFailed };
        ctx.emit(kind, Visibility::Private(vec![pack.player]), vec![Cause::Rule(RuleTag::Goal)], facts(pack.player));
    }
    if ctx.w.ended.is_some() {
        return;
    }
    let from = ctx.w.events.iter().position(|e| e.day == day).unwrap_or(ctx.w.events.len());
    let end_event = ctx.w.events[from..]
        .iter()
        .find(|e| pack.end_events.contains(&e.kind) && e.f.actor.is_some_and(|a| goals::great(pack, a)) && e.f.target.is_some_and(|t| goals::great(pack, t)))
        .map(|e| e.id);
    let crisis = ctx.w.events[from..].iter().find(|e| e.kind == EventKind::GovernmentCrisis && e.f.actor == Some(pack.player)).map(|e| e.id);
    let reason = if end_event.is_some() {
        Some((EndReason::EndEvent, end_event))
    } else if crisis.is_some() {
        Some((EndReason::Crisis, crisis))
    } else {
        match goal {
            GoalStatus::Achieved(_) => Some((EndReason::GoalAchieved, None)),
            GoalStatus::Failed(_) => Some((EndReason::GoalFailed, None)),
            GoalStatus::Open if day >= pack.horizon => Some((EndReason::Horizon, None)),
            GoalStatus::Open => None,
        }
    };
    if let Some((reason, event)) = reason {
        ctx.w.ended = Some(Ending { day, reason, event });
    }
}

/// Начальный мир по пакету.
pub fn new_world(pack: &Pack) -> World {
    let mut w = World {
        day: 0,
        states: pack
            .states
            .iter()
            .map(|s| StateDyn { res: s.res.clone(), init: s.capacity, regen_clock: 0, mob_target: None, persona: pack.persona_of(s.id).map(|p| p.id) })
            .collect(),
        region_owner: pack.regions.iter().map(|r| r.owner).collect(),
        assets: pack
            .assets
            .iter()
            .map(|a| Asset { id: a.id, kind: a.kind, owner: a.owner, base: a.at, at: a.at, status: Status::Idle, reserved_until: 0, cargo: 0, alive: true })
            .collect(),
        orders: BTreeMap::new(),
        proposals: BTreeMap::new(),
        agreements: BTreeMap::new(),
        commitments: BTreeMap::new(),
        hostilities: Vec::new(),
        events: Vec::new(),
        threats: Vec::new(),
        goal: GoalStatus::Open,
        canon: vec![CanonState::Undetermined; pack.canon.len()],
        ended: None,
        next_id: 0,
    };
    let ctx = &mut Ctx { pack, w: &mut w, seed: 0, day: -1 };
    for a in &pack.agreements {
        let terms = a.terms.iter().map(|t| t.shifted(0)).collect();
        ctx.make_agreement(a.parties.clone(), terms, a.public, a.template, Vec::new(), Cause::Rule(RuleTag::Start));
    }
    w
}

/// Условия шаблона с абсолютными сроками на день `day`.
pub fn instantiate(pack: &Pack, t: TemplateId, day: Day) -> Option<OrderKind> {
    let tpl = pack.template(t);
    Some(match &tpl.body {
        TemplateBody::Offer { terms, expires, .. } => OrderKind::Propose { to: tpl.to, terms: terms.iter().map(|x| x.shifted(day)).collect(), expires: day + *expires as Day, template: Some(t) },
        TemplateBody::Declare { kind, claim, deadline } => {
            let claim = match claim {
                Claim::Demand { terms } => Claim::Demand { terms: terms.iter().map(|x| x.shifted(day)).collect() },
                Claim::Pledge { term } => Claim::Pledge { term: term.shifted(day) },
                other => other.clone(),
            };
            OrderKind::Declare { to: tpl.to, kind: *kind, claim, deadline: deadline.map(|d| day + d as Day), template: Some(t) }
        }
    })
}
