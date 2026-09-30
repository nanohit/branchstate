//! CLI ядра: партия в терминале, автопрогоны `scripted`, экспорт и воспроизведение журнала.

use branchstate_core::model::*;
use branchstate_core::pack::Pack;
use branchstate_core::protocol::{RunHeader, RunMode};
use branchstate_core::reports::date_ru;
use branchstate_core::run::{check_laws, replay, DayInputs, DayRecord, Run};
use std::collections::BTreeMap;
use std::rc::Rc;

fn load(scenario: &str) -> Rc<Pack> {
    let read = |f: &str| std::fs::read_to_string(format!("scenarios/{scenario}/{f}")).unwrap_or_else(|e| panic!("scenarios/{scenario}/{f}: {e}"));
    Pack::load(&[&read("map.json"), &read("scenario.json")]).unwrap_or_else(|e| panic!("{e}"))
}

/// Партия `scripted`: игрок на автопилоте своей резервной политики.
fn play(pack: &Rc<Pack>, seed: u64, mut each: impl FnMut(&Run, &DayRecord)) -> (Run, Vec<DayRecord>) {
    let mut run = Run::new(pack.clone(), seed);
    let mut journal = Vec::new();
    while !run.ended() {
        let rec = run.step(&DayInputs { player: run.autopilot(), actors: BTreeMap::new() });
        if let Err(e) = check_laws(&run) {
            panic!("сид {seed}, день {}: {e}", rec.day);
        }
        if !rec.hard.is_empty() || !rec.soft.is_empty() {
            run.mark_stop();
        }
        each(&run, &rec);
        journal.push(rec);
    }
    (run, journal)
}

fn outcome(run: &Run) -> String {
    let end = run.world.ended.as_ref().expect("партия окончена");
    match (&end.reason, &run.world.goal) {
        (EndReason::EndEvent, _) => "большая война".into(),
        (EndReason::Crisis, _) => "правительственный кризис".into(),
        (_, GoalStatus::Achieved(_)) => "цель достигнута".into(),
        (_, GoalStatus::Failed(_)) => "цель провалена".into(),
        _ => "дата предела".into(),
    }
}

fn header(pack: &Pack, seed: u64) -> RunHeader {
    RunHeader {
        format: 1,
        scenario: pack.scenario.clone(),
        pack_version: pack.version.clone(),
        engine_version: branchstate_core::ENGINE_VERSION.into(),
        runtime_manifest_id: "cli".into(),
        seed: seed as u32,
        mode: RunMode::Scripted,
        parent_id: None,
        fork_day: None,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).map(String::as_str);
    let num = |i: usize, default: u64| arg(i).and_then(|s| s.parse().ok()).unwrap_or(default);
    match arg(0) {
        Some("play") => {
            let pack = load(arg(1).unwrap_or("island"));
            let mut shown = 0;
            let (run, _) = play(&pack, num(2, 1), |run, rec| {
                let st = &run.world.states[pack.player.ix()];
                let res: Vec<String> = st.res.iter().map(|(k, v)| format!("{k:?} {v}")).collect();
                println!("— {} (день {}) · {} · инициатива {}", date_ru(&pack, rec.day), rec.day, res.join(", "), st.init);
                for k in &rec.inputs.player {
                    println!("    приказ: {}", branchstate_core::orders::act_name(&pack, &run.player_obs(), k));
                }
                let reports = run.current_reports();
                for r in &reports[shown.min(reports.len())..] {
                    println!("    {}: {}", r.title, r.facts);
                }
                shown = reports.len();
            });
            let s = run.summary().expect("итог");
            println!("\nИсход: {} ({}). Цель «{}»: {:?}", outcome(&run), date_ru(&pack, s.day), s.goal_label, s.goal);
            for c in &s.checkpoints {
                println!("  канон {} — {}: {:?}", c.date, c.label, c.state);
            }
            for line in &s.chain {
                println!("  ← {line}");
            }
        }
        Some("autorun") => {
            let pack = load(arg(1).unwrap_or("island"));
            let n = num(2, 1000);
            let mut outcomes: BTreeMap<String, u32> = BTreeMap::new();
            let (mut days, mut agreements, mut violated) = (0i64, 0usize, 0usize);
            for seed in 1..=n {
                let (run, journal) = play(&pack, seed, |_, _| {});
                *outcomes.entry(outcome(&run)).or_default() += 1;
                days += journal.len() as i64;
                agreements += run.world.agreements.len();
                violated += run.world.agreements.values().filter(|a| a.status == AStatus::Violated).count();
            }
            println!("{}: {n} партий без нарушения законов", pack.title);
            for (k, v) in &outcomes {
                println!("  {k}: {v} ({:.1}%)", *v as f64 * 100.0 / n as f64);
            }
            println!("  средняя длина: {:.1} дн.; нарушено соглашений: {:.1}%", days as f64 / n as f64, violated as f64 * 100.0 / agreements.max(1) as f64);
        }
        Some("export") => {
            let pack = load(arg(1).unwrap_or("island"));
            let seed = num(2, 1);
            let (_, journal) = play(&pack, seed, |_, _| {});
            println!("{}", pack.to_json(&header(&pack, seed)));
            for rec in &journal {
                println!("{}", pack.to_json(rec));
            }
        }
        Some("replay") => {
            let text = std::fs::read_to_string(arg(1).expect("файл партии")).expect("чтение файла");
            let mut lines = text.lines();
            let head: serde_json::Value = serde_json::from_str(lines.next().expect("заголовок")).expect("заголовок");
            let pack = load(head["scenario"].as_str().expect("scenario"));
            let journal: Vec<DayRecord> = lines.filter(|l| !l.is_empty()).map(|l| pack.from_json(l).expect("запись дня")).collect();
            match replay(pack.clone(), head["seed"].as_u64().expect("seed"), &journal) {
                Ok(run) => println!("ok: {} дней, хэш {}", journal.len(), run.hash()),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        _ => eprintln!("sim play|autorun|export <сценарий> [сид|число] · sim replay <файл.jsonl>"),
    }
}
