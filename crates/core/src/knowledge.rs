//! Доставка сведений: события становятся `Knowledge` акторов, возможно с задержкой и искажением.
//! Наблюдение строится из `claims`, никогда из самого события.

use crate::ids::*;
use crate::model::*;
use crate::pack::Pack;
use crate::rng::{chance, roll, seed_for, Rng};

fn active(pack: &Pack, w: &World, s: StateId) -> bool {
    s == pack.player || w.states[s.ix()].persona.is_some()
}

/// Начальное знание: публичная статика и стартовые позиции.
pub fn new_minds(pack: &Pack, w: &World) -> Minds {
    let actors = pack
        .state_ids()
        .map(|s| {
            let mut m = Mind { regions: w.region_owner.iter().map(|&o| (o, 0)).collect(), last_review: 0, ..Mind::default() };
            for a in w.assets.iter().filter(|a| a.owner != s) {
                m.contacts.insert(a.id, Contact { asset: a.id, owner: a.owner, kind: a.kind, node: a.at, day: 0, stance: None, moving: false });
            }
            for o in pack.state_ids().filter(|&o| o != s) {
                if let Some(&level) = w.states[o.ix()].res.get(&Res::Mobilization) {
                    m.mob.insert(o, (level, 0));
                }
            }
            for a in w.agreements.values().filter(|a| a.public || a.parties.contains(&s)) {
                m.agreements.insert(a.id, a.status);
            }
            if let Some(p) = w.states[s.ix()].persona {
                m.plan = default_plan(pack, p, 0);
            }
            m
        })
        .collect();
    Minds { actors }
}

/// Резервная политика персонажа как план: повторяемые правила «условие → намерение».
pub fn default_plan(pack: &Pack, persona: PersonaId, day: Day) -> Plan {
    let p = &pack.personas[persona.ix()];
    Plan {
        goal: p.interests.iter().max_by_key(|i| i.weight).map(|i| i.key.clone()).unwrap_or_default(),
        steps: p.policy.clone(),
        review_if: Vec::new(),
        since: day,
        reason: "резервная политика".into(),
    }
}

fn knows(m: &Mind, event: EventId) -> bool {
    m.knowledge.iter().any(|k| k.event == event) || m.inbox.iter().any(|d| d.event == event)
}

/// Шаг 8 разрешения дня `day`: доставка, знание на `day + 1`, триггеры пересмотра.
pub fn deliver_day(pack: &Pack, w: &World, minds: &mut Minds, seed: u64, day: Day) {
    let mut distort: Rng = seed_for(seed, day, "distort", None);
    let mut leak: Rng = seed_for(seed, day, "leak", None);
    let leak_from = day - pack.params.leak_days as Day;
    let first = w.events.iter().position(|e| e.day >= leak_from.max(0)).unwrap_or(w.events.len());

    for e in &w.events[first..] {
        for s in pack.state_ids().filter(|&s| active(pack, w, s)) {
            let m = &mut minds.actors[s.ix()];
            let fresh = e.day == day;
            if (!fresh && e.vis != Visibility::Secret) || knows(m, e.id) {
                continue;
            }
            let capital = pack.capital(s);
            let here = e.kind.physical() && e.f.node.is_some_and(|n| w.assets.iter().any(|a| a.alive && a.owner == s && a.at == n));
            let origin = e.f.node.or_else(|| e.f.actor.map(|a| pack.capital(a))).unwrap_or(capital);
            let party = e.f.actor == Some(s) || e.f.target == Some(s);
            let listed = matches!(&e.vis, Visibility::Private(list) if list.contains(&s));
            // Канал и задержка. Своё действие известно сразу и точно (L9).
            let route = if e.f.actor == Some(s) && fresh {
                Some((Channel::Direct, 0))
            } else if here && fresh {
                Some((Channel::Seen, 0))
            } else if fresh && (listed || (party && e.vis != Visibility::Secret)) {
                let ch = if e.kind.physical() { Channel::Telegraph } else { Channel::Embassy };
                Some((ch, pack.delay(ch, origin, capital)))
            } else if fresh && e.vis == Visibility::Public {
                Some((Channel::Press, pack.delay(Channel::Press, origin, capital)))
            } else if e.vis == Visibility::Secret && chance(&mut leak, pack.params.leak) {
                Some((Channel::Leak, 0))
            } else {
                None
            };
            let Some((channel, delay)) = route else { continue };
            let mut claims = e.f.clone();
            let p = pack.params.distort.get(&channel).copied().unwrap_or(0);
            if p > 0 && chance(&mut distort, p) {
                let (node, amount) = e.kind.distortable();
                if let (true, Some(n)) = (node, claims.node) {
                    let near = pack.neighbors(n);
                    if !near.is_empty() {
                        claims.node = Some(near[roll(&mut distort, near.len() as u32) as usize].0);
                    }
                }
                if amount {
                    claims.amount += if roll(&mut distort, 2) == 0 { 1 } else { -1 };
                }
            }
            m.inbox.push(Delivery { event: e.id, due: day + 1 + delay, channel, claims });
        }
    }

    // Разведка: секретные события цели за окно утечки и положение её активов.
    for e in w.events[first..].iter().filter(|e| e.day == day && e.kind == EventKind::Inquiry) {
        let (Some(actor), Some(target)) = (e.f.actor, e.f.target) else { continue };
        let m = &mut minds.actors[actor.ix()];
        let due = day + 1 + pack.n("inquiry_days");
        for x in w.events[first..].iter().filter(|x| x.vis == Visibility::Secret && x.f.actor == Some(target) && x.kind != EventKind::Inquiry) {
            if !knows(m, x.id) {
                m.inbox.push(Delivery { event: x.id, due, channel: Channel::Inquiry, claims: x.f.clone() });
            }
        }
        for a in w.assets.iter().filter(|a| a.alive && a.owner == target) {
            see(m, a, day + 1);
        }
    }

    for s in pack.state_ids().filter(|&s| active(pack, w, s)) {
        let m = &mut minds.actors[s.ix()];
        let (due, rest): (Vec<Delivery>, Vec<Delivery>) = std::mem::take(&mut m.inbox).into_iter().partition(|d| d.due <= day + 1);
        m.inbox = rest;
        for d in due {
            let e = &w.events[d.event as usize];
            let id = m.next_id;
            m.next_id += 1;
            let k = Knowledge { id, event: d.event, kind: e.kind, event_day: e.day, received: day + 1, channel: d.channel, claims: d.claims };
            learn(pack, w, m, s, &k);
            m.knowledge.push(k);
        }
        sight(pack, w, m, s, day + 1);
        if s != pack.player {
            triggers(pack, w, m, s, day + 1);
        }
    }
}

