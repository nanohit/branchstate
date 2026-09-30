//! Пакет сценария: публичная статика (граф, державы, шаблоны, параметры-гипотезы).

use crate::goals::{Checkpoint, Goal};
use crate::ids::*;
use crate::model::*;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RulesKind {
    Island,
    July1914,
}

#[derive(Debug, Deserialize)]
pub struct StateDef {
    pub id: StateId,
    pub name: String,
    pub class: Class,
    /// У пассивных держав без узлов на графе столицы нет.
    #[serde(default)]
    pub capital: Option<NodeId>,
    #[serde(default)]
    pub capacity: u8,
    #[serde(default)]
    pub regen: u8,
    #[serde(default)]
    pub res: BTreeMap<Res, i32>,
    /// Числа державы, перекрывающие `params.n`.
    #[serde(default)]
    pub n: BTreeMap<String, i32>,
}

#[derive(Debug, Deserialize)]
pub struct Interest {
    pub key: String,
    pub weight: i32,
}

#[derive(Debug, Deserialize)]
pub struct PersonaDef {
    pub id: PersonaId,
    pub state: StateId,
    pub name: String,
    pub office: String,
    #[serde(default)]
    pub traits: Vec<String>,
    #[serde(default)]
    pub interests: Vec<Interest>,
    /// Преемник при правительственном кризисе.
    #[serde(default)]
    pub successor: Option<PersonaId>,
    /// Резервная политика: правила «условие → намерение».
    #[serde(default)]
    pub policy: Vec<Step>,
    /// Активен с начала партии (иначе — только как преемник).
    #[serde(default = "yes")]
    pub active: bool,
}

#[derive(Debug, Deserialize)]
pub struct NodeDef {
    pub id: NodeId,
    pub name: String,
    /// Родительный падеж для названий действий: «Демонстрация у Землина».
    #[serde(default)]
    pub gen: Option<String>,
    #[serde(default)]
    pub region: Option<RegionId>,
    #[serde(default)]
    pub port: bool,
    #[serde(default)]
    pub sea: bool,
}

#[derive(Debug, Deserialize)]
pub struct EdgeDef {
    pub a: NodeId,
    pub b: NodeId,
    pub mode: Mode,
    pub days: u8,
}

#[derive(Debug, Deserialize)]
pub struct RegionDef {
    pub id: RegionId,
    pub name: String,
    pub owner: StateId,
}

#[derive(Debug, Deserialize)]
pub struct AssetDef {
    pub id: AssetId,
    pub name: String,
    pub kind: AssetKind,
    pub owner: StateId,
    pub at: NodeId,
}

#[derive(Debug, Deserialize)]
pub enum TemplateBody {
    /// Сроки условий и `expires` — в днях от создания.
    Offer {
        terms: Vec<Term>,
        expires: u8,
        /// Можно использовать как встречное к этим шаблонам.
        #[serde(default)]
        counter_to: Vec<TemplateId>,
    },
    Declare {
        kind: DeclKind,
        claim: Claim,
        #[serde(default)]
        deadline: Option<u8>,
    },
}

#[derive(Debug, Deserialize)]
pub struct Template {
    pub id: TemplateId,
    pub from: StateId,
    pub to: StateId,
    pub label: String,
    #[serde(default)]
    pub public: bool,
    #[serde(flatten)]
    pub body: TemplateBody,
}

#[derive(Debug, Deserialize)]
pub struct StartAgreement {
    pub parties: Vec<StateId>,
    pub terms: Vec<Term>,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub template: Option<TemplateId>,
}

#[derive(Debug, Deserialize)]
pub struct ChannelDelay {
    /// Задержка в днях: `base + dist / per` (`per == 0` — без зависимости от расстояния).
    pub base: u8,
    #[serde(default)]
    pub per: u8,
}

