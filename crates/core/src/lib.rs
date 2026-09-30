//! Детерминированное ядро BranchState. Без ввода-вывода, времени, async и потоков.
//!
//! Три уровня: `World` — истина, `Minds` — знание и мысли акторов, `Observation` — проекция
//! для одного актора на один день. Факты меняет только `resolve`.

pub mod agents;
pub mod goals;
pub mod ids;
pub mod knowledge;
pub mod model;
pub mod observe;
pub mod orders;
pub mod pack;
pub mod protocol;
pub mod reports;
pub mod resolve;
pub mod rng;
pub mod rules;
pub mod run;
pub mod view;

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Версия протокола Worker ↔ интерфейс; записана в манифест комплекта.
pub const PROTOCOL_VERSION: u32 = 1;
