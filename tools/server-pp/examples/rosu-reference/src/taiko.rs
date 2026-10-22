// Ported from rosu-pp 4.0.1 src/taiko/performance/calculator.rs
// (MIT, Copyright (c) 2021 Max; see LICENSE-rosu-pp). Stable scores are
// always "classic".

use vosu_pp_guest::{Input, Output, input, taiko};

use crate::{
    Mods,
    util::{almost_eq, erf, erf_inv, logistic, reverse_lerp},
};

struct Calculator<'a> {
    stars: f64,
    rhythm: f64,
    great_hit_window: f64,
    mono_stamina_factor: f64,
    consistency_factor: f64,
    is_convert: bool,
    n300: u32,
    n100: u32,
    misses: u32,
    mods: &'a Mods,
}

pub fn calculate(i: &Input, mods: &Mods) -> Output {
    let calculator = Calculator {
        stars: i.get(input::STARS),
        rhythm: i.get(taiko::RHYTHM),
        great_hit_window: i.get(taiko::GREAT_HIT_WINDOW),
        mono_stamina_factor: i.get(taiko::MONO_STAMINA_FACTOR),
        consistency_factor: i.get(taiko::CONSISTENCY_FACTOR),
        is_convert: i.flag(input::IS_CONVERT),
        n300: i.count(input::N300),
        n100: i.count(input::N100),
        misses: i.count(input::MISSES),
        mods,
    };
    calculator.calculate()
}

