//! Наблюдение актора на день: единственный вход для проверки, превью, меню, агентов и интерфейса.

use crate::ids::*;
use crate::model::*;
use crate::pack::Pack;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

data! {
    pub struct Observation {
        pub day: Day,
        pub actor: StateId,
        pub me: StateDyn,
        /// Свои активы — точно.
        pub assets: Vec<Asset>,
        pub orders: Vec<Order>,
        pub commitments: Vec<Commitment>,
        pub agreements: Vec<Agreement>,
        /// Известные предложения с известным статусом.
        pub proposals: Vec<Proposal>,
        pub contacts: Vec<Contact>,
        pub sightings: Vec<Sighting>,
        /// Известный владелец региона и день сведений.
        pub regions: Vec<(StateId, Day)>,
        pub mob: BTreeMap<StateId, (i32, Day)>,
        pub wars: Vec<(StateId, StateId)>,
        pub pause: BTreeMap<StateId, Day>,
        pub news: Vec<Knowledge>,
        pub beliefs: Vec<Belief>,
        pub memories: Vec<Memory>,
        pub plan: Plan,
        pub last_review: Day,
    }
}

/// L2: наблюдение строится только из фактов актора, его `Knowledge` и публичной статики.
pub fn observe(w: &World, minds: &Minds, actor: StateId) -> Observation {
    let m = &minds.actors[actor.ix()];
    let agreements: Vec<Agreement> = m
        .agreements
        .iter()
        .filter_map(|(id, st)| w.agreements.get(id).map(|a| Agreement { status: *st, ..a.clone() }))
        .collect();
    Observation {
        day: w.day,
        actor,
        me: w.states[actor.ix()].clone(),
        assets: w.assets.iter().filter(|a| a.owner == actor && a.alive).cloned().collect(),
        orders: w.orders.values().filter(|o| o.actor == actor && o.status == OStatus::Active).cloned().collect(),
        commitments: w
            .commitments
            .values()
            .filter(|c| c.debtor == actor || (c.creditor == actor && m.agreements.contains_key(&c.agreement)))
            .cloned()
            .collect(),
        agreements,
        proposals: m.proposals.iter().filter_map(|(id, st)| w.proposals.get(id).map(|p| Proposal { status: *st, ..p.clone() })).collect(),
        contacts: m.contacts.values().cloned().collect(),
        sightings: m.sightings.values().cloned().collect(),
        regions: m.regions.clone(),
        mob: m.mob.clone(),
        wars: m.wars.iter().copied().collect(),
        pause: m.pause.clone(),
        news: m.knowledge.clone(),
        beliefs: m.beliefs.clone(),
        memories: m.memories.clone(),
        plan: m.plan.clone(),
        last_review: m.last_review,
    }
}

impl Observation {
    pub fn at_war(&self, a: StateId, b: StateId) -> bool {
        self.wars.contains(&pair(a, b))
    }
    pub fn asset(&self, id: AssetId) -> Option<&Asset> {
        self.assets.iter().find(|a| a.id == id)
    }
    pub fn contact(&self, id: AssetId) -> Option<&Contact> {
        self.contacts.iter().find(|c| c.asset == id)
    }
    pub fn res(&self, r: Res) -> i32 {
        self.me.res.get(&r).copied().unwrap_or(0)
    }
    /// Известный владелец узла: владелец его региона по сведениям актора.
    pub fn node_owner(&self, pack: &Pack, node: NodeId) -> Option<StateId> {
        pack.nodes[node.ix()].region.map(|r| self.regions[r.ix()].0)
    }
    /// Известная ступень мобилизации державы (своя — точно).
    pub fn mob_of(&self, s: StateId) -> i32 {
        if s == self.actor { self.res(Res::Mobilization) } else { self.mob.get(&s).map_or(0, |m| m.0) }
    }
    /// Есть ли у актора известный действующий доступ в узел от его владельца.
    pub fn has_access(&self, grantor: StateId, node: NodeId) -> bool {
        self.agreements.iter().filter(|a| a.status == AStatus::Active).flat_map(|a| &a.terms).any(|t| covers(t, grantor, self.actor, node))
    }
    pub fn free(&self, a: &Asset) -> bool {
        a.alive && a.reserved_until <= self.day && !matches!(a.status, Status::Moving { .. })
    }
}

/// Даёт ли условие державе `party` право быть в узле `node` от `grantor`.
pub fn covers(t: &Term, grantor: StateId, party: StateId, node: NodeId) -> bool {
    match t {
        Term::Access { grantor: g, party: p, node: n, .. } => *g == grantor && *p == party && *n == node,
        Term::Passage { grantor: g, party: p, route, .. } => *g == grantor && *p == party && route.contains(&node),
        _ => false,
    }
}
