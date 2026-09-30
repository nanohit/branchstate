//! ГПСЧ: отдельный поток ChaCha8 на каждую цель. Поток выводится из сида партии, дня и цели,
//! поэтому у него нет сохраняемой позиции между днями.

use crate::ids::{Day, StateId};
use rand_chacha::ChaCha8Rng;
use rand_core::{RngCore, SeedableRng};

pub type Rng = ChaCha8Rng;

pub fn seed_for(run_seed: u64, day: Day, purpose: &str, actor: Option<StateId>) -> Rng {
    let mut h = blake3::Hasher::new();
    h.update(&run_seed.to_le_bytes());
    h.update(&day.to_le_bytes());
    h.update(purpose.as_bytes());
    h.update(&[0, actor.map_or(255, |a| a.0)]);
    ChaCha8Rng::from_seed(*h.finalize().as_bytes())
}

/// Равномерное целое в `0..n`.
pub fn roll(rng: &mut Rng, n: u32) -> u32 {
    rng.next_u32() % n.max(1)
}

/// Событие с вероятностью `permille` из 1000.
pub fn chance(rng: &mut Rng, permille: u16) -> bool {
    roll(rng, 1000) < permille as u32
}