impl Calculator<'_> {
    fn calculate(&self) -> Output {
        let estimated_unstable_rate = if self.n300 == 0 || self.great_hit_window <= 0.0 {
            None
        } else {
            Some(
                self.compute_deviation_upper_bound(f64::from(self.n300) / self.total_hits()) * 10.0,
            )
        };

        // * Total difficult hits measures the total difficulty of a map based on its consistency factor.
        let total_difficult_hits = self.total_hits() * self.consistency_factor;

        let difficulty_value =
            self.compute_difficulty_value(total_difficult_hits, estimated_unstable_rate) * 1.08;

        let accuracy_value =
            self.compute_accuracy_value(total_difficult_hits, estimated_unstable_rate) * 1.1;

        let pp = difficulty_value + accuracy_value;

        Output::new(pp)
            .with(0, difficulty_value)
            .with(1, accuracy_value)
            .with(2, estimated_unstable_rate.unwrap_or(f64::NAN))
    }

    fn compute_difficulty_value(
        &self,
        total_difficult_hits: f64,
        estimated_unstable_rate: Option<f64>,
    ) -> f64 {
        let Some(estimated_unstable_rate) = estimated_unstable_rate else {
            return 0.0;
        };

        if almost_eq(total_difficult_hits, 0.0) {
            return 0.0;
        }

        // * The estimated unstable rate for 100% accuracy, at which all rhythm difficulty has been played successfully.
        let rhythm_expected_unstable_rate = self.compute_deviation_upper_bound(1.0) * 10.0;

        // * The unstable rate at which it can be assumed all rhythm difficulty has been ignored.
        // * 0.8 represents 80% of total hits being greats, or 90% accuracy in-game
        let rhythm_maximum_unstable_rate = self.compute_deviation_upper_bound(0.8) * 10.0;

        // * The fraction of star rating made up by rhythm difficulty, normalised to represent rhythm's perceived contribution to star rating.
        let rhythm_factor = reverse_lerp(self.rhythm / self.stars, 0.15, 0.4);

        // * A penalty removing improperly played rhythm difficulty from star rating based on estimated unstable rate.
        let rhythm_penalty = 1.0
            - logistic(
                estimated_unstable_rate,
                (rhythm_expected_unstable_rate + rhythm_maximum_unstable_rate) / 2.0,
                10.0 / (rhythm_maximum_unstable_rate - rhythm_expected_unstable_rate),
                Some(0.25 * f64::powf(rhythm_factor, 3.0)),
            );

        let base_difficulty = 5.0 * f64::max(1.0, self.stars * rhythm_penalty / 0.11) - 4.0;

        let mut difficulty_value = f64::min(
            f64::powf(base_difficulty, 3.0) / 69052.51,
            f64::powf(base_difficulty, 2.25) / 1250.0,
        );

        difficulty_value *= 1.0 + 0.10 * f64::max(0.0, self.stars - 10.0);

        // * Applies a bonus to maps with more total difficulty.
        let length_bonus = 1.0 + 0.25 * total_difficult_hits / (total_difficult_hits + 4000.0);
        difficulty_value *= length_bonus;

        // * Scales miss penalty by the total difficult hits of a map, making misses more punishing on maps with less total difficulty.
        let miss_penalty = 0.97 + 0.03 * total_difficult_hits / (total_difficult_hits + 1500.0);
        difficulty_value *= f64::powf(miss_penalty, f64::from(self.misses));

        if self.mods.hd() {
            let mut hidden_bonus = if self.is_convert { 0.025 } else { 0.1 };

            // * Hidden+flashlight plays are excluded from reading-based penalties to hidden.
            // * A penalty is applied to classic easy+hidden scores, as notes disappear later making fast reading easier.
            if !self.mods.fl() && self.mods.ez() {
                hidden_bonus *= 0.5;
            }

            difficulty_value *= 1.0 + hidden_bonus;
        }

        if self.mods.fl() {
            difficulty_value *= f64::max(
                1.0,
                1.05 - f64::min(self.mono_stamina_factor / 50.0, 1.0) * length_bonus,
            );
        }

        // * Scale accuracy more harshly on nearly-completely mono (single coloured) speed maps.
        let mono_acc_scaling_exponent = f64::from(2) + self.mono_stamina_factor;
        let mono_acc_scaling_shift =
            f64::from(500) - f64::from(100) * (self.mono_stamina_factor * f64::from(3));

        difficulty_value
            * (erf(mono_acc_scaling_shift / (f64::sqrt(2.0) * estimated_unstable_rate)))
                .powf(mono_acc_scaling_exponent)
    }

    fn compute_accuracy_value(
        &self,
        total_difficult_hits: f64,
        estimated_unstable_rate: Option<f64>,
    ) -> f64 {
        let Some(estimated_unstable_rate) = estimated_unstable_rate else {
            return 0.0;
        };

        if self.great_hit_window <= 0.0 {
            return 0.0;
        }

        let mut accuracy_value = 470.0 * f64::powf(0.9885, estimated_unstable_rate);

        // * Scales up the bonus for lower unstable rate as star rating increases.
        accuracy_value *= 1.0
            + f64::powf(50.0 / estimated_unstable_rate, 2.0) * f64::powf(self.stars, 2.8) / 600.0;

        if self.mods.hd() && !self.is_convert {
            accuracy_value *= 1.075;
        }

        // * Applies a bonus to maps with more total difficulty, calculating this with a map's total hits and consistency factor.
        accuracy_value *= 1.0 + 0.3 * total_difficult_hits / (total_difficult_hits + 4000.0);

        // * Applies a bonus to maps with more total memory required with HDFL.
        let memory_length_bonus = f64::min(1.15, f64::powf(self.total_hits() / 1500.0, 0.3));

        if self.mods.fl() && self.mods.hd() && !self.is_convert {
            accuracy_value *= f64::max(1.0, 1.05 * memory_length_bonus);
        }

        accuracy_value
    }

    // * Computes an upper bound on the player's tap deviation based on the OD, number of circles and sliders,
    // * and the hit judgements, assuming the player's mean hit error is 0. The estimation is consistent in that
    // * two SS scores on the same map with the same settings will always return the same deviation.
    #[expect(clippy::unreadable_literal, reason = "staying in sync with rosu-pp")]
    fn compute_deviation_upper_bound(&self, accuracy: f64) -> f64 {
        // * 99% critical value for the normal distribution (one-tailed).
        const Z: f64 = 2.32634787404;

        let n = self.total_hits();

        // * Proportion of greats hit.
        let p = accuracy;

        // * We can be 99% confident that p is at least this value.
        let p_lower_bound = (n * p + Z * Z / 2.0) / (n + Z * Z)
            - Z / (n + Z * Z) * f64::sqrt(n * p * (1.0 - p) + Z * Z / 4.0);

        // * We can be 99% confident that the deviation is not higher than:
        self.great_hit_window / (f64::sqrt(2.0) * erf_inv(p_lower_bound))
    }

    fn total_hits(&self) -> f64 {
        f64::from(self.n300 + self.n100 + self.misses)
    }
}