fn see(m: &mut Mind, a: &Asset, day: Day) {
    let stance = match a.status {
        Status::Stationed { stance } => Some(stance),
        _ => None,
    };
    m.sightings.remove(&a.id);
    m.contacts.insert(a.id, Contact { asset: a.id, owner: a.owner, kind: a.kind, node: a.at, day, stance, moving: matches!(a.status, Status::Moving { .. }) });
}

/// Прямое наблюдение: чужие активы в узлах своих активов и на своей территории — опознаны;
/// в соседних с военным кораблём морских узлах — неопознанные силуэты.
fn sight(pack: &Pack, w: &World, m: &mut Mind, s: StateId, day: Day) {
    let mine = |n: NodeId| w.assets.iter().any(|a| a.alive && a.owner == s && a.at == n);
    let own_land = |n: NodeId| pack.nodes[n.ix()].region.is_some_and(|r| w.region_owner[r.ix()] == s);
    let patrol = |n: NodeId| pack.neighbors(n).iter().any(|&(nb, e)| pack.edges[e.ix()].mode == Mode::Sea && w.assets.iter().any(|a| a.alive && a.owner == s && a.kind.warship() && a.at == nb));
    for a in w.assets.iter().filter(|a| a.alive && a.owner != s) {
        if mine(a.at) || own_land(a.at) {
            see(m, a, day);
        } else if patrol(a.at) && m.contacts.get(&a.id).is_none_or(|c| c.node != a.at) {
            let id = m.sightings.get(&a.id).map(|x| x.id).unwrap_or_else(|| {
                m.next_id += 1;
                m.next_id
            });
            m.sightings.insert(a.id, Sighting { id, node: a.at, day, kind: a.kind });
        }
    }
    m.sightings.retain(|_, x| day - x.day <= 7);
}

