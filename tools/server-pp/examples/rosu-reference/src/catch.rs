// Ported from rosu-pp 4.0.1 src/catch/performance/calculator.rs and
// src/catch/score_state.rs (MIT, Copyright (c) 2021 Max; see LICENSE-rosu-pp).
//
// Stable catch judgements: n300 = fruits, n100 = droplets, n50 = tiny
// droplets, n_katu = missed tiny droplets.

use vosu_pp_guest::{Input, Output, catch, input};

use crate::Mods;

pub fn calculate(i: &Input, mods: &Mods) -> Output {
    let stars = i.get(input::STARS);
    let preempt = i.get(catch::PREEMPT);
    let max_combo = i.count(catch::N_FRUITS) + i.count(catch::N_DROPLETS);
    let fruits = i.count(input::N300);
    let droplets = i.count(input::N100);
    let tiny_droplets = i.count(input::N50);
    let tiny_droplet_misses = i.count(input::N_KATU);
    let misses = i.count(input::MISSES);
    let state_max_combo = i.count(input::COMBO);

    // Relying heavily on aim
    let mut pp = (5.0 * (stars / 0.0049).max(1.0) - 4.0).powf(2.0) / 100_000.0;

    let mut combo_hits = fruits + droplets + misses;

    if combo_hits == 0 {
        combo_hits = max_combo;
    }

    // Longer maps are worth more
    let mut len_bonus = 0.95 + 0.3 * (f64::from(combo_hits) / 2500.0).min(1.0);

    if combo_hits > 2500 {
        len_bonus += (f64::from(combo_hits) / 2500.0).log10() * 0.475;
    }

    pp *= len_bonus;

    // Penalize misses exponentially
    pp *= 0.97_f64.powf(f64::from(misses));

    // Combo scaling
    if state_max_combo > 0 {
        pp *= (f64::from(state_max_combo).powf(0.35) / f64::from(max_combo).powf(0.35)).min(1.0);
    }

    // AR scaling
    let ar = if preempt > 1200.0 {
        -(preempt - 1800.0) / 120.0
    } else {
        -(preempt - 1200.0) / 150.0 + 5.0
    };

    let mut ar_factor = 1.0;
    if ar > 9.0 {
        ar_factor += 0.1 * (ar - 9.0) + f64::from(u8::from(ar > 10.0)) * 0.1 * (ar - 10.0);
    } else if ar < 8.0 {
        ar_factor += 0.025 * (8.0 - ar);
    }
    pp *= ar_factor;

    // HD bonus
    if mods.hd() {
        if ar <= 10.0 {
            pp *= 1.05 + 0.075 * (10.0 - ar);
        } else if ar > 10.0 {
            pp *= 1.01 + 0.04 * (11.0 - ar.min(11.0));
        }
    }

    // FL bonus
    if mods.fl() {
        pp *= 1.35 * len_bonus;
    }

    // Accuracy scaling
    let total_hits = fruits + droplets + tiny_droplets + tiny_droplet_misses + misses;
    let accuracy = if total_hits == 0 {
        0.0
    } else {
        f64::from(fruits + droplets + tiny_droplets) / f64::from(total_hits)
    };
    pp *= accuracy.powf(5.5);

    // NF penalty
    if mods.nf() {
        pp *= (1.0 - 0.02 * f64::from(misses)).max(0.9);
    }

    Output::new(pp)
}
