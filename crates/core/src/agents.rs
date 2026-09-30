//! Агентный слой: продолжение плана, резервная политика, вход и проверка пересмотра.
//! Видит только `Observation` и публичный пакет — типа истинного мира здесь нет (L3).

use crate::ids::*;
use crate::model::*;
use crate::observe::Observation;
use crate::orders::{menu, move_options, validate_intent};
use crate::pack::{Pack, TemplateBody};
use crate::resolve::instantiate;
use crate::rng::{chance, seed_for};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn holds(pack: &Pack, obs: &Observation, c: &Cond) -> bool {
    let me = obs.actor;
    match c {
        Cond::Always => true,
        Cond::Day { from } => obs.day >= *from,
        Cond::Learned { kind, actor, target, node, refid, within } => obs.news.iter().any(|k| {
            k.kind == *kind
                && actor.is_none_or(|a| k.claims.actor == Some(a))
                && target.is_none_or(|t| k.claims.target == Some(t))
                && node.is_none_or(|n| k.claims.node == Some(n))
                && within.is_none_or(|w| k.received >= obs.day - w as Day)
                && refid.is_none_or(|t| match k.kind {
                    EventKind::Declared => k.claims.refid == t.0 as u32 + 1,
                    EventKind::AgreementMade => obs.agreements.iter().any(|a| a.id == k.claims.refid && a.template == Some(t)),
                    _ => obs.proposals.iter().any(|p| p.id == k.claims.refid && p.template == Some(t)),
                })
        }),
        Cond::Pending { template, from } => pending(obs, *template, *from).next().is_some(),
        Cond::War { a, b } => obs.at_war(*a, *b),
        Cond::Mob { state, min } => obs.mob_of(*state) >= *min,
        Cond::ResBelow { res, value } => obs.res(*res) < *value,
        Cond::AssetAt { asset, node } => match obs.asset(*asset) {
            Some(a) => a.at == *node && !matches!(a.status, Status::Moving { .. }),
            None => obs.contact(*asset).is_some_and(|c| c.node == *node),
        },
        Cond::ContactAt { owner, node } => obs.contacts.iter().any(|c| c.owner == *owner && c.node == *node),
        Cond::Agreed { with, template } => obs.agreements.iter().any(|a| {
            a.status == AStatus::Active && a.parties.contains(with) && a.parties.contains(&me) && template.is_none_or(|t| a.template == Some(t))
        }),
        Cond::Due => obs.commitments.iter().any(|c| c.debtor == me && c.status == CStatus::Active && c.due.is_some()),
        Cond::Cargo { asset, min } => obs.asset(*asset).is_some_and(|a| a.cargo >= *min),
        Cond::Not(c) => !holds(pack, obs, c),
        Cond::All(cs) => cs.iter().all(|c| holds(pack, obs, c)),
        Cond::Any(cs) => cs.iter().any(|c| holds(pack, obs, c)),
    }
}

fn pending(obs: &Observation, template: Option<TemplateId>, from: Option<StateId>) -> impl Iterator<Item = &Proposal> {
    obs.proposals.iter().filter(move |p| {
        p.to == obs.actor && p.status == PStatus::Pending && p.expires >= obs.day && template.is_none_or(|t| p.template == Some(t)) && from.is_none_or(|f| p.from == f)
    })
}