/// Обновляет сводное знание актора по полученным `claims`.
fn learn(pack: &Pack, w: &World, m: &mut Mind, me: StateId, k: &Knowledge) {
    use EventKind::*;
    let c = &k.claims;
    let as_of = k.event_day + 1;
    let contact = |m: &mut Mind, asset: Option<AssetId>, node: Option<NodeId>, stance: Option<Stance>| {
        let (Some(asset), Some(node)) = (asset, node) else { return };
        let def = &pack.assets[asset.ix()];
        if def.owner != me && m.contacts.get(&asset).is_none_or(|x| x.day <= as_of) {
            m.sightings.remove(&asset);
            m.contacts.insert(asset, Contact { asset, owner: def.owner, kind: def.kind, node, day: as_of, stance, moving: false });
        }
    };
    let memory = |m: &mut Mind, about: Option<StateId>, kind: MemKind| {
        if let Some(about) = about.filter(|&a| a != me) {
            let weight = pack.params.weights.get(&k.kind).copied().unwrap_or(1);
            m.memories.push(Memory { about, kind, knowledge: k.id, weight, day: k.received });
        }
    };
    let aimed_at_me = c.target == Some(me);
    match k.kind {
        Arrived | Incursion => contact(m, c.asset, c.node, None),
        Demonstration => contact(m, c.asset, c.node, Some(Stance::Demonstrate)),
        BlockadeSet => contact(m, c.asset, c.node, Some(Stance::Blockade)),
        Blocked => contact(m, c.other, c.node, Some(Stance::Blockade)),
        Battle => {
            contact(m, c.asset, c.node, None);
            contact(m, c.other, c.node, None);
        }
        AssetLost => {
            if let Some(a) = c.asset {
                m.contacts.remove(&a);
                m.sightings.remove(&a);
            }
        }
        Occupied => {
            if let (Some(actor), Some(r)) = (c.actor, c.node.and_then(|n| pack.nodes[n.ix()].region)) {
                m.regions[r.ix()] = (actor, as_of);
            }
        }
        MobilizationChanged => {
            if let Some(a) = c.actor.filter(|&a| a != me) {
                m.mob.insert(a, (c.amount.clamp(0, 3), as_of));
            }
        }
        WarDeclared | HostilitiesOpened => {
            if let (Some(a), Some(b)) = (c.actor, c.target) {
                m.wars.insert(pair(a, b));
            }
        }
        Proposed => {
            m.proposals.entry(c.refid).or_insert(PStatus::Pending);
        }
        ProposalAccepted | ProposalRejected | ProposalCountered | ProposalExpired | ProposalWithdrawn | AgreementConflict => {
            let st = match k.kind {
                ProposalAccepted => PStatus::Accepted,
                ProposalCountered => PStatus::Countered,
                ProposalExpired => PStatus::Expired,
                ProposalWithdrawn => PStatus::Withdrawn,
                _ => PStatus::Rejected,
            };
            m.proposals.insert(c.refid, st);
            // Пауза после отказа: узнав об отказе или молчании, снова предлагать можно не сразу.
            if aimed_at_me && matches!(st, PStatus::Rejected | PStatus::Expired) {
                if let Some(other) = c.actor {
                    m.pause.insert(other, as_of + pack.params.pause_after_reject as Day);
                }
            }
        }
        AgreementMade => {
            m.agreements.insert(c.refid, AStatus::Active);
        }
        Breach | Fulfilled | Expired => {
            if let Some(cm) = w.commitments.get(&c.refid) {
                let st = if k.kind == Breach { AStatus::Violated } else { w.agreements[&cm.agreement].status };
                m.agreements.insert(cm.agreement, st);
            }
        }
        _ => {}
    }
    match k.kind {
        Breach => memory(m, c.actor, MemKind::Breach),
        Incursion | Demonstration | Blocked | WarDeclared | HostilitiesOpened | AssetLost | Occupied if aimed_at_me => memory(m, c.actor, MemKind::Grievance),
        Declared if aimed_at_me => memory(m, c.actor, if c.amount == DeclKind::Ultimatum as i32 { MemKind::Grievance } else { MemKind::Promise }),
        AgreementMade | Paid | Fulfilled if aimed_at_me => memory(m, c.actor, MemKind::Favor),
        AgreementMade if c.actor == Some(me) => memory(m, c.target, MemKind::Favor),
        _ => {}
    }
}

/// Триггеры пересмотра на день `day` по сведениям, полученным к его началу.
fn triggers(pack: &Pack, w: &World, m: &mut Mind, me: StateId, day: Day) {
    let mut fired: Vec<Trigger> = Vec::new();
    for k in m.knowledge.iter().filter(|k| k.received == day && k.claims.actor != Some(me)) {
        // Полученное предложение — триггер всегда.
        if k.kind == EventKind::Proposed && k.claims.target == Some(me) {
            fired.push(Trigger::Proposal);
        } else if k.claims.target == Some(me) && pack.params.stop_events.contains(&k.kind) {
            // Паритет с игроком: событие, требующее решения и направленное на актора, — повод пересмотреть план.
            fired.push(Trigger::Learned { kind: k.kind, actor: k.claims.actor });
        }
        for t in &m.plan.review_if {
            if matches!(t, Trigger::Learned { kind, actor } if *kind == k.kind && actor.is_none_or(|a| k.claims.actor == Some(a))) {
                fired.push(t.clone());
            }
        }
    }
    if w.commitments.values().any(|c| c.debtor == me && c.status == CStatus::Active && c.due.as_ref().is_some_and(|d| d.by - day <= 1)) {
        fired.push(Trigger::CommitmentAtRisk);
    }
    for t in &m.plan.review_if {
        if matches!(t, Trigger::Days { n } if day - m.last_review >= *n as Day) {
            fired.push(t.clone());
        }
    }
    for t in fired {
        if !m.review.contains(&t) {
            m.review.push(t);
        }
    }
}