/// Параметры-гипотезы сценария.
#[derive(Debug, Deserialize)]
pub struct Params {
    pub cost: BTreeMap<OrderTag, u8>,
    pub pause_after_reject: u8,
    pub stop_after_days: u8,
    pub max_reports: u8,
    pub channels: BTreeMap<Channel, ChannelDelay>,
    /// Вероятность искажения по каналу, промилле.
    #[serde(default)]
    pub distort: BTreeMap<Channel, u16>,
    /// Дневная вероятность утечки секретного события, промилле, и сколько дней она возможна.
    pub leak: u16,
    pub leak_days: u8,
    pub strength: BTreeMap<AssetKind, i32>,
    /// Важность событий для донесений; событий без веса в донесениях нет.
    pub weights: BTreeMap<EventKind, i32>,
    /// События, о которых игрок узнаёт с остановкой.
    pub stop_events: Vec<EventKind>,
    /// Чем гарант может исполнить гарантию.
    pub guarantee_acts: Vec<OrderTag>,
    pub max_move_targets: u8,
    pub n: BTreeMap<String, i32>,
}

#[derive(Debug, Deserialize)]
struct PackData {
    scenario: String,
    version: String,
    title: String,
    rules: RulesKind,
    start_date: String,
    horizon: Day,
    player: StateId,
    states: Vec<StateDef>,
    personas: Vec<PersonaDef>,
    nodes: Vec<NodeDef>,
    edges: Vec<EdgeDef>,
    regions: Vec<RegionDef>,
    assets: Vec<AssetDef>,
    #[serde(default)]
    templates: Vec<Template>,
    #[serde(default)]
    agreements: Vec<StartAgreement>,
    params: Params,
    /// Цель партии; в песочнице её нет.
    #[serde(default)]
    goal: Option<Goal>,
    /// Песочница: партия не заканчивается ни по дате предела, ни по кризису.
    #[serde(default)]
    endless: bool,
    /// События, завершающие партию, если обе стороны — великие державы.
    #[serde(default)]
    end_events: Vec<EventKind>,
    #[serde(default)]
    canon: Vec<Checkpoint>,
}

