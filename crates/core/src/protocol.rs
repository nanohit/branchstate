//! Сообщения Worker ↔ интерфейс. Из этих типов генерируется `web/src/protocol.gen.ts`:
//! расхождение ломает сборку, а не игру.

use crate::agents::DecideRequest;
use crate::reports::{NarrateBrief, Narration};
use crate::ids::*;
use crate::model::*;
use crate::orders::{MoveOptions, Preview};
use crate::run::DayRecord;
use crate::view::{Phase, ViewSnapshot, ViewUpdate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

data! {
    pub enum AdvanceMode { Next, Days(u8) }

    pub enum RunMode { Scripted, Llm }

    #[serde(tag = "t")]
    pub enum CommandBody {
        Commit { intents: Vec<OrderKind> },
        Cancel { order_id: u32 },
        Advance { mode: AdvanceMode },
        Fork { day: Day },
        NewRun { scenario: String, seed: Option<u32>, daily: bool, mode: RunMode },
        Import { file: String },
    }

    /// `run_id` — партия команды; у `NewRun` и `Import` — id создаваемой партии.
    pub struct Command { pub run_id: String, pub command_id: String, pub expected_rev: u32, pub body: CommandBody }

    pub enum RejectCode { Stale, CommandConflict, Invalid, Storage, NotWriter, Busy }

    #[serde(tag = "t")]
    pub enum Outcome {
        Accepted,
        Rejected { reason: RejectCode, current_rev: Option<u32>, detail: Option<String> },
    }

    pub struct FileRef { pub url: String, pub sri: String }

    pub struct ScenarioFiles { pub title: String, pub pack_version: String, pub pack: FileRef, pub geo_bin: FileRef, pub geo_json: FileRef }

    /// Комплект версий: UI, шим-независимое ядро, WASM, сценарии и геометрия. `id` — хэш содержимого.
    pub struct RuntimeManifest {
        pub id: String,
        pub protocol: u32,
        pub engine_version: String,
        pub ui: FileRef,
        pub core: FileRef,
        pub wasm: FileRef,
        pub fonts: Vec<FileRef>,
        pub scenarios: BTreeMap<String, ScenarioFiles>,
    }

    #[serde(tag = "t")]
    pub enum ToWorker {
        /// Первое сообщение соединения с новым `epoch`; `run_id` — открыть партию.
        Open { epoch: String, run_id: Option<String>, manifest: RuntimeManifest, proxy: Option<String>, steal: bool },
        Command(Command),
        Preview { req_id: u32, rev: u32, intents: Vec<OrderKind> },
        MoveOptions { req_id: u32, rev: u32, asset_id: AssetId },
        Resync { have_rev: u32 },
        Export { run_id: String },
        Ping { n: u32 },
        Visibility { hidden: bool },
        /// Измерение интерфейса; копится в Worker и уходит пачкой на посредника.
        Metric { name: String, value: i32 },
    }

    #[serde(tag = "t")]
    pub enum FromWorker {
        ViewSnapshot(ViewSnapshot),
        ViewUpdate(ViewUpdate),
        CommandResult { run_id: String, epoch: String, command_id: String, outcome: Outcome, update: Option<ViewUpdate> },
        PreviewResult { run_id: String, epoch: String, req_id: u32, rev: u32, preview: Preview },
        MoveOptionsResult { run_id: String, epoch: String, req_id: u32, rev: u32, asset_id: AssetId, options: MoveOptions },
        ReportText { run_id: String, epoch: String, report_id: String, text: String },
        Exported { run_id: String, epoch: String, file: String },
        Pong { n: u32, epoch: String, phase: Option<Phase> },
        /// Прогресс промотки, без ревизии.
        Advancing { run_id: String, epoch: String, advance_id: String, day: Day, waiting_ops: u32 },
        /// Соединение открыто: партия и право записи. Без права записи — только просмотр.
        Opened { run_id: Option<String>, epoch: String, writer: bool },
        Error { epoch: String, code: String, recoverable: bool },
    }

    /// Заголовок файла партии (JSON Lines: заголовок и дни).
    pub struct RunHeader {
        pub format: u8,
        pub scenario: String,
        pub pack_version: String,
        pub engine_version: String,
        pub runtime_manifest_id: String,
        pub seed: u32,
        pub mode: RunMode,
        pub parent_id: Option<String>,
        pub fork_day: Option<Day>,
    }

    /// Типы, которые адаптер Worker получает от ядра, — корень для генератора.
    pub struct CoreTypes { pub record: DayRecord, pub header: RunHeader, pub decide: DecideRequest, pub narrate: NarrateBrief, pub narration: Narration }
}
