//! Генератор `web/src/protocol.gen.ts`: TS-типы протокола из типов ядра.
//! `cargo run -p branchstate-core --features ts --bin gen-ts > web/src/protocol.gen.ts`

use branchstate_core::protocol::{CoreTypes, FromWorker, ToWorker};
use std::any::TypeId;
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::{Config, TypeVisitor, TS};

struct Collect<'a> {
    cfg: &'a Config,
    seen: BTreeSet<TypeId>,
    decls: BTreeMap<String, String>,
}

impl TypeVisitor for Collect<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if !self.seen.insert(TypeId::of::<T>()) {
            return;
        }
        T::visit_dependencies(self);
        T::visit_generics(self);
        // Объявления есть только у выведенных типов; примитивы и контейнеры его не имеют.
        let cfg = self.cfg;
        if let Ok(decl) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| T::decl(cfg))) {
            self.decls.insert(T::ident(cfg), decl);
        }
    }
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let cfg = Config::default();
    let mut c = Collect { cfg: &cfg, seen: BTreeSet::new(), decls: BTreeMap::new() };
    c.visit::<ToWorker>();
    c.visit::<FromWorker>();
    c.visit::<CoreTypes>();
    println!("// Сгенерировано из Rust: cargo run -p branchstate-core --features ts --bin gen-ts. Не править руками.\n");
    println!("export const PROTOCOL_VERSION = {};\nexport const ENGINE_VERSION = {:?};\n", branchstate_core::PROTOCOL_VERSION, branchstate_core::ENGINE_VERSION);
    for decl in c.decls.values() {
        println!("export {decl}\n");
    }
}
