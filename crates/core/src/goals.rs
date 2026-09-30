//! Цели, конец партии и сравнение с каноном. Предикаты вычисляются над истинным миром.

use crate::ids::*;
use crate::model::*;
use crate::pack::Pack;
use serde::{Deserialize, Serialize};

data! {
    pub enum Pred {
        ResBelow { state: StateId, res: Res, value: i32 },
        ResAtLeast { state: StateId, res: Res, value: i32 },
        War { a: StateId, b: StateId },
        /// Война между любыми двумя великими державами.
        GreatWar,
        Owner { region: RegionId, state: StateId },
        /// Было событие вида `kind` с такими сторонами.
        Happened { kind: EventKind, #[serde(default)] actor: Option<StateId>, #[serde(default)] target: Option<StateId> },
        /// Действует соглашение по шаблону.
        Agreed { template: TemplateId },
        Not(Box<Pred>),
        All(Vec<Pred>),
        Any(Vec<Pred>),
    }

    pub enum GoalKind { Hold, Achieve }

    pub struct Goal { pub kind: GoalKind, pub pred: Pred, pub day: Day, pub label: String }

    pub struct Checkpoint { pub id: String, pub day: Day, pub label: String, pub pred: Pred }

    pub struct CheckpointView { pub id: String, pub date: String, pub label: String, pub state: CanonState }

    pub struct Summary {
        pub reason: EndReason,
        pub day: Day,
        pub goal: GoalStatus,
        pub goal_label: String,
        pub checkpoints: Vec<CheckpointView>,
        /// Цепочка причин ключевого исхода, от исхода к истоку.
        pub chain: Vec<String>,
    }
}

impl Pred {
    pub fn eval(&self, pack: &Pack, w: &World) -> bool {
        match self {
            Pred::ResBelow { state, res, value } => w.res(*state, *res) < *value,
            Pred::ResAtLeast { state, res, value } => w.res(*state, *res) >= *value,
            Pred::War { a, b } => w.at_war(*a, *b),
            Pred::GreatWar => w.hostilities.iter().any(|h| great(pack, h.a) && great(pack, h.b)),
            Pred::Owner { region, state } => w.region_owner[region.ix()] == *state,
            Pred::Happened { kind, actor, target } => w.events.iter().any(|e| {
                e.kind == *kind && actor.is_none_or(|a| e.f.actor == Some(a)) && target.is_none_or(|t| e.f.target == Some(t))
            }),
            Pred::Agreed { template } => w.agreements.values().any(|a| a.template == Some(*template) && a.status == AStatus::Active),
            Pred::Not(p) => !p.eval(pack, w),
            Pred::All(ps) => ps.iter().all(|p| p.eval(pack, w)),
            Pred::Any(ps) => ps.iter().any(|p| p.eval(pack, w)),
        }
    }
}

pub fn great(pack: &Pack, s: StateId) -> bool {
    pack.states[s.ix()].class == Class::GreatPower
}

/// Статус цели после разрешения дня `day` (мир уже отражает этот день).
pub fn goal_status(pack: &Pack, w: &World, day: Day) -> GoalStatus {
    if w.goal != GoalStatus::Open {
        return w.goal.clone();
    }
    let holds = pack.goal.pred.eval(pack, w);
    match pack.goal.kind {
        GoalKind::Hold if !holds => GoalStatus::Failed(day),
        GoalKind::Hold if day >= pack.goal.day => GoalStatus::Achieved(day),
        GoalKind::Achieve if holds => GoalStatus::Achieved(day),
        GoalKind::Achieve if day >= pack.goal.day => GoalStatus::Failed(day),
        _ => GoalStatus::Open,
    }
}

/// Контрольные точки с состояниями. Состояние фиксирует `resolve` в день точки.
pub fn canon(pack: &Pack, w: &World) -> Vec<CheckpointView> {
    pack.canon
        .iter()
        .zip(&w.canon)
        .map(|(c, st)| CheckpointView { id: c.id.clone(), date: pack.date(c.day), label: c.label.clone(), state: *st })
        .collect()
}
