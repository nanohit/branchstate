//! Механика ресурсов — модуль сценария: ресурсы, их дневные изменения и последствия порогов.
//! Все числа — гипотезы из `params.n` пакета.

use crate::ids::*;
use crate::model::*;
use crate::pack::{Pack, RulesKind};
use crate::resolve::Ctx;

pub trait ScenarioRules {
    /// Числа, без которых пакет не загружается.
    fn required_nums(&self) -> &'static [&'static str];
    /// Ресурсы за день, пороги и их последствия (шаг 7 разрешения дня).
    fn daily(&self, ctx: &mut Ctx);
    fn strength(&self, pack: &Pack, _w: &World, a: &Asset) -> i32 {
        pack.params.strength.get(&a.kind).copied().unwrap_or(0)
    }
}

pub fn rules(kind: RulesKind) -> &'static dyn ScenarioRules {
    match kind {
        RulesKind::Island => &Island,
        RulesKind::July1914 => &July1914,
    }
}

struct Island;
struct July1914;

fn rule(tag: RuleTag) -> Vec<Cause> {
    vec![Cause::Rule(tag)]
}

fn has(ctx: &Ctx, s: StateId, r: Res) -> bool {
    ctx.w.states[s.ix()].res.contains_key(&r)
}

fn income(ctx: &mut Ctx) {
    for s in ctx.pack.state_ids() {
        ctx.add_res(s, Res::Treasury, ctx.pack.num(s, "income"));
    }
}

/// Флот вне базы стоит денег; неоплаченный возвращается на базу.
fn fleet_upkeep(ctx: &mut Ctx) {
    for i in 0..ctx.w.assets.len() {
        let a = ctx.w.assets[i].clone();
        if !a.alive || !a.kind.warship() || (a.at == a.base && !matches!(a.status, Status::Moving { .. })) || !has(ctx, a.owner, Res::Treasury) {
            continue;
        }
        let cost = ctx.pack.num(a.owner, "fleet_upkeep");
        if ctx.w.res(a.owner, Res::Treasury) >= cost {
            ctx.add_res(a.owner, Res::Treasury, -cost);
            continue;
        }
        let homebound = matches!(&a.status, Status::Moving { path, .. } if path.last() == Some(&a.base));
        let mid_edge = matches!(a.status, Status::Moving { progress, .. } if progress > 0);
        if homebound || mid_edge {
            continue;
        }
        let Some(path) = ctx.pack.path(a.kind.mode(), a.at, a.base) else { continue };
        let ev = ctx.emit(EventKind::UpkeepUnpaid, Visibility::Private(vec![a.owner]), rule(RuleTag::Upkeep), Facts { actor: Some(a.owner), asset: Some(a.id), node: Some(a.at), ..Facts::default() });
        if let Status::Moving { order, .. } = a.status {
            ctx.w.orders.get_mut(&order).unwrap().status = OStatus::Failed;
        }
        let id = ctx.w.fresh_id();
        let _ = ev;
        ctx.w.orders.insert(id, Order { id, actor: a.owner, kind: OrderKind::Move { asset: a.id, to: a.base, stance: Stance::Hold }, day: ctx.day, status: OStatus::Active, source: Source::Rule });
        let arrive = ctx.day + 1 + path.days;
        let st = &mut ctx.w.assets[i];
        st.status = Status::Moving { path: path.nodes, leg: 0, progress: 0, arrive, stance: Stance::Hold, order: id };
        st.reserved_until = arrive;
    }
}