/// Намерения шага плана на сегодня.
fn intents_of(pack: &Pack, obs: &Observation, act: &Act) -> Vec<OrderKind> {
    match act {
        Act::Order(k) => vec![k.clone()],
        Act::Offer(t) | Act::Declare(t) => instantiate(pack, *t, obs.day).into_iter().collect(),
        Act::Respond { template, from, accept } => pending(obs, *template, *from)
            .map(|p| if *accept { OrderKind::Accept { proposal: p.id } } else { OrderKind::Reject { proposal: p.id } })
            .collect(),
        Act::CounterWith { template, with } => {
            let TemplateBody::Offer { terms, expires, .. } = &pack.template(*with).body else { return Vec::new() };
            pending(obs, Some(*template), None)
                .map(|p| OrderKind::Counter { proposal: p.id, terms: terms.iter().map(|t| t.shifted(obs.day)).collect(), expires: obs.day + *expires as Day, template: Some(*with) })
                .collect()
        }
        Act::EngageAt { asset, enemy } => {
            let Some(a) = obs.asset(*asset) else { return Vec::new() };
            obs.contacts.iter().find(|c| c.owner == *enemy && c.node == a.at && c.kind.mode() == a.kind.mode()).map(|c| OrderKind::Engage { asset: *asset, target: c.asset }).into_iter().collect()
        }
        Act::Honor => obs
            .commitments
            .iter()
            .filter(|c| c.debtor == obs.actor && c.status == CStatus::Active)
            .filter_map(|c| c.due.as_ref())
            .filter(|d| !obs.at_war(obs.actor, d.against))
            .map(|d| OrderKind::DeclareWar { target: d.against })
            .collect(),
    }
}

pub struct PlanOutcome {
    pub intents: Vec<OrderKind>,
    pub plan: Plan,
    pub triggers: Vec<Trigger>,
}

/// День без модели: исполнить шаги плана, чьё условие выполнено и которые проходят `validate_intent`.
pub fn continue_plan(pack: &Pack, obs: &Observation, plan: &Plan, seed: u64) -> PlanOutcome {
    let mut rng = seed_for(seed, obs.day, "policy", Some(obs.actor));
    let mut batch: Vec<OrderKind> = Vec::new();
    let mut triggers = Vec::new();
    let mut steps = Vec::with_capacity(plan.steps.len());
    let had_once = plan.steps.iter().any(|s| s.once);
    for step in &plan.steps {
        let mut fired = false;
        if holds(pack, obs, &step.when) && step.chance.is_none_or(|p| chance(&mut rng, p)) {
            for k in intents_of(pack, obs, &step.act) {
                batch.push(k);
                if validate_intent(pack, obs, &batch).is_ok() {
                    fired = true;
                } else {
                    batch.pop();
                    if step.once && !triggers.contains(&Trigger::StepInvalid) {
                        triggers.push(Trigger::StepInvalid);
                    }
                }
            }
        }
        if !(step.once && fired) {
            steps.push(step.clone());
        }
    }
    if had_once && !steps.iter().any(|s| s.once) {
        triggers.push(Trigger::PlanExhausted);
    }
    PlanOutcome { intents: batch, plan: Plan { steps, ..plan.clone() }, triggers }
}

// ---- Пересмотр: операция `decide`

