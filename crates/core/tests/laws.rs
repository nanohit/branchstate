//! Законы L1–L12 как тесты: автопрогоны, воспроизведение, независимость от остановок и порядка
//! прихода, дифференциальный тест утечек, случайные последовательности намерений.

use branchstate_core::agents;
use branchstate_core::ids::*;
use branchstate_core::model::*;
use branchstate_core::observe::observe;
use branchstate_core::orders::{self, menu, move_options, preview};
use branchstate_core::pack::Pack;
use branchstate_core::run::{check_laws, replay, DayInputs, DayRecord, Run};
use branchstate_core::view::{player_view, Phase, Session};
use proptest::prelude::*;
use std::collections::BTreeMap;
use std::rc::Rc;

fn island() -> Rc<Pack> {
    Pack::load(&[include_str!("../../../scenarios/island/map.json"), include_str!("../../../scenarios/island/scenario.json")]).unwrap()
}

fn july() -> Rc<Pack> {
    Pack::load(&[include_str!("../../../scenarios/july1914/map.json"), include_str!("../../../scenarios/july1914/scenario.json")]).unwrap()
}

fn packs() -> [Rc<Pack>; 2] {
    [island(), july()]
}

fn scripted_day(run: &mut Run) -> DayRecord {
    let rec = run.step(&DayInputs { player: run.autopilot(), actors: BTreeMap::new() });
    check_laws(run).unwrap_or_else(|e| panic!("сид {}, день {}: {e}", run.seed, rec.day));
    rec
}

fn scripted(pack: &Rc<Pack>, seed: u64, until: Day) -> (Run, Vec<DayRecord>) {
    let mut run = Run::new(pack.clone(), seed);
    let mut journal = Vec::new();
    while !run.ended() && run.day() < until {
        journal.push(scripted_day(&mut run));
    }
    (run, journal)
}

fn outcome(run: &Run) -> String {
    format!("{:?} / {:?}", run.world.ended.as_ref().map(|e| &e.reason), std::mem::discriminant(&run.world.goal) == std::mem::discriminant(&GoalStatus::Open))
}

/// Критерий готовности: 1000 автопрогонов `scripted` без нарушения законов, распределение исходов записано.
#[test]
fn autoruns_keep_laws() {
    for pack in packs() {
        let mut outcomes: BTreeMap<String, u32> = BTreeMap::new();
        for seed in 1..=1000 {
            let (run, journal) = scripted(&pack, seed, Day::MAX);
            assert!(run.ended() && journal.len() as Day <= pack.horizon + 1);
            *outcomes.entry(format!("{:?}", run.world.ended.as_ref().unwrap().reason)).or_default() += 1;
        }
        println!("{}: {outcomes:?}", pack.title);
        assert!(outcomes.len() >= 2, "{}: все партии кончаются одинаково — {outcomes:?}", pack.title);
    }
}

/// L1: воспроизведение журнала даёт те же хэши на каждом дне; снимок продолжает партию так же.
#[test]
fn replay_gives_same_hashes() {
    for pack in packs() {
        for seed in [1, 7, 42] {
            let (run, journal) = scripted(&pack, seed, Day::MAX);
            let again = replay(pack.clone(), seed, &journal).unwrap();
            assert_eq!(again.hash(), run.hash());

            let half = journal.len() / 2;
            let (mid, _) = scripted(&pack, seed, half as Day);
            let mut restored = Run::restore(pack.clone(), &mid.snapshot()).unwrap();
            assert_eq!(restored.hash(), mid.hash());
            branchstate_core::run::replay_onto(&mut restored, &journal[half..]).unwrap();
            assert_eq!(restored.hash(), run.hash());

            // Журнал переживает сериализацию в JSON Lines.
            let lines: Vec<String> = journal.iter().map(|r| pack.to_json(r)).collect();
            let parsed: Vec<DayRecord> = lines.iter().map(|l| pack.from_json(l).unwrap()).collect();
            assert_eq!(replay(pack.clone(), seed, &parsed).unwrap().hash(), run.hash());
        }
    }
}

/// Золотые воспроизведения: фиксированные журналы дают те же хэши. Те же файлы проверяет WASM.
#[test]
fn golden_replays() {
    for (pack, text) in [(island(), include_str!("golden/island.jsonl")), (july(), include_str!("golden/july1914.jsonl"))] {
        let mut lines = text.lines();
        let head: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        let journal: Vec<DayRecord> = lines.filter(|l| !l.is_empty()).map(|l| pack.from_json(l).unwrap()).collect();
        assert!(!journal.is_empty());
        replay(pack.clone(), head["seed"].as_u64().unwrap(), &journal).unwrap_or_else(|e| panic!("{}: {e}", pack.title));
    }
}