impl ScenarioRules for Island {
    fn required_nums(&self) -> &'static [&'static str] {
        &["income", "food_per_day", "fleet_upkeep", "convoy_capacity", "threat_grace"]
    }

    fn daily(&self, ctx: &mut Ctx) {
        let pack = ctx.pack;
        income(ctx);
        for s in pack.state_ids() {
            if let Some(food) = ctx.w.states[s.ix()].res.get_mut(&Res::Food) {
                *food = (*food - pack.num(s, "food_per_day")).max(0);
            }
        }
        fleet_upkeep(ctx);
        // Торговля: конвой в своём порту разгружается, в чужом порту с доступом — закупает.
        for i in 0..ctx.w.assets.len() {
            let a = ctx.w.assets[i].clone();
            let node = &pack.nodes[a.at.ix()];
            if !a.alive || a.kind != AssetKind::Convoy || matches!(a.status, Status::Moving { .. }) || !node.port {
                continue;
            }
            let Some(owner) = ctx.node_owner(a.at) else { continue };
            let f = Facts { actor: Some(a.owner), node: Some(a.at), asset: Some(a.id), ..Facts::default() };
            if owner == a.owner {
                if a.cargo > 0 {
                    ctx.add_res(a.owner, Res::Food, a.cargo);
                    ctx.w.assets[i].cargo = 0;
                    ctx.emit(EventKind::CargoUnloaded, Visibility::Private(vec![a.owner]), rule(RuleTag::Trade), Facts { amount: a.cargo, ..f });
                }
                continue;
            }
            let price = pack.num(owner, "price");
            if price <= 0 || ctx.w.at_war(owner, a.owner) || !ctx.has_access(owner, a.owner, a.at) {
                continue;
            }
            let q = (pack.num(a.owner, "convoy_capacity") - a.cargo).min(ctx.w.res(a.owner, Res::Treasury) / price);
            if q > 0 {
                ctx.add_res(a.owner, Res::Treasury, -q * price);
                ctx.add_res(owner, Res::Treasury, q * price);
                ctx.w.assets[i].cargo += q;
                ctx.emit(EventKind::CargoLoaded, Visibility::Private(vec![a.owner, owner]), rule(RuleTag::Trade), Facts { target: Some(owner), amount: q, ..f });
            }
        }
    }
}

