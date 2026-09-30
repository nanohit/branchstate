//! Граница ядра для Worker: синхронные вызовы с JSON на входе и выходе.
//! Ввод-вывод, сеть и хранилище — в адаптере Worker, вне ядра.

use branchstate_core::ids::AssetId;
use branchstate_core::model::{Channel, OrderKind};
use branchstate_core::pack::Pack;
use branchstate_core::reports::Narration;
use branchstate_core::run::{replay_onto, DayInputs, DayRecord, Run, StopReason};
use branchstate_core::orders::Reject;
use branchstate_core::view::{Phase, Session, ViewUpdate};
use serde::Serialize;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Core {
    session: Session,
}

type R<T> = Result<T, JsError>;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

impl Core {
    fn pack(&self) -> &Rc<Pack> {
        &self.session.run.pack
    }
    fn json<T: Serialize>(&self, v: &T) -> String {
        self.pack().to_json(v)
    }
}

#[wasm_bindgen]
impl Core {
    /// Новая партия по пакету сценария (слитый JSON графа и данных) и сиду.
    pub fn create(pack_json: &str, seed: u32, run_id: String) -> R<Core> {
        let pack = Pack::load(&[pack_json]).map_err(err)?;
        Ok(Core { session: Session::new(Run::new(pack, seed as u64), run_id, 1, Vec::new()) })
    }

    /// Восстановление из снимка; `rev` и причины остановки — метаинформация рядом со снимком.
    pub fn restore(pack_json: &str, snapshot: &[u8], run_id: String, rev: u32, stop_json: &str) -> R<Core> {
        let pack = Pack::load(&[pack_json]).map_err(err)?;
        let stop: Vec<StopReason> = pack.from_json(stop_json).map_err(err)?;
        let run = Run::restore(pack, snapshot).map_err(err)?;
        Ok(Core { session: Session::new(run, run_id, rev, stop) })
    }

    pub fn engine_version() -> String {
        branchstate_core::ENGINE_VERSION.into()
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.session.run.snapshot()
    }

    pub fn set_epoch(&mut self, epoch: String) {
        self.session.epoch = epoch;
    }

    pub fn rev(&self) -> u32 {
        self.session.rev
    }

    pub fn day(&self) -> i32 {
        self.session.run.day()
    }

    pub fn ended(&self) -> bool {
        self.session.run.ended()
    }

    pub fn hash(&self) -> String {
        self.session.run.hash()
    }

    pub fn pack_version(&self) -> String {
        self.pack().version.clone()
    }

    /// `ViewSnapshot` текущей ревизии.
    pub fn view(&self) -> String {
        self.json(&self.session.snapshot())
    }

    /// Принятый пакет приказов остановки — для `TurnOp.intents`.
    pub fn staged(&self) -> String {
        self.json(&self.session.run.staged_kinds())
    }

    /// Принять намерения. Ответ: `{"update": ViewUpdate | null}` или `{"reject": Reject}`.
    pub fn commit(&mut self, intents_json: &str) -> R<String> {
        let intents: Vec<OrderKind> = self.pack().from_json(intents_json).map_err(err)?;
        let result = self.session.commit(&intents);
        Ok(self.json(&Committed::from(result)))
    }

    /// Отменить приказ. Ответ — как у `commit`.
    pub fn cancel(&mut self, order_id: u32) -> String {
        let result = self.session.cancel(order_id);
        self.json(&Committed::from(result))
    }

    pub fn preview(&self, intents_json: &str) -> R<String> {
        let intents: Vec<OrderKind> = self.pack().from_json(intents_json).map_err(err)?;
        Ok(self.json(&self.session.preview(&intents)))
    }

    pub fn move_options(&self, asset_json: &str) -> R<String> {
        let asset: AssetId = self.pack().from_json(asset_json).map_err(err)?;
        Ok(self.json(&self.session.move_options(asset)))
    }

    /// Запросы `decide` акторов, которым сегодня нужен пересмотр.
    pub fn needs(&self) -> String {
        self.json(&self.session.run.needs())
    }

    /// Намерения игрока от резервной политики — режим автопилота для измерений.
    pub fn autopilot(&self) -> String {
        self.json(&self.session.run.autopilot())
    }

    /// Разрешить день. Ответ: `{"record": DayRecord, "update": ViewUpdate | null}`.
    pub fn step(&mut self, inputs_json: &str) -> R<String> {
        let inputs: DayInputs = self.pack().from_json(inputs_json).map_err(err)?;
        let (record, update) = self.session.step(&inputs);
        Ok(self.json(&(Step { record, update })))
    }

    /// Воспроизвести записанный день журнала; ошибка — хэш не совпал.
    pub fn replay(&mut self, record_json: &str) -> R<()> {
        let record: DayRecord = self.pack().from_json(record_json).map_err(err)?;
        replay_onto(&mut self.session.run, std::slice::from_ref(&record)).map_err(err)
    }

    /// Зафиксировать остановку. Ответ: `ViewUpdate | null`.
    pub fn stop(&mut self, reasons_json: &str) -> R<String> {
        let reasons: Vec<StopReason> = self.pack().from_json(reasons_json).map_err(err)?;
        let update = self.session.stop_here(reasons);
        Ok(self.json(&update))
    }

    pub fn set_phase(&mut self, phase_json: &str) -> R<String> {
        let phase: Phase = self.pack().from_json(phase_json).map_err(err)?;
        let update = self.session.set_phase(phase);
        Ok(self.json(&update))
    }

    /// После восстановления: приказы остановки, фаза и ревизия из записанного `TurnOp`.
    pub fn resume(&mut self, phase_json: &str, stop_json: &str, intents_json: &str, rev: u32) -> R<()> {
        let phase: Phase = self.pack().from_json(phase_json).map_err(err)?;
        let stop: Vec<StopReason> = self.pack().from_json(stop_json).map_err(err)?;
        let intents: Vec<OrderKind> = self.pack().from_json(intents_json).map_err(err)?;
        self.session.resume(phase, stop, &intents, rev);
        Ok(())
    }

    /// Вход операции `narrate` для донесения; `null`, если донесения нет или оно не стоит литературной версии:
    /// собственные действия игрока и мелкие события остаются шаблонными.
    pub fn narrate_brief(&self, report_id: &str) -> String {
        let min = self.pack().n("narrate_min_weight");
        let brief = self
            .session
            .run
            .current_reports()
            .into_iter()
            .find(|r| r.report_id == report_id && r.weight >= min && r.channel != Channel::Direct)
            .map(|r| r.narrate_brief());
        self.json(&brief)
    }

    /// Литературный текст принимается, только если его эхо совпало со входом. Ответ: текст или `null`.
    pub fn accept_narration(&self, report_id: &str, narration_json: &str) -> String {
        let text = self.pack().from_json::<Narration>(narration_json).ok().and_then(|n| {
            let report = self.session.run.current_reports().into_iter().find(|r| r.report_id == report_id)?;
            report.accept_narration(&n)
        });
        self.json(&text)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Committed {
    Update(Option<ViewUpdate>),
    Reject(Reject),
}

impl From<Result<Option<ViewUpdate>, Reject>> for Committed {
    fn from(r: Result<Option<ViewUpdate>, Reject>) -> Committed {
        match r {
            Ok(u) => Committed::Update(u),
            Err(e) => Committed::Reject(e),
        }
    }
}

#[derive(Serialize)]
struct Step {
    record: DayRecord,
    update: Option<ViewUpdate>,
}