data! {
    pub enum Tier { Small, Large }

    pub struct MenuItem { pub id: String, pub intent: OrderKind }

    pub struct BriefAsset { pub id: AssetId, pub kind: AssetKind, pub at: NodeId, pub free: bool, pub stance: Option<Stance> }

    pub struct BriefNews {
        pub id: KnowledgeId,
        pub kind: EventKind,
        pub day: Day,
        pub channel: Channel,
        pub actor: Option<StateId>,
        pub target: Option<StateId>,
        pub node: Option<NodeId>,
        pub asset: Option<AssetId>,
        pub amount: i32,
        pub template: Option<TemplateId>,
    }

    pub struct BriefRelation { pub about: StateId, pub kind: MemKind, pub weight: i32, pub day: Day }

    pub struct BriefBelief { pub about: StateId, pub prop: Prop, pub confidence: u8 }

    /// Структурированное наблюдение для пересмотра: только id, числа и перечисления.
    /// Текст промпта собирает посредник из своей копии пакета.
    pub struct Brief {
        pub day: Day,
        pub state: StateId,
        pub goal: String,
        pub resources: BTreeMap<Res, i32>,
        pub initiative: u8,
        pub plan: Vec<Step>,
        pub triggers: Vec<Trigger>,
        pub assets: Vec<BriefAsset>,
        pub contacts: Vec<Contact>,
        pub wars: Vec<(StateId, StateId)>,
        pub mobilization: BTreeMap<StateId, i32>,
        pub relations: Vec<BriefRelation>,
        pub beliefs: Vec<BriefBelief>,
        pub news: Vec<BriefNews>,
        pub commitments: Vec<Commitment>,
        pub agreements: Vec<Agreement>,
        pub proposals: Vec<Proposal>,
        pub menu: Vec<MenuItem>,
    }

    pub struct DecideRequest { pub actor: StateId, pub persona: PersonaId, pub tier: Tier, pub obs_hash: String, pub brief: Brief }

    pub struct ModelStep { #[serde(rename = "do")] pub act: String, pub when: Cond }

    pub struct ModelPlan { pub goal: String, pub steps: Vec<ModelStep>, #[serde(default)] pub review_if: Vec<Trigger> }

    pub struct ModelBelief { pub about: StateId, pub prop: Prop, pub confidence: u8, #[serde(default)] pub sources: Vec<KnowledgeId>, #[serde(default)] pub reason: String }

    /// Ответ модели: намерения на сегодня (id из меню), новый план, до 3 убеждений, причина.
    pub struct ModelDecision {
        #[serde(default)] pub today: Vec<String>,
        pub plan: ModelPlan,
        #[serde(default)] pub beliefs: Vec<ModelBelief>,
        #[serde(default)] pub reason: String,
    }
}

/// Меню агента: действия из общего меню и перемещения свободных активов к ближайшим целям.
pub fn agent_menu(pack: &Pack, obs: &Observation) -> Vec<MenuItem> {
    let mut out = Vec::new();
    let per_asset = pack.n("agent_move_targets").max(1) as usize;
    for a in menu(pack, obs, &[]) {
        match a.intent {
            Some(intent) => out.push(MenuItem { id: a.id, intent }),
            None => {
                let Some(asset) = obs.assets.iter().find(|x| a.object == format!("asset:{}", pack.lex.name(Space::Asset, x.id.0))) else { continue };
                for t in move_options(pack, obs, &[], asset.id).targets.into_iter().take(per_asset) {
                    for stance in t.stances {
                        let id = format!("{}:{}:{:?}", a.id, pack.lex.name(Space::Node, t.node.0), stance);
                        out.push(MenuItem { id, intent: OrderKind::Move { asset: asset.id, to: t.node, stance } });
                    }
                }
            }
        }
    }
    out
}

/// Есть ли у актора сегодня хоть одно допустимое действие.
pub fn can_act(pack: &Pack, obs: &Observation) -> bool {
    !menu(pack, obs, &[]).is_empty()
}

/// Вход пересмотра в фиксированных разделах.
pub fn brief(pack: &Pack, obs: &Observation, triggers: &[Trigger]) -> Brief {
    // Значимые отношения: до 5 записей памяти с наибольшим весом на контрагента, независимо от давности.
    let mut by_state: BTreeMap<StateId, Vec<&Memory>> = BTreeMap::new();
    for m in &obs.memories {
        by_state.entry(m.about).or_default().push(m);
    }
    let relations = by_state
        .into_values()
        .flat_map(|mut v| {
            v.sort_by_key(|m| (-m.weight, m.day));
            v.into_iter().take(5)
        })
        .map(|m| BriefRelation { about: m.about, kind: m.kind, weight: m.weight, day: m.day })
        .collect();
    let news = obs
        .news
        .iter()
        .filter(|k| k.received > obs.last_review && k.claims.actor != Some(obs.actor) && pack.params.weights.contains_key(&k.kind))
        .map(|k| BriefNews {
            id: k.id,
            kind: k.kind,
            day: k.event_day,
            channel: k.channel,
            actor: k.claims.actor,
            target: k.claims.target,
            node: k.claims.node,
            asset: k.claims.asset,
            amount: k.claims.amount,
            template: match k.kind {
                EventKind::Declared => k.claims.refid.checked_sub(1).map(|t| TemplateId(t as u16)),
                EventKind::AgreementMade => obs.agreements.iter().find(|a| a.id == k.claims.refid).and_then(|a| a.template),
                _ => obs.proposals.iter().find(|p| p.id == k.claims.refid).and_then(|p| p.template),
            },
        })
        .collect();
    Brief {
        day: obs.day,
        state: obs.actor,
        goal: obs.plan.goal.clone(),
        resources: obs.me.res.clone(),
        initiative: obs.me.init,
        plan: obs.plan.steps.clone(),
        triggers: triggers.to_vec(),
        assets: obs
            .assets
            .iter()
            .map(|a| BriefAsset { id: a.id, kind: a.kind, at: a.at, free: obs.free(a), stance: if let Status::Stationed { stance } = a.status { Some(stance) } else { None } })
            .collect(),
        contacts: obs.contacts.clone(),
        wars: obs.wars.clone(),
        mobilization: obs.mob.iter().map(|(s, m)| (*s, m.0)).collect(),
        relations,
        beliefs: obs.beliefs.iter().map(|b| BriefBelief { about: b.about, prop: b.prop, confidence: b.confidence }).collect(),
        news,
        commitments: obs.commitments.iter().filter(|c| c.status == CStatus::Active).cloned().collect(),
        agreements: obs.agreements.iter().filter(|a| a.status == AStatus::Active).cloned().collect(),
        proposals: obs.proposals.iter().filter(|p| p.status == PStatus::Pending).cloned().collect(),
        menu: agent_menu(pack, obs),
    }
}

pub struct Applied {
    pub intents: Vec<OrderKind>,
    pub plan: Plan,
    pub beliefs: Vec<Belief>,
}

/// Проверка ответа модели: схема, каждое намерение через `validate_intent`, источники убеждений
/// из `Knowledge` актора, условия и триггеры из перечисления. Отказ — резервная политика.
pub fn apply_model(pack: &Pack, obs: &Observation, raw: serde_json::Value) -> Result<Applied, String> {
    let d: ModelDecision = pack.from_value(raw).map_err(|e| format!("схема: {e}"))?;
    let persona = obs.me.persona.ok_or("нет персонажа")?;
    let menu = agent_menu(pack, obs);
    let find = |id: &str| menu.iter().find(|m| m.id == id).map(|m| m.intent.clone()).ok_or_else(|| format!("нет в меню: {id}"));

    let intents = d.today.iter().map(|id| find(id)).collect::<Result<Vec<_>, _>>()?;
    validate_intent(pack, obs, &intents).map_err(|r| format!("намерение {}: {:?}", r.index, r.reason))?;

    if d.plan.steps.len() > 8 || d.plan.review_if.len() > 6 || d.beliefs.len() > 3 {
        return Err("превышен размер плана или убеждений".into());
    }
    if d.reason.chars().count() > 200 || d.beliefs.iter().any(|b| b.reason.chars().count() > 200) {
        return Err("reason длиннее 200".into());
    }
    if !pack.personas[persona.ix()].interests.iter().any(|i| i.key == d.plan.goal) {
        return Err(format!("цель не из интересов персонажа: {}", d.plan.goal));
    }
    let steps = d.plan.steps.iter().map(|s| Ok(Step { when: s.when.clone(), act: Act::Order(find(&s.act)?), once: true, chance: None })).collect::<Result<Vec<_>, String>>()?;
    let beliefs = d
        .beliefs
        .into_iter()
        .map(|b| {
            if b.confidence > 100 || b.about == obs.actor || b.about.ix() >= pack.states.len() {
                return Err("убеждение: неверные поля".to_string());
            }
            if b.sources.iter().any(|s| !obs.news.iter().any(|k| k.id == *s)) {
                return Err("убеждение: источник не из знания актора".to_string());
            }
            Ok(Belief { about: b.about, prop: b.prop, confidence: b.confidence, sources: b.sources, reason: b.reason })
        })
        .collect::<Result<Vec<_>, _>>()?;
    // План без срока пересмотра оставил бы актора без решений: пересмотр не реже, чем раз в несколько дней.
    let mut review_if = d.plan.review_if;
    if !review_if.iter().any(|t| matches!(t, Trigger::Days { .. })) {
        review_if.push(Trigger::Days { n: pack.n("agent_review_days").clamp(1, 30) as u8 });
    }
    Ok(Applied { intents, plan: Plan { goal: d.plan.goal, steps, review_if, since: obs.day, reason: d.reason }, beliefs })
}