/// L12: график остановок не влияет на мир и инициативу.
#[test]
fn stops_do_not_matter() {
    for pack in packs() {
        let (a, journal) = scripted(&pack, 5, Day::MAX);
        let mut b = Run::new(pack.clone(), 5);
        for rec in &journal {
            b.step(&rec.inputs);
            b.mark_stop();
        }
        assert_eq!(a.hash(), b.hash());
        assert_eq!(a.world.states.iter().map(|s| s.init).collect::<Vec<_>>(), b.world.states.iter().map(|s| s.init).collect::<Vec<_>>());
    }
}

fn model_input(pack: &Pack, req: &agents::DecideRequest) -> serde_json::Value {
    let goal = &pack.personas[req.persona.ix()].interests[0].key;
    let today: Vec<&String> = req.brief.menu.iter().filter(|m| m.id.starts_with("accept:")).map(|m| &m.id).collect();
    serde_json::json!({ "today": today, "plan": { "goal": goal, "steps": [], "review_if": [{ "Days": { "n": 3 } }] }, "beliefs": [], "reason": "тест" })
}

/// Порядок прихода ответов операций не влияет на хэш дня; ответ модели действительно применяется.
#[test]
fn arrival_order_does_not_matter() {
    let pack = island();
    let mut run = Run::new(pack.clone(), 3);
    let obs = run.player_obs();
    let offers: Vec<OrderKind> = menu(&pack, &obs, &[]).into_iter().filter(|a| a.id == "tpl:trn_mar_access" || a.id == "tpl:trn_ske_access").filter_map(|a| a.intent).collect();
    assert_eq!(offers.len(), 2);
    run.step(&DayInputs { player: offers, actors: BTreeMap::new() });
    let needs = run.needs();
    assert_eq!(needs.len(), 2, "оба адресата предложений пересматривают план");

    let answers: Vec<(String, serde_json::Value)> = needs.iter().map(|r| (pack.lex.name(Space::State, r.actor.0 as u16).to_string(), serde_json::json!({ "Model": model_input(&pack, r) }))).collect();
    let inputs = |order: &[usize]| -> DayInputs {
        let actors: Vec<String> = order.iter().map(|&i| format!("{:?}:{}", answers[i].0, answers[i].1)).collect();
        pack.from_json(&format!("{{\"player\":[],\"actors\":{{{}}}}}", actors.join(","))).unwrap()
    };
    let snapshot = run.snapshot();
    let mut a = Run::restore(pack.clone(), &snapshot).unwrap();
    let mut b = Run::restore(pack.clone(), &snapshot).unwrap();
    let ra = a.step(&inputs(&[0, 1]));
    let rb = b.step(&inputs(&[1, 0]));
    assert_eq!(ra.hash, rb.hash);
    assert!(ra.rejected.is_empty(), "{:?}", ra.rejected);
    assert!(ra.sources.values().filter(|s| **s == Source::Model).count() == 2);
    assert_eq!(a.world.agreements.len(), 2, "модель приняла оба предложения");

    // Отказ проверки — резервная политика, а не падение.
    let mut c = Run::restore(pack.clone(), &snapshot).unwrap();
    let bad: DayInputs = pack.from_json(r#"{"player":[],"actors":{"MAR":{"Model":{"today":["war:XXX"],"plan":{"goal":"trade_income","steps":[]}}}}}"#).unwrap();
    let rc = c.step(&bad);
    assert_eq!(rc.sources[&needs.iter().find(|r| rc.rejected.contains_key(&r.actor)).unwrap().actor], Source::Fallback);

    // L11: ответ для актора, которому пересмотр не нужен, ничего не меняет.
    let mut d = Run::restore(pack.clone(), &a.snapshot()).unwrap();
    let mut e = Run::restore(pack.clone(), &a.snapshot()).unwrap();
    assert!(d.needs().iter().all(|r| pack.lex.name(Space::State, r.actor.0 as u16) != "VOL"));
    let late: DayInputs = pack.from_json(r#"{"player":[],"actors":{"VOL":{"Model":{"today":[],"plan":{"goal":"tribute","steps":[]}}}}}"#).unwrap();
    assert_eq!(d.step(&late).hash, e.step(&DayInputs::default()).hash);
}

/// Скрытые факты, которых нет в наблюдении игрока: положение невидимых активов, чужие ресурсы,
/// скрытая мобилизация, чужие планы и переговоры.
fn mutate_hidden(run: &mut Run) {
    let pack = run.pack.clone();
    let player = pack.player;
    let obs = run.player_obs();
    let day = run.day();
    for a in run.world.assets.iter_mut().filter(|a| a.owner != player) {
        let seen_now = obs.contact(a.id).is_some_and(|c| c.day == day) || obs.sightings.iter().any(|s| s.node == a.at && s.day == day);
        let own_near = |n: NodeId| obs.assets.iter().any(|x| x.at == n) || obs.regions[..].iter().enumerate().any(|(r, o)| o.0 == player && pack.nodes[n.ix()].region == Some(RegionId(r as u16)));
        if !seen_now && !matches!(a.status, Status::Moving { .. }) {
            if let Some(&(to, _)) = pack.neighbors(a.at).iter().find(|(n, e)| pack.edges[e.ix()].mode == a.kind.mode() && !own_near(*n)) {
                a.at = to;
                a.cargo += 3;
            }
        }
    }
    for (i, s) in run.world.states.iter_mut().enumerate() {
        if StateId(i as u8) != player {
            if let Some(t) = s.res.get_mut(&Res::Treasury) {
                *t += 17;
            }
            if s.res.contains_key(&Res::Mobilization) && s.mob_target.is_none() && s.res[&Res::Mobilization] == 0 {
                s.mob_target = Some((1, day + 5));
            }
            s.init = s.init.saturating_sub(1);
        }
    }
    for (i, m) in run.minds.actors.iter_mut().enumerate() {
        if StateId(i as u8) != player {
            m.plan.steps.clear();
            m.review.push(Trigger::PlanExhausted);
        }
    }
    let others: Vec<StateId> = pack.state_ids().filter(|s| *s != player).take(2).collect();
    let id = run.world.fresh_id();
    run.world.proposals.insert(id, Proposal { id, from: others[0], to: others[1], terms: vec![Term::Pay { from: others[0], to: others[1], amount: 5, every: 0, times: 1 }], created: day, expires: day + 3, status: PStatus::Pending, template: None, ultimatum: false, counter_of: None, order: 0 });
}

/// Кандидаты приказов игрока: всё меню и перемещения всех свободных активов.
fn candidates(pack: &Pack, run: &Run) -> Vec<OrderKind> {
    let obs = run.player_obs();
    let staged = run.staged_kinds();
    let mut out: Vec<OrderKind> = menu(pack, &obs, &staged).into_iter().filter_map(|a| a.intent).collect();
    for a in &obs.assets {
        for t in move_options(pack, &obs, &staged, a.id).targets {
            for stance in t.stances {
                out.push(OrderKind::Move { asset: a.id, to: t.node, stance });
            }
        }
    }
    out
}

/// Дифференциальный тест утечек (L2, L7, L10): два мира с одинаковым наблюдением игрока и разными
/// скрытыми фактами дают одинаковые превью, меню и представление.
#[test]
fn hidden_facts_do_not_leak() {
    for pack in packs() {
        for seed in 1..=25 {
            for until in [0, 2, 5, 8] {
                let (a, _) = scripted(&pack, seed, until);
                if a.ended() {
                    continue;
                }
                let mut b = Run::restore(pack.clone(), &a.snapshot()).unwrap();
                mutate_hidden(&mut b);
                assert_ne!(a.hash(), b.hash(), "скрытые факты действительно различаются");
                let (oa, ob) = (a.player_obs(), b.player_obs());
                assert_eq!(oa, ob, "наблюдение игрока не зависит от скрытого");
                assert_eq!(menu(&pack, &oa, &[]), menu(&pack, &ob, &[]));
                let cands = candidates(&pack, &a);
                assert_eq!(cands, candidates(&pack, &b));
                for c in &cands {
                    assert_eq!(preview(&pack, &oa, std::slice::from_ref(c)), preview(&pack, &ob, std::slice::from_ref(c)));
                }
                assert_eq!(player_view(&a, Phase::AtStop, &[]), player_view(&b, Phase::AtStop, &[]));

                // Скрытые изменения мира без изменения наблюдения дают пустой патч.
                let mut s = Session::new(Run::restore(pack.clone(), &a.snapshot()).unwrap(), "r".into(), 1, Vec::new());
                mutate_hidden(&mut s.run);
                assert!(s.refresh().is_none());
            }
        }
    }
}

/// Туман войны: уничтоженный или ушедший чужой актив остаётся на последней известной позиции,
/// пока игрок об этом не узнал.
#[test]
fn stale_contacts_stay_until_learned() {
    let pack = island();
    let (mut run, _) = scripted(&pack, 2, 1);
    let vol = pack.assets.iter().find(|a| pack.lex.name(Space::Asset, a.id.0) == "vol_flotilla").unwrap().id;
    let before = run.player_obs().contact(vol).cloned().unwrap();
    run.world.assets[vol.ix()].alive = false;
    scripted_day(&mut run);
    let after = run.player_obs().contact(vol).cloned().unwrap();
    assert_eq!((before.node, before.day), (after.node, after.day));
    let view = player_view(&run, Phase::AtStop, &[]);
    assert!(view.map.markers.contains_key("c:vol_flotilla"));
}

/// L7 на мирах без скрытого: оценки превью совпадают с результатом `resolve`.
#[test]
fn preview_matches_resolve_without_hidden_obstacles() {
    let pack = island();
    let mut run = Run::new(pack.clone(), 1);
    let convoy = pack.assets[0].id;
    let skerry = pack.nodes.iter().find(|n| n.name == "Скерри").unwrap().id;
    let order = OrderKind::Move { asset: convoy, to: skerry, stance: Stance::Hold };
    let p = run.preview(std::slice::from_ref(&order));
    assert!(p.reject.is_none());
    let (arrive, left) = (p.orders[0].arrive.unwrap(), p.initiative_left);
    assert!(p.orders[0].incursion.is_some(), "в Скерри нет доступа — превью предупреждает о нарушении границы");
    run.commit(&[order]).unwrap();
    let inputs = DayInputs { player: run.staged_kinds(), actors: BTreeMap::new() };
    run.step(&inputs);
    assert_eq!(run.world.states[pack.player.ix()].init, left, "инициатива потрачена ровно как в превью");
    assert_eq!(run.world.assets[convoy.ix()].reserved_until, arrive);
    while run.day() < arrive {
        run.step(&DayInputs::default());
    }
    assert_eq!(run.world.assets[convoy.ix()].at, skerry, "прибытие в срок по известному пути");
    assert!(run.world.events.iter().any(|e| e.kind == EventKind::Incursion && e.f.asset == Some(convoy)));
}

/// Физически невозможное отклоняется; политически запрещённое исполняется и фиксируется.
#[test]
fn physical_rejected_political_recorded() {
    let pack = island();
    let mut run = Run::new(pack.clone(), 1);
    let obs = run.player_obs();
    let foreign = pack.assets.iter().find(|a| a.owner != pack.player).unwrap().id;
    let mar = pack.assets.iter().find(|a| a.owner != pack.player).unwrap().owner;
    let reject = |k: OrderKind| orders::validate_intent(&pack, &obs, &[k]).unwrap_err().reason;
    assert_eq!(reject(OrderKind::Move { asset: foreign, to: NodeId(0), stance: Stance::Hold }), orders::Reason::NotYours);
    assert_eq!(reject(OrderKind::Pay { to: mar, amount: 10_000 }), orders::Reason::NoFunds);
    let convoy = pack.assets[0].id;
    let twice = [OrderKind::Move { asset: convoy, to: NodeId(4), stance: Stance::Hold }, OrderKind::Move { asset: convoy, to: NodeId(5), stance: Stance::Hold }];
    assert_eq!(orders::validate_intent(&pack, &obs, &twice).unwrap_err().reason, orders::Reason::Busy);

    // Отмена платежа по графику исполняется и становится нарушением; превью предупреждает заранее.
    let offer = menu(&pack, &obs, &[]).into_iter().find(|a| a.id == "tpl:trn_mar_access").unwrap().intent.unwrap();
    run.step(&DayInputs { player: vec![offer], actors: BTreeMap::new() });
    run.step(&DayInputs::default());
    run.step(&DayInputs::default());
    let obs = run.player_obs();
    let cancel = menu(&pack, &obs, &[]).into_iter().find(|a| a.kind == OrderTag::Cancel).expect("отмена платежей в меню").intent.unwrap();
    assert_eq!(preview(&pack, &obs, std::slice::from_ref(&cancel)).orders[0].breaches.len(), 1);
    run.step(&DayInputs { player: vec![cancel], actors: BTreeMap::new() });
    assert!(run.world.events.iter().any(|e| e.kind == EventKind::Breach && e.f.actor == Some(pack.player)));
    assert!(run.world.agreements.values().any(|a| a.status == AStatus::Violated));
    check_laws(&run).unwrap();
}

/// Правила детерминизма и L3 как линт исходников ядра.
#[test]
fn core_sources_obey_determinism_rules() {
    let sources = [
        ("agents", include_str!("../src/agents.rs")),
        ("goals", include_str!("../src/goals.rs")),
        ("ids", include_str!("../src/ids.rs")),
        ("knowledge", include_str!("../src/knowledge.rs")),
        ("model", include_str!("../src/model.rs")),
        ("observe", include_str!("../src/observe.rs")),
        ("orders", include_str!("../src/orders.rs")),
        ("pack", include_str!("../src/pack.rs")),
        ("reports", include_str!("../src/reports.rs")),
        ("resolve", include_str!("../src/resolve.rs")),
        ("rng", include_str!("../src/rng.rs")),
        ("rules", include_str!("../src/rules.rs")),
        ("run", include_str!("../src/run.rs")),
        ("view", include_str!("../src/view.rs")),
    ];
    for (name, src) in sources {
        for banned in ["HashMap", "HashSet", "f32", "f64", "std::time", "std::fs", "std::net", "async ", "thread::", "Instant"] {
            assert!(!src.contains(banned), "{name}.rs: запрещено в ядре — {banned}");
        }
    }
    // L3, L7, L10: агентный слой, проверка, превью и меню не видят типа `World`.
    for (name, src) in sources.iter().filter(|(n, _)| ["agents", "orders"].contains(n)) {
        assert!(!src.contains("World"), "{name}.rs не должен знать о World");
    }
}

fn initiative_after(pack: &Pack, before: &StateDyn, spent: u8, s: StateId) -> u8 {
    let def = &pack.states[s.ix()];
    let left = before.init - spent;
    if def.regen > 0 && before.regen_clock + 1 >= def.regen { (left + 1).min(def.capacity) } else { left }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    /// Законы на случайных последовательностях намерений игрока, оба сценария.
    #[test]
    fn random_intents_keep_laws(seed in 1u64..10_000, scenario in 0usize..2, picks in prop::collection::vec((any::<u16>(), any::<u16>()), 40)) {
        let pack = packs()[scenario].clone();
        let player = pack.player;
        let mut run = Run::new(pack.clone(), seed);
        let mut journal = Vec::new();
        for (p1, p2) in picks {
            if run.ended() {
                break;
            }
            for p in [p1, p2] {
                let cands = candidates(&pack, &run);
                // Один раз из трёх игрок ничего не делает.
                if cands.is_empty() || p % 3 == 0 {
                    continue;
                }
                let k = cands[p as usize % cands.len()].clone();
                // L10: всё, что предложило меню, принимается.
                prop_assert!(run.commit(&[k]).is_ok());
            }
            let obs = run.player_obs();
            let staged = run.staged_kinds();
            let pv = preview(&pack, &obs, &staged);
            prop_assert!(pv.reject.is_none());
            let before = run.world.states[player.ix()].clone();
            let rec = run.step(&DayInputs { player: staged.clone(), actors: BTreeMap::new() });
            prop_assert!(check_laws(&run).is_ok(), "{:?}", check_laws(&run));

            // L7: гарантированные поля превью совпали с резервом `resolve`.
            let spent = before.init - pv.initiative_left;
            prop_assert_eq!(run.world.states[player.ix()].init, initiative_after(&pack, &before, spent, player));
            // L9: своё намерение хранится точно.
            let mine: Vec<&OrderKind> = run.world.orders.values().filter(|o| o.actor == player && o.day == rec.day && o.source == Source::Player).map(|o| &o.kind).collect();
            prop_assert_eq!(mine, staged.iter().collect::<Vec<_>>());
            // L2: наблюдение не содержит сведений из будущего.
            let now = run.player_obs();
            prop_assert!(now.news.iter().all(|k| k.received <= now.day && k.event_day < now.day));
            journal.push(rec);
        }
        // L1: воспроизведение даёт те же хэши.
        let again = replay(pack.clone(), seed, &journal);
        prop_assert!(again.is_ok(), "{:?}", again.err());
        prop_assert_eq!(again.unwrap().hash(), run.hash());
        let _ = (observe(&run.world, &run.minds, player), outcome(&run));
    }
}
