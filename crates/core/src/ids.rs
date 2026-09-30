//! Идентификаторы и лексикон пакета.
//!
//! Внутри ядра id — индексы. В человекочитаемых форматах (JSON пакета, протокол, запросы
//! к посреднику) они сериализуются строковыми id пакета, в бинарных (снимок, хэш) — числами.
//! Строки разрешаются через лексикон текущего пакета: см. [`Lexicon::scope`].

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fmt;
use std::rc::Rc;

pub type Day = i32;
pub type OrderId = u32;
pub type EventId = u32;
pub type ProposalId = u32;
pub type AgreementId = u32;
pub type CommitmentId = u32;
pub type KnowledgeId = u32;

#[derive(Clone, Copy, Debug)]
pub enum Space {
    State,
    Node,
    Edge,
    Region,
    Asset,
    Persona,
    Template,
}
const SPACES: usize = 7;

#[derive(Default, Debug)]
pub struct Lexicon {
    names: [Vec<String>; SPACES],
    index: [BTreeMap<String, u16>; SPACES],
}

thread_local! {
    static CURRENT: RefCell<Option<Rc<Lexicon>>> = const { RefCell::new(None) };
}

impl Lexicon {
    pub fn add(&mut self, space: Space, name: &str) -> Result<u16, String> {
        let s = space as usize;
        if self.index[s].contains_key(name) {
            return Err(format!("дубликат id {name:?} ({space:?})"));
        }
        let idx = self.names[s].len() as u16;
        self.names[s].push(name.to_string());
        self.index[s].insert(name.to_string(), idx);
        Ok(idx)
    }

    pub fn name(&self, space: Space, idx: u16) -> &str {
        self.names[space as usize].get(idx as usize).map_or("?", String::as_str)
    }

    pub fn len(&self, space: Space) -> usize {
        self.names[space as usize].len()
    }

    /// Выполнить `f` с этим лексиконом как текущим для (де)сериализации id.
    pub fn scope<R>(self: &Rc<Self>, f: impl FnOnce() -> R) -> R {
        let prev = CURRENT.with(|c| c.replace(Some(self.clone())));
        let r = f();
        CURRENT.with(|c| *c.borrow_mut() = prev);
        r
    }
}

fn with_current<R>(f: impl FnOnce(Option<&Lexicon>) -> R) -> R {
    CURRENT.with(|c| f(c.borrow().as_deref()))
}

macro_rules! id {
    ($name:ident, $ty:ty, $space:expr) => {
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
        pub struct $name(pub $ty);

        impl $name {
            pub fn ix(self) -> usize {
                self.0 as usize
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                with_current(|l| match l {
                    Some(l) => f.write_str(l.name($space, self.0 as u16)),
                    None => write!(f, "{}#{}", stringify!($name), self.0),
                })
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                if s.is_human_readable() {
                    with_current(|l| match l {
                        Some(l) => s.serialize_str(l.name($space, self.0 as u16)),
                        None => Err(serde::ser::Error::custom("нет текущего лексикона")),
                    })
                } else {
                    self.0.serialize(s)
                }
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                if d.is_human_readable() {
                    struct V;
                    impl de::Visitor<'_> for V {
                        type Value = $name;
                        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                            f.write_str("строковый id")
                        }
                        fn visit_str<E: de::Error>(self, v: &str) -> Result<$name, E> {
                            with_current(|l| {
                                let l = l.ok_or_else(|| E::custom("нет текущего лексикона"))?;
                                l.index[$space as usize]
                                    .get(v)
                                    .map(|&i| $name(i as $ty))
                                    .ok_or_else(|| E::custom(format!("неизвестный id {v:?} ({:?})", $space)))
                            })
                        }
                    }
                    d.deserialize_str(V)
                } else {
                    <$ty>::deserialize(d).map($name)
                }
            }
        }

        #[cfg(feature = "ts")]
        impl ts_rs::TS for $name {
            type WithoutGenerics = Self;
            type OptionInnerType = Self;
            fn name(_: &ts_rs::Config) -> String {
                "string".into()
            }
            fn inline(_: &ts_rs::Config) -> String {
                "string".into()
            }
        }
    };
}

id!(StateId, u8, Space::State);
id!(NodeId, u16, Space::Node);
id!(EdgeId, u16, Space::Edge);
id!(RegionId, u16, Space::Region);
id!(AssetId, u16, Space::Asset);
id!(PersonaId, u8, Space::Persona);
id!(TemplateId, u16, Space::Template);
