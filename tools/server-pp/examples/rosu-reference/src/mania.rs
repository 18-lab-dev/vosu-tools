// Ported from rosu-pp 4.0.1 src/mania/performance/calculator.rs
// (MIT, Copyright (c) 2021 Max; see LICENSE-rosu-pp).
//
// Stable mania judgements: n_geki = 320, n300, n_katu = 200, n100, n50.

use vosu_pp_guest::{Input, Output, input};

use crate::Mods;

pub fn calculate(i: &Input, mods: &Mods) -> Output {
    let stars = i.get(input::STARS);
    let n320 = i.count(input::N_GEKI);
    let n300 = i.count(input::N300);
    let n200 = i.count(input::N_KATU);
    let n100 = i.count(input::N100);
    let n50 = i.count(input::N50);
    let misses = i.count(input::MISSES);
    let total_hits = n320 + n300 + n200 + n100 + n50 + misses;

    let mut multiplier = 1.0;

    if mods.nf() {
        multiplier *= 0.75;
    }

    if mods.ez() {
        multiplier *= 0.5;
    }

    let custom_accuracy = if total_hits == 0 {
        0.0
    } else {
        let numerator = n320 * 32 + n300 * 30 + n200 * 20 + n100 * 10 + n50 * 5;
        let denominator = total_hits * 32;

        f64::from(numerator) / f64::from(denominator)
    };

    // * Star rating to pp curve
    let difficulty_value = 8.0 * f64::powf(f64::max(stars - 0.15, 0.05), 2.2)
        // * From 80% accuracy, 1/20th of total pp is awarded per additional 1% accuracy
        * f64::max(0.0, 5.0 * custom_accuracy - 4.0)
        // * Length bonus, capped at 1500 notes
        * (1.0 + 0.1 * f64::min(1.0, f64::from(total_hits) / 1500.0));

    Output::new(difficulty_value * multiplier).with(0, difficulty_value)
}
