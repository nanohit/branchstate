//! Шаблонные донесения. Заголовок и строка фактов собираются из `claims`:
//! они правдивы по построению (в пределах знания игрока) и доступны сразу.

use crate::ids::*;
use crate::model::*;
use crate::observe::Observation;
use crate::pack::Pack;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

data! {
    /// Структурное эхо ключевых утверждений литературной версии: исход, стороны, место, день.
    pub struct Echo {
        pub kind: EventKind,
        pub actor: Option<StateId>,
        pub target: Option<StateId>,
        pub node: Option<NodeId>,
        pub day: Day,
        pub outcome: i32,
    }

    /// Вход операции `narrate`: только id, числа и перечисления.
    pub struct NarrateBrief { pub echo: Echo, pub channel: Channel, pub template: Option<TemplateId> }

    pub struct Narration { pub text: String, pub echo: Echo }

    pub struct Report {
        pub report_id: String,
        pub day: Day,
        pub title: String,
        pub facts: String,
        pub kind: EventKind,
        pub actor: Option<StateId>,
        pub target: Option<StateId>,
        pub node: Option<NodeId>,
        pub event_day: Day,
        pub channel: Channel,
        /// Исход для эха литературной версии: поле `amount` главного события.
        pub outcome: i32,
        /// Шаблон заявления или предложения — посредник возьмёт его название из своей копии пакета.
        pub template: Option<TemplateId>,
        pub weight: i32,
    }
}

const MONTHS: [&str; 12] = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/// «28 июля» для дня партии.
pub fn date_ru(pack: &Pack, day: Day) -> String {
    let d = pack.date(day);
    let mut it = d.split('-').skip(1).map(|p| p.parse::<usize>().unwrap_or(1));
    let (m, dd) = (it.next().unwrap_or(1), it.next().unwrap_or(1));
    format!("{dd} {}", MONTHS[(m - 1).min(11)])
}

fn channel_ru(c: Channel) -> &'static str {
    match c {
        Channel::Direct => "свои действия",
        Channel::Seen => "наблюдение",
        Channel::Embassy => "посольство",
        Channel::Telegraph => "телеграф",
        Channel::Press => "пресса",
        Channel::Leak => "утечка",
        Channel::Inquiry => "разведка",
    }
}

pub fn title_of(kind: EventKind) -> &'static str {
    use EventKind::*;
    match kind {
        Arrived => "Прибытие",
        Incursion => "Нарушение границы",
        Demonstration => "Демонстрация силы",
        BlockadeSet => "Блокада",
        Blocked => "Конвой остановлен",
        Battle => "Бой",
        AssetLost => "Потеря",
        Occupied => "Занятие территории",
        HostilitiesOpened => "Открытие огня",
        WarDeclared => "Объявление войны",
        EngageFailed => "Атака не состоялась",
        OrderFailed => "Приказ не исполнен",
        Proposed => "Предложение",
        ProposalAccepted => "Предложение принято",
        ProposalRejected => "Предложение отклонено",
        ProposalCountered => "Встречное предложение",
        ProposalExpired => "Предложение осталось без ответа",
        ProposalWithdrawn => "Предложение отозвано",
        AgreementMade => "Соглашение",
        AgreementConflict => "Соглашение невозможно",
        Declared => "Заявление",
        ThreatUnanswered => "Угроза без ответа",
        MobilizationStarted => "Мобилизация начата",
        MobilizationChanged => "Мобилизация",
        Paid => "Платёж",
        PaymentFailed => "Платёж не прошёл",
        CommitmentDue => "Обязательство требует действия",
        Fulfilled => "Обязательство исполнено",
        Breach => "Нарушение обязательства",
        Expired => "Обязательство прекращено",
        UpkeepUnpaid => "Нет денег на содержание",
        CabinetDemand => "Требование кабинета",
        GovernmentCrisis => "Правительственный кризис",
        CargoLoaded => "Закупка",
        CargoUnloaded => "Разгрузка",
        Inquiry => "Разведка",
        GoalAchieved => "Цель достигнута",
        GoalFailed => "Цель провалена",
    }
}