impl ScenarioRules for July1914 {
    fn required_nums(&self) -> &'static [&'static str] {
        &[
            "income", "mob_upkeep", "fleet_upkeep", "mob_days", "demob_days", "threat_grace", "p_ultimatum", "p_success", "p_concession", "p_breach",
            "p_threat", "p_provoked", "p_demob", "p_rally", "pressure_drift", "pressure_base", "cabinet_at",
        ]
    }

    /// Мобилизация выводит армию к границе: каждая ступень добавляет силу.
    fn strength(&self, pack: &Pack, w: &World, a: &Asset) -> i32 {
        let base = pack.params.strength.get(&a.kind).copied().unwrap_or(0);
        if a.kind == AssetKind::Army { base + w.res(a.owner, Res::Mobilization) } else { base }
    }

    fn daily(&self, ctx: &mut Ctx) {
        let (pack, day) = (ctx.pack, ctx.day);
        let before: Vec<i32> = pack.state_ids().map(|s| ctx.w.res(s, Res::Pressure)).collect();
        income(ctx);

        // Содержание мобилизации; неоплаченное снижает её на ступень.
        for s in pack.state_ids() {
            let level = ctx.w.res(s, Res::Mobilization);
            let cost = level * pack.num(s, "mob_upkeep");
            if ctx.w.res(s, Res::Treasury) >= cost {
                ctx.add_res(s, Res::Treasury, -cost);
            } else if level > 0 {
                ctx.add_res(s, Res::Mobilization, -1);
                ctx.w.states[s.ix()].mob_target = None;
                let ev = ctx.emit(EventKind::UpkeepUnpaid, Visibility::Private(vec![s]), rule(RuleTag::Upkeep), Facts { actor: Some(s), ..Facts::default() });
                ctx.emit(EventKind::MobilizationChanged, Visibility::Public, vec![Cause::Event(ev)], Facts { actor: Some(s), amount: level - 1, ..Facts::default() });
            }
        }
        fleet_upkeep(ctx);

        // Завершение переходов мобилизации. Ступень 1 скрыта и узнаётся утечкой или разведкой.
        for s in pack.state_ids() {
            let Some((level, done)) = ctx.w.states[s.ix()].mob_target.filter(|t| day + 1 >= t.1) else { continue };
            let prev = ctx.w.res(s, Res::Mobilization);
            let st = &mut ctx.w.states[s.ix()];
            st.mob_target = None;
            st.res.insert(Res::Mobilization, level);
            let order = ctx.w.orders.values().find(|o| o.actor == s && o.status == OStatus::Active && matches!(o.kind, OrderKind::Mobilize { .. })).map(|o| o.id);
            if let Some(o) = order {
                ctx.w.orders.get_mut(&o).unwrap().status = OStatus::Done;
            }
            let vis = if level == 1 && prev == 0 { Visibility::Secret } else { Visibility::Public };
            let _ = done;
            ctx.emit(EventKind::MobilizationChanged, vis, order.map_or(rule(RuleTag::Schedule), |o| vec![Cause::Order(o)]), Facts { actor: Some(s), amount: level, ..Facts::default() });
        }

        // Давление: последствия событий дня.
        let from = ctx.w.events.iter().position(|e| e.day == day).unwrap_or(ctx.w.events.len());
        let today: Vec<Event> = ctx.w.events[from..].to_vec();
        let n = |key: &str| pack.n(key);
        for e in &today {
            let (Some(actor), target) = (e.f.actor, e.f.target) else { continue };
            match e.kind {
                EventKind::ProposalAccepted => {
                    let (Some(p), Some(proposer)) = (ctx.w.proposals.get(&e.f.refid).cloned(), target) else { continue };
                    if p.ultimatum {
                        ctx.add_res(actor, Res::Pressure, n("p_ultimatum"));
                        ctx.add_res(proposer, Res::Pressure, -n("p_success"));
                    } else {
                        // Уступка ради мира поднимает давление дома; уступка другой стороны — публичный успех.
                        let owes = |s: StateId| p.terms.iter().filter(|t| t.debtor() == s).count() as i32;
                        for (me, other) in [(actor, proposer), (proposer, actor)] {
                            ctx.add_res(me, Res::Pressure, owes(me) * n("p_concession"));
                            if owes(other) > 0 {
                                ctx.add_res(me, Res::Pressure, -n("p_success"));
                            }
                        }
                    }
                }
                EventKind::Breach => ctx.add_res(actor, Res::Pressure, n("p_breach")),
                EventKind::ThreatUnanswered => ctx.add_res(actor, Res::Pressure, n("p_threat")),
                EventKind::Demonstration | EventKind::Incursion | EventKind::Blocked => {
                    if let Some(t) = target {
                        ctx.add_res(t, Res::Pressure, n("p_provoked"));
                    }
                }
                EventKind::MobilizationStarted if e.f.amount < ctx.w.res(actor, Res::Mobilization) => ctx.add_res(actor, Res::Pressure, n("p_demob")),
                EventKind::WarDeclared => ctx.add_res(actor, Res::Pressure, -n("p_rally")),
                EventKind::Occupied => {
                    ctx.add_res(actor, Res::Pressure, -2 * n("p_success"));
                    if let Some(t) = target {
                        ctx.add_res(t, Res::Pressure, n("p_ultimatum"));
                    }
                }
                EventKind::AssetLost => ctx.add_res(actor, Res::Pressure, n("p_provoked")),
                _ => {}
            }
        }

        for s in pack.state_ids() {
            if !has(ctx, s, Res::Pressure) {
                continue;
            }
            // Обида без ответа: давление растёт, пока держава не добилась войны или принятого ультиматума.
            let nag = pack.num(s, "nag");
            let answered = ctx.w.hostilities.iter().any(|h| h.a == s || h.b == s)
                || ctx.w.events.iter().any(|e| e.kind == EventKind::ProposalAccepted && e.f.target == Some(s) && e.f.amount == 1);
            // В песочнице обида не копится: там нет цели, которую она подгоняла бы.
            if nag > 0 && !answered && !pack.endless {
                ctx.add_res(s, Res::Pressure, nag);
            }
            let (base, drift) = (pack.num(s, "pressure_base"), pack.num(s, "pressure_drift"));
            let p = ctx.w.res(s, Res::Pressure);
            let p = (p + (base - p).clamp(-drift, drift)).clamp(0, 100);
            ctx.w.states[s.ix()].res.insert(Res::Pressure, p);

            let cabinet = pack.n("cabinet_at");
            if p >= 100 {
                ctx.emit(EventKind::GovernmentCrisis, Visibility::Public, rule(RuleTag::Threshold), Facts { actor: Some(s), ..Facts::default() });
                let st = &mut ctx.w.states[s.ix()];
                if s != pack.player {
                    // Смена персонажа: преемник приходит без плана и обещаний предшественника.
                    st.persona = st.persona.and_then(|p| pack.personas[p.ix()].successor).or(st.persona);
                }
                // Для игрока кризис — поражение; в песочнице он, как у остальных, только сбрасывает давление.
                if s != pack.player || pack.endless {
                    st.res.insert(Res::Pressure, base);
                }
            } else if p >= cabinet && before[s.ix()] < cabinet {
                ctx.emit(EventKind::CabinetDemand, Visibility::Private(vec![s]), rule(RuleTag::Threshold), Facts { actor: Some(s), amount: p, ..Facts::default() });
            }
        }
    }
}