#[derive(Debug)]
pub struct Pack {
    pub scenario: String,
    pub version: String,
    pub title: String,
    pub rules: RulesKind,
    pub start_date: String,
    pub horizon: Day,
    pub player: StateId,
    pub states: Vec<StateDef>,
    pub personas: Vec<PersonaDef>,
    pub nodes: Vec<NodeDef>,
    pub edges: Vec<EdgeDef>,
    pub regions: Vec<RegionDef>,
    pub assets: Vec<AssetDef>,
    pub templates: Vec<Template>,
    pub agreements: Vec<StartAgreement>,
    pub params: Params,
    pub goal: Option<Goal>,
    pub endless: bool,
    pub end_events: Vec<EventKind>,
    pub canon: Vec<Checkpoint>,
    pub lex: Rc<Lexicon>,
    adj: Vec<Vec<(NodeId, EdgeId)>>,
    /// Кратчайшие расстояния в днях по всем рёбрам — для задержек каналов.
    dist: Vec<Vec<u16>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Path {
    pub nodes: Vec<NodeId>,
    pub edges: Vec<EdgeId>,
    pub days: i32,
}

fn yes() -> bool {
    true
}

impl Pack {
    /// Собирает пакет из частей JSON (граф карты и данные сценария), сливая объекты верхнего уровня.
    pub fn load(parts: &[&str]) -> Result<Rc<Pack>, String> {
        let mut root = serde_json::Map::new();
        for p in parts {
            match serde_json::from_str::<Value>(p).map_err(|e| e.to_string())? {
                Value::Object(m) => root.extend(m),
                _ => return Err("часть пакета — не объект".into()),
            }
        }
        let mut lex = Lexicon::default();
        let ids = |key: &str| -> Vec<String> {
            root.get(key)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.get("id")?.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        for (key, space) in [
            ("states", Space::State),
            ("nodes", Space::Node),
            ("regions", Space::Region),
            ("assets", Space::Asset),
            ("personas", Space::Persona),
            ("templates", Space::Template),
        ] {
            for id in ids(key) {
                lex.add(space, &id)?;
            }
        }
        for e in root.get("edges").and_then(Value::as_array).into_iter().flatten() {
            let (a, b) = (e["a"].as_str().unwrap_or("?"), e["b"].as_str().unwrap_or("?"));
            lex.add(Space::Edge, &format!("{a}~{b}"))?;
        }
        let lex = Rc::new(lex);
        let d: PackData = lex.scope(|| serde_json::from_value(Value::Object(root))).map_err(|e| format!("пакет: {e}"))?;

        let n = d.nodes.len();
        let mut adj = vec![Vec::new(); n];
        let mut dist = vec![vec![u16::MAX; n]; n];
        for (i, e) in d.edges.iter().enumerate() {
            if e.days == 0 || e.a == e.b {
                return Err(format!("ребро {i}: days = 0 или петля"));
            }
            adj[e.a.ix()].push((e.b, EdgeId(i as u16)));
            adj[e.b.ix()].push((e.a, EdgeId(i as u16)));
            let w = e.days as u16;
            dist[e.a.ix()][e.b.ix()] = w.min(dist[e.a.ix()][e.b.ix()]);
            dist[e.b.ix()][e.a.ix()] = w.min(dist[e.b.ix()][e.a.ix()]);
        }
        for (i, row) in dist.iter_mut().enumerate() {
            row[i] = 0;
        }
        for k in 0..n {
            for i in 0..n {
                for j in 0..n {
                    let via = dist[i][k].saturating_add(dist[k][j]);
                    if via < dist[i][j] {
                        dist[i][j] = via;
                    }
                }
            }
        }

        let pack = Pack {
            scenario: d.scenario,
            version: d.version,
            title: d.title,
            rules: d.rules,
            start_date: d.start_date,
            horizon: d.horizon,
            player: d.player,
            states: d.states,
            personas: d.personas,
            nodes: d.nodes,
            edges: d.edges,
            regions: d.regions,
            assets: d.assets,
            templates: d.templates,
            agreements: d.agreements,
            params: d.params,
            goal: d.goal,
            endless: d.endless,
            end_events: d.end_events,
            canon: d.canon,
            lex,
            adj,
            dist,
        };
        pack.check()?;
        Ok(Rc::new(pack))
    }

    fn check(&self) -> Result<(), String> {
        macro_rules! ordered {
            ($list:expr, $what:literal) => {
                for (i, x) in $list.iter().enumerate() {
                    if x.id.ix() != i {
                        return Err(format!("{}: id не по порядку на позиции {i}", $what));
                    }
                }
            };
        }
        ordered!(self.states, "states");
        ordered!(self.nodes, "nodes");
        ordered!(self.regions, "regions");
        ordered!(self.assets, "assets");
        ordered!(self.personas, "personas");
        ordered!(self.templates, "templates");
        for a in &self.assets {
            let node = &self.nodes[a.at.ix()];
            if a.kind.mode() == Mode::Sea && !(node.sea || node.port) {
                return Err(format!("актив {}: морской актив не в порту и не в море", a.name));
            }
            if a.kind.mode() == Mode::Rail && node.sea {
                return Err(format!("актив {}: армия в море", a.name));
            }
        }
        for key in crate::rules::rules(self.rules).required_nums() {
            if !self.params.n.contains_key(*key) {
                return Err(format!("params.n: нет числа {key:?}"));
            }
        }
        if parse_date(&self.start_date).is_none() {
            return Err("start_date: нужен формат ГГГГ-ММ-ДД".into());
        }
        Ok(())
    }

    /// Число-гипотеза: значение державы или общее.
    pub fn num(&self, s: StateId, key: &str) -> i32 {
        self.states[s.ix()].n.get(key).or_else(|| self.params.n.get(key)).copied().unwrap_or(0)
    }
    pub fn n(&self, key: &str) -> i32 {
        self.params.n.get(key).copied().unwrap_or(0)
    }

    /// Столица державы; у державы без столицы — первый узел графа (только для задержек каналов).
    pub fn capital(&self, s: StateId) -> NodeId {
        self.states[s.ix()].capital.unwrap_or(NodeId(0))
    }

    pub fn cost(&self, tag: OrderTag) -> u8 {
        self.params.cost.get(&tag).copied().unwrap_or(0)
    }

    pub fn persona_of(&self, s: StateId) -> Option<&PersonaDef> {
        self.personas.iter().find(|p| p.state == s && p.active)
    }

    pub fn state_ids(&self) -> impl Iterator<Item = StateId> {
        (0..self.states.len() as u8).map(StateId)
    }

    pub fn edge_between(&self, a: NodeId, b: NodeId) -> Option<EdgeId> {
        self.adj[a.ix()].iter().find(|(n, _)| *n == b).map(|(_, e)| *e)
    }

    pub fn neighbors(&self, a: NodeId) -> &[(NodeId, EdgeId)] {
        &self.adj[a.ix()]
    }

    pub fn dist(&self, a: NodeId, b: NodeId) -> u16 {
        self.dist[a.ix()][b.ix()]
    }

    /// Задержка канала между двумя узлами, дни.
    pub fn delay(&self, ch: Channel, from: NodeId, to: NodeId) -> Day {
        match self.params.channels.get(&ch) {
            Some(c) if c.per > 0 => c.base as Day + (self.dist(from, to).min(1000) / c.per as u16) as Day,
            Some(c) => c.base as Day,
            None => 0,
        }
    }

    /// Задержка дипломатического канала между столицами двух держав.
    pub fn embassy_delay(&self, a: StateId, b: StateId) -> Day {
        self.delay(Channel::Embassy, self.capital(a), self.capital(b))
    }

    /// Кратчайшие пути из `from` по рёбрам вида `mode`: (дни, предыдущий узел).
    /// Равные пути разрешаются детерминированно — меньшим индексом узла.
    fn dijkstra(&self, mode: Mode, from: NodeId) -> Vec<(i32, Option<NodeId>)> {
        let n = self.nodes.len();
        let mut best: Vec<(i32, Option<NodeId>)> = vec![(i32::MAX, None); n];
        let mut done = vec![false; n];
        best[from.ix()].0 = 0;
        while let Some(u) = (0..n).filter(|&i| !done[i] && best[i].0 < i32::MAX).min_by_key(|&i| (best[i].0, i)) {
            done[u] = true;
            for &(v, e) in &self.adj[u] {
                let edge = &self.edges[e.ix()];
                if edge.mode != mode {
                    continue;
                }
                let d = best[u].0 + edge.days as i32;
                if d < best[v.ix()].0 {
                    best[v.ix()] = (d, Some(NodeId(u as u16)));
                }
            }
        }
        best
    }

    fn trace(&self, best: &[(i32, Option<NodeId>)], to: NodeId) -> Option<Path> {
        if best[to.ix()].0 == i32::MAX {
            return None;
        }
        let mut nodes = vec![to];
        let mut cur = to;
        while let Some(prev) = best[cur.ix()].1 {
            nodes.push(prev);
            cur = prev;
        }
        nodes.reverse();
        let edges = nodes.windows(2).map(|w| self.edge_between(w[0], w[1]).expect("ребро пути")).collect();
        Some(Path { nodes, edges, days: best[to.ix()].0 })
    }

    pub fn path(&self, mode: Mode, from: NodeId, to: NodeId) -> Option<Path> {
        if from == to {
            return None;
        }
        self.trace(&self.dijkstra(mode, from), to)
    }

    /// Все достижимые цели из `from`, ближайшие первыми.
    pub fn reachable(&self, mode: Mode, from: NodeId) -> Vec<Path> {
        let best = self.dijkstra(mode, from);
        let mut out: Vec<Path> = (0..self.nodes.len() as u16).filter(|&i| NodeId(i) != from).filter_map(|i| self.trace(&best, NodeId(i))).collect();
        out.sort_by_key(|p| (p.days, *p.nodes.last().unwrap()));
        out
    }

    pub fn template(&self, id: TemplateId) -> &Template {
        &self.templates[id.ix()]
    }

    /// Календарная дата дня партии, «ГГГГ-ММ-ДД».
    pub fn date(&self, day: Day) -> String {
        let (y, m, d) = parse_date(&self.start_date).unwrap_or((1, 1, 1));
        let (y, m, d) = civil_from_days(days_from_civil(y, m, d) + day as i64);
        format!("{y:04}-{m:02}-{d:02}")
    }

    pub fn to_json<T: serde::Serialize>(&self, v: &T) -> String {
        self.lex.scope(|| serde_json::to_string(v)).expect("сериализация")
    }
    pub fn from_json<T: serde::de::DeserializeOwned>(&self, s: &str) -> Result<T, String> {
        self.lex.scope(|| serde_json::from_str(s)).map_err(|e| e.to_string())
    }
    pub fn from_value<T: serde::de::DeserializeOwned>(&self, v: Value) -> Result<T, String> {
        self.lex.scope(|| serde_json::from_value(v)).map_err(|e| e.to_string())
    }
}

fn parse_date(s: &str) -> Option<(i64, i64, i64)> {
    let mut it = s.split('-').map(|p| p.parse::<i64>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

// Григорианский календарь целыми числами (алгоритм Хиннанта).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}