/// Семейство события — для группировки донесений.
fn family(kind: EventKind) -> u8 {
    use EventKind::*;
    match kind {
        Arrived | Incursion | Demonstration | BlockadeSet | Blocked => 0,
        Battle | AssetLost | Occupied | HostilitiesOpened | WarDeclared | EngageFailed => 1,
        Proposed | ProposalAccepted | ProposalRejected | ProposalCountered | ProposalExpired | ProposalWithdrawn | AgreementMade | AgreementConflict | Declared | ThreatUnanswered => 2,
        MobilizationStarted | MobilizationChanged => 3,
        CommitmentDue | Fulfilled | Breach | Expired | Paid | PaymentFailed => 4,
        _ => 5,
    }
}

/// Шаблон заявления, предложения или соглашения, о котором сведение, — если он известен актору.
fn template_of(obs: &Observation, k: &Knowledge) -> Option<TemplateId> {
    use EventKind::*;
    match k.kind {
        Declared => k.claims.refid.checked_sub(1).map(|t| TemplateId(t as u16)),
        AgreementMade => obs.agreements.iter().find(|a| a.id == k.claims.refid).and_then(|a| a.template),
        Proposed | ProposalAccepted | ProposalRejected | ProposalCountered | ProposalExpired | ProposalWithdrawn => obs.proposals.iter().find(|p| p.id == k.claims.refid).and_then(|p| p.template),
        _ => None,
    }
}

/// Одна строка факта по `claims`: именные группы без согласования по роду.
pub fn sentence(pack: &Pack, obs: &Observation, k: &Knowledge) -> String {
    use EventKind::*;
    let c = &k.claims;
    let st = |s: Option<StateId>| s.map_or("—", |s| pack.states[s.ix()].name.as_str());
    let nd = |n: Option<NodeId>| n.map_or("—", |n| pack.nodes[n.ix()].name.as_str());
    let asset = |a: Option<AssetId>| a.map_or("—", |a| pack.assets[a.ix()].name.as_str());
    let label = || template_of(obs, k).map_or_else(|| "условия в карточке".to_string(), |t| pack.template(t).label.clone());
    match k.kind {
        Arrived => format!("{} — {}", asset(c.asset), nd(c.node)),
        Incursion => format!("{}: {} — {}, без разрешения ({})", st(c.actor), asset(c.asset), nd(c.node), st(c.target)),
        Demonstration => format!("{}: {} — {}", st(c.actor), asset(c.asset), nd(c.node)),
        BlockadeSet => format!("{}: {} — {}", st(c.actor), asset(c.asset), nd(c.node)),
        Blocked => format!("{}: блокада — {} ({})", asset(c.asset), nd(c.node), st(c.actor)),
        Battle => {
            let out = match c.amount.signum() {
                1 => format!("успех стороны {}", st(c.actor)),
                -1 => format!("успех стороны {}", st(c.target)),
                _ => "без решительного исхода".to_string(),
            };
            format!("{} — {} против {}, {out}", nd(c.node), st(c.actor), st(c.target))
        }
        AssetLost => format!("{} ({}) — {}", asset(c.asset), st(c.actor), nd(c.node)),
        Occupied => format!("{}: занят узел {} ({})", st(c.actor), nd(c.node), st(c.target)),
        HostilitiesOpened => format!("{} → {}, {}", st(c.actor), st(c.target), nd(c.node)),
        WarDeclared => format!("{} → {}", st(c.actor), st(c.target)),
        EngageFailed => format!("{}: цель не найдена", asset(c.asset)),
        OrderFailed => "приказ не удалось исполнить".to_string(),
        Proposed | ProposalWithdrawn => format!("{} → {}: {}", st(c.actor), st(c.target), label()),
        ProposalAccepted | ProposalRejected | ProposalCountered | ProposalExpired | AgreementConflict => format!("{} — ответ для {}: {}", st(c.actor), st(c.target), label()),
        AgreementMade => format!("{} и {}: {}", st(c.actor), st(c.target), label()),
        Declared => format!("{} → {}: {}", st(c.actor), st(c.target), label()),
        ThreatUnanswered => format!("{} → {}: угроза не исполнена", st(c.actor), st(c.target)),
        MobilizationStarted => format!("{}: до ступени {}", st(c.actor), c.amount),
        MobilizationChanged => format!("{}: ступень {}", st(c.actor), c.amount),
        Paid | PaymentFailed => format!("{} → {}: {}", st(c.actor), st(c.target), c.amount),
        CommitmentDue => format!("гарант {}, против {}, срок — {}", st(c.actor), st(c.target), date_ru(pack, c.amount)),
        Fulfilled | Breach | Expired => format!("{} перед {}", st(c.actor), st(c.target)),
        UpkeepUnpaid => format!("{}: содержание не оплачено", st(c.actor)),
        CabinetDemand => format!("давление {} — кабинет требует решения", c.amount),
        GovernmentCrisis => st(c.actor).to_string(),
        CargoLoaded | CargoUnloaded => format!("{} — {}, груз {}", asset(c.asset), nd(c.node), c.amount),
        Inquiry => format!("{} → {}", st(c.actor), st(c.target)),
        GoalAchieved | GoalFailed => pack.goal.label.clone(),
    }
}

