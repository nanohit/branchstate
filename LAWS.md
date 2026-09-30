# Законы BranchState

Инварианты, которые не может нарушить ни код, ни ответ модели. Источник — спецификация ядра;
здесь — где каждый закон живёт в коде и чем проверяется. Менять закон можно только правкой спеки.

| # | Закон | Где в коде | Чем проверяется |
| --- | --- | --- | --- |
| L1 | Детерминизм: `replay(pack, seed, journal)` даёт те же хэши на каждом дне; в журнале — все внешние входы | `run.rs`: `step`, `replay`, `DayInputs` | `replay_gives_same_hashes`, `golden_replays` (native и WASM), proptest |
| L2 | Горизонт: наблюдение актора строится только из его фактов, его `Knowledge` и публичной статики | `observe.rs`: `observe` | `hidden_facts_do_not_leak`, proptest |
| L3 | Факты меняет только `resolve`; ответ модели — намерения, убеждения и план через `validate_intent` | `resolve.rs`; `agents.rs` не знает типа `World` | `core_sources_obey_determinism_rules`, `arrival_order_does_not_matter` |
| L4 | Паритет: игрок и акторы — одни `OrderKind`, одна инициатива, одна проверка по своему наблюдению | `orders.rs`: `validate_intent` | автопрогоны: игрок на той же резервной политике |
| L5 | Обязательство заканчивается записанным событием `Fulfilled`, `Breach` или `Expired` | `resolve.rs`: `commitments` | `check_laws` после каждого дня |
| L6 | Нет сирот: у события есть причина — намерение, событие, решение или правило сценария | `resolve.rs`: `Ctx::emit` | `check_laws` после каждого дня |
| L7 | Превью — функция наблюдения; гарантированные поля совпадают с резервом `resolve` | `orders.rs`: `preview` | `preview_matches_resolve_without_hidden_obstacles`, proptest, дифф-тест |
| L8 | Сохранение: актив в одном месте; ресурс не ниже нуля | `resolve.rs`, `rules.rs` | `check_laws` после каждого дня |
| L9 | Своё действие определено: намерение хранится точно, искажаться может только чужое знание | `knowledge.rs`: канал `Direct`, `claims` отдельно от события | proptest |
| L10 | Меню не разведывает: набор принимаемых намерений зависит только от наблюдения | `orders.rs`: `menu`, `move_options` | `hidden_facts_do_not_leak`, proptest |
| L11 | Опоздание ничего не переписывает: результат после дедлайна дня не меняет разрешённые дни | `web/src/worker/host.ts`: `collect`, `day_inputs` | тесты «неизменность резерва», `arrival_order_does_not_matter` |
| L12 | Инициатива восстанавливается только игровыми днями; остановки на неё не влияют | `resolve.rs`: начисление в конце дня | `stops_do_not_matter`, «Дальше» против «Ждать N дней» |

Правила детерминизма ядра (`crates/core`): нет ввода-вывода, системного времени, async и потоков;
нет итерации по `HashMap`/`HashSet`; нет `f32`/`f64` в состоянии; ГПСЧ — ChaCha8 с отдельным потоком
на цель (`rng.rs`); хэш состояния — blake3 от postcard. Проверяет `core_sources_obey_determinism_rules`.