/// Донесения по сведениям, полученным в дни `(since, obs.day]`: группы по (главный актор, место,
/// семейство события), порядок — по весам важности из сценария, не больше `max_reports`.
pub fn reports(pack: &Pack, obs: &Observation, since: Day) -> Vec<Report> {
    let mut groups: BTreeMap<(Option<StateId>, Option<NodeId>, u8), Vec<&Knowledge>> = BTreeMap::new();
    // Свои дипломатические шаги игрок отдал сам — в донесения идут только их последствия.
    let own_step = |k: &Knowledge| {
        use EventKind::*;
        k.channel == Channel::Direct
            && matches!(k.kind, Proposed | ProposalAccepted | ProposalRejected | ProposalCountered | ProposalWithdrawn | Declared | WarDeclared | HostilitiesOpened | MobilizationStarted | Inquiry)
    };
    for k in obs.news.iter().filter(|k| k.received > since && !own_step(k) && pack.params.weights.get(&k.kind).is_some_and(|w| *w > 0)) {
        groups.entry((k.claims.actor, k.claims.node, family(k.kind))).or_default().push(k);
    }
    let weight = |k: &Knowledge| pack.params.weights[&k.kind];
    let mut out: Vec<Report> = groups
        .into_values()
        .map(|mut items| {
            items.sort_by_key(|k| (-weight(k), k.id));
            let top = items[0];
            let mut lines: Vec<String> = Vec::new();
            // Прибытие подразумевается, если в группе есть само действие в узле.
            let implied = items.iter().any(|k| matches!(k.kind, EventKind::Demonstration | EventKind::BlockadeSet | EventKind::Incursion));
            for k in items.iter().filter(|k| !(implied && k.kind == EventKind::Arrived)) {
                let line = sentence(pack, obs, k);
                if lines.len() < 3 && !lines.contains(&line) {
                    lines.push(line);
                }
            }
            let facts = lines.join("; ");
            Report {
                report_id: format!("{}-{}", since, top.id),
                day: top.received,
                title: title_of(top.kind).to_string(),
                facts: format!("{facts} · {}, {}", date_ru(pack, top.event_day), channel_ru(top.channel)),
                kind: top.kind,
                actor: top.claims.actor,
                target: top.claims.target,
                node: top.claims.node,
                event_day: top.event_day,
                channel: top.channel,
                outcome: top.claims.amount,
                template: template_of(obs, top),
                weight: weight(top),
            }
        })
        .collect();
    out.sort_by(|a, b| (-a.weight, &a.report_id).cmp(&(-b.weight, &b.report_id)));
    out.truncate(pack.params.max_reports as usize);
    out
}

impl Report {
    pub fn narrate_brief(&self) -> NarrateBrief {
        NarrateBrief { echo: Echo { kind: self.kind, actor: self.actor, target: self.target, node: self.node, day: self.event_day, outcome: self.outcome }, channel: self.channel, template: self.template }
    }

    /// Литературная версия принимается, только если её эхо совпало со входом.
    pub fn accept_narration(&self, n: &Narration) -> Option<String> {
        let text = n.text.trim();
        (n.echo == self.narrate_brief().echo && !text.is_empty() && text.chars().count() <= 1200).then(|| text.to_string())
    }
}
