// Ported from rosu-pp 4.0.1 src/osu/performance/calculator.rs and
// src/osu/difficulty/skills/{strain,flashlight}.rs
// (MIT, Copyright (c) 2021 Max; see LICENSE-rosu-pp).
//
// Stable scores always use classic slider accuracy and carry no legacy total
// score, so the score-based miss estimation and the lazer-only tick/slider-end
// branches of the original reduce to the paths below.

use std::{cmp, f64::consts::PI};

use vosu_pp_guest::{Input, Output, input, osu};

use crate::{
    Mods,
    util::{erf, erf_inv, lerp, logistic, reverse_lerp, smoothstep},
};

// * This is being adjusted to keep the final pp value scaled around what it used to be when changing things.
const PERFORMANCE_BASE_MULTIPLIER: f64 = 1.14;

struct Attrs {
    aim: f64,
    aim_difficult_slider_count: f64,
    speed: f64,
    flashlight: f64,
    slider_factor: f64,
    aim_top_weighted_slider_factor: f64,
    speed_top_weighted_slider_factor: f64,
    speed_note_count: f64,
    aim_difficult_strain_count: f64,
    speed_difficult_strain_count: f64,
    ar: f64,
    great_hit_window: f64,
    ok_hit_window: f64,
    meh_hit_window: f64,
    n_circles: u32,
    n_sliders: u32,
    n_spinners: u32,
    max_combo: u32,
}

impl Attrs {
    fn od(&self) -> f64 {
        (79.5 - self.great_hit_window) / 6.0
    }
}

struct State {
    max_combo: u32,
    n300: u32,
    n100: u32,
    n50: u32,
    misses: u32,
}

impl State {
    const fn total_hits(&self) -> u32 {
        self.n300 + self.n100 + self.n50 + self.misses
    }

    fn accuracy(&self) -> f64 {
        let numerator = f64::from(6 * self.n300 + 2 * self.n100 + self.n50);
        let denominator = f64::from(6 * self.total_hits());

        if denominator > 0.0 {
            numerator / denominator
        } else {
            0.0
        }
    }
}

struct Calculator<'a> {
    attrs: Attrs,
    mods: &'a Mods,
    acc: f64,
    state: State,
}

pub fn calculate(i: &Input, mods: &Mods) -> Output {
    let state = State {
        max_combo: i.count(input::COMBO),
        n300: i.count(input::N300),
        n100: i.count(input::N100),
        n50: i.count(input::N50),
        misses: i.count(input::MISSES),
    };
    let attrs = Attrs {
        aim: i.get(osu::AIM),
        aim_difficult_slider_count: i.get(osu::AIM_DIFFICULT_SLIDER_COUNT),
        speed: i.get(osu::SPEED),
        flashlight: i.get(osu::FLASHLIGHT),
        slider_factor: i.get(osu::SLIDER_FACTOR),
        aim_top_weighted_slider_factor: i.get(osu::AIM_TOP_WEIGHTED_SLIDER_FACTOR),
        speed_top_weighted_slider_factor: i.get(osu::SPEED_TOP_WEIGHTED_SLIDER_FACTOR),
        speed_note_count: i.get(osu::SPEED_NOTE_COUNT),
        aim_difficult_strain_count: i.get(osu::AIM_DIFFICULT_STRAIN_COUNT),
        speed_difficult_strain_count: i.get(osu::SPEED_DIFFICULT_STRAIN_COUNT),
        ar: i.get(osu::AR),
        great_hit_window: i.get(osu::GREAT_HIT_WINDOW),
        ok_hit_window: i.get(osu::OK_HIT_WINDOW),
        meh_hit_window: i.get(osu::MEH_HIT_WINDOW),
        n_circles: i.count(osu::N_CIRCLES),
        n_sliders: i.count(osu::N_SLIDERS),
        n_spinners: i.count(osu::N_SPINNERS),
        max_combo: i.count(input::MAX_COMBO),
    };
    let calculator = Calculator {
        acc: state.accuracy(),
        attrs,
        mods,
        state,
    };
    calculator.calculate()
}

fn difficulty_to_performance(difficulty: f64) -> f64 {
    f64::powf(5.0 * f64::max(1.0, difficulty / 0.0675) - 4.0, 3.0) / 100_000.0
}

fn flashlight_difficulty_to_performance(difficulty: f64) -> f64 {
    25.0 * f64::powf(difficulty, 2.0)
}

impl Calculator<'_> {
    fn calculate(self) -> Output {
        let total_hits = self.state.total_hits();

        if total_hits == 0 {
            return Output::new(0.0)
                .with(0, 0.0)
                .with(1, 0.0)
                .with(2, 0.0)
                .with(3, 0.0)
                .with(4, 0.0);
        }

        let mut effective_miss_count = self.calculate_combo_based_estimated_miss_count();

        effective_miss_count = effective_miss_count.max(f64::from(self.state.misses));
        effective_miss_count = effective_miss_count.min(f64::from(self.state.total_hits()));

        let total_hits = f64::from(total_hits);

        let mut multiplier = PERFORMANCE_BASE_MULTIPLIER;

        if self.mods.nf() {
            multiplier *= (1.0 - 0.02 * effective_miss_count).max(0.9);
        }

        if self.mods.so() && total_hits > 0.0 {
            multiplier *= 1.0 - (f64::from(self.attrs.n_spinners) / total_hits).powf(0.85);
        }

        if self.mods.rx() {
            let od = self.attrs.od();

            // * https://www.desmos.com/calculator/vspzsop6td
            // * we use OD13.3 as maximum since it's the value at which great hitwidow becomes 0
            // * this is well beyond currently maximum achievable OD which is 12.17 (DTx2 + DA with OD11)
            let (n100_mult, n50_mult) = if od > 0.0 {
                (
                    0.75 * (1.0 - od / 13.33).max(0.0),
                    (1.0 - (od / 13.33).powf(5.0)).max(0.0),
                )
            } else {
                (1.0, 1.0)
            };

            // * As we're adding Oks and Mehs to an approximated number of combo breaks the result can be
            // * higher than total hits in specific scenarios (which breaks some calculations) so we need to clamp it.
            effective_miss_count = (effective_miss_count
                + f64::from(self.state.n100) * n100_mult
                + f64::from(self.state.n50) * n50_mult)
                .min(total_hits);
        }

        let speed_deviation = self.calculate_speed_deviation();

        let aim_value = self.compute_aim_value(effective_miss_count);
        let speed_value = self.compute_speed_value(speed_deviation, effective_miss_count);
        let acc_value = self.compute_accuracy_value();
        let flashlight_value = self.compute_flashlight_value(effective_miss_count);

        let pp = (aim_value.powf(1.1)
            + speed_value.powf(1.1)
            + acc_value.powf(1.1)
            + flashlight_value.powf(1.1))
        .powf(1.0 / 1.1)
            * multiplier;

        Output::new(pp)
            .with(0, aim_value)
            .with(1, speed_value)
            .with(2, acc_value)
            .with(3, flashlight_value)
            .with(4, effective_miss_count)
    }

    fn compute_aim_value(&self, effective_miss_count: f64) -> f64 {
        if self.mods.ap() {
            return 0.0;
        }

        let mut aim_difficulty = self.attrs.aim;

        if self.attrs.n_sliders > 0 && self.attrs.aim_difficult_slider_count > 0.0 {
            // * When the score is considered classic (regardless if it was made on old client or not)
            // * we consider all missing combo to be dropped difficult sliders
            let maximum_possible_dropped_sliders = self.total_imperfect_hits();

            let estimate_improperly_followed_difficult_sliders = f64::clamp(
                f64::min(
                    maximum_possible_dropped_sliders,
                    f64::from(self.attrs.max_combo - self.state.max_combo),
                ),
                0.0,
                self.attrs.aim_difficult_slider_count,
            );

            let slider_nerf_factor = (1.0 - self.attrs.slider_factor)
                * f64::powf(
                    1.0 - estimate_improperly_followed_difficult_sliders
                        / self.attrs.aim_difficult_slider_count,
                    3.0,
                )
                + self.attrs.slider_factor;
            aim_difficulty *= slider_nerf_factor;
        }

        let mut aim_value = difficulty_to_performance(aim_difficulty);

        let total_hits = self.total_hits();

        let len_bonus = 0.95
            + 0.4 * (total_hits / 2000.0).min(1.0)
            + f64::from(u8::from(total_hits > 2000.0)) * (total_hits / 2000.0).log10() * 0.5;

        aim_value *= len_bonus;

        if effective_miss_count > 0.0 {
            let aim_estimated_slider_breaks = self.calculate_estimated_slider_breaks(
                self.attrs.aim_top_weighted_slider_factor,
                effective_miss_count,
            );

            let relevant_miss_count = (effective_miss_count + aim_estimated_slider_breaks)
                .min(self.total_imperfect_hits());

            aim_value *= Self::calculate_miss_penalty(
                relevant_miss_count,
                self.attrs.aim_difficult_strain_count,
            );
        }

        aim_value *= self.acc;

        aim_value
    }

    fn compute_speed_value(&self, speed_deviation: Option<f64>, effective_miss_count: f64) -> f64 {
        let Some(speed_deviation) = speed_deviation.filter(|_| !self.mods.rx()) else {
            return 0.0;
        };

        let mut speed_value = difficulty_to_performance(self.attrs.speed);

        let total_hits = self.total_hits();

        let len_bonus = 0.95
            + 0.4 * (total_hits / 2000.0).min(1.0)
            + f64::from(u8::from(total_hits > 2000.0)) * (total_hits / 2000.0).log10() * 0.5;

        speed_value *= len_bonus;

        if effective_miss_count > 0.0 {
            let speed_estimated_slider_breaks = self.calculate_estimated_slider_breaks(
                self.attrs.speed_top_weighted_slider_factor,
                effective_miss_count,
            );

            let relevant_miss_count = (effective_miss_count + speed_estimated_slider_breaks)
                .min(self.total_imperfect_hits());

            speed_value *= Self::calculate_miss_penalty(
                relevant_miss_count,
                self.attrs.speed_difficult_strain_count,
            );
        }

        let speed_high_deviation_mult = self.calculate_speed_high_deviation_nerf(speed_deviation);
        speed_value *= speed_high_deviation_mult;

        // * Calculate accuracy assuming the worst case scenario
        let relevant_total_diff = f64::max(0.0, total_hits - self.attrs.speed_note_count);
        let state = &self.state;
        let relevant_n300 = (f64::from(state.n300) - relevant_total_diff).max(0.0);
        let relevant_n100 = (f64::from(state.n100)
            - (relevant_total_diff - f64::from(state.n300)).max(0.0))
        .max(0.0);
        let relevant_n50 = (f64::from(state.n50)
            - (relevant_total_diff - f64::from(state.n300 + state.n100)).max(0.0))
        .max(0.0);

        let relevant_acc = if crate::util::almost_eq(self.attrs.speed_note_count, 0.0) {
            0.0
        } else {
            (relevant_n300 * 6.0 + relevant_n100 * 2.0 + relevant_n50)
                / (self.attrs.speed_note_count * 6.0)
        };

        let od = self.attrs.od();

        // * Scale the speed value with accuracy and OD.
        speed_value *= f64::powf((self.acc + relevant_acc) / 2.0, (14.5 - od) / 2.0);

        speed_value
    }

    fn compute_accuracy_value(&self) -> f64 {
        if self.mods.rx() {
            return 0.0;
        }

        // * This percentage only considers HitCircles of any value - in this part
        // * of the calculation we focus on hitting the timing hit window.
        let amount_hit_objects_with_acc = self.attrs.n_circles;

        let state = &self.state;

        let mut better_acc_percentage = if amount_hit_objects_with_acc > 0 {
            f64::from(
                (state.n300 as i32
                    - (cmp::max(
                        state.total_hits() as i32 - amount_hit_objects_with_acc as i32,
                        0,
                    )))
                    * 6
                    + state.n100 as i32 * 2
                    + state.n50 as i32,
            ) / f64::from(amount_hit_objects_with_acc * 6)
        } else {
            0.0
        };

        // * It is possible to reach a negative accuracy with this formula. Cap it at zero - zero points.
        if better_acc_percentage < 0.0 {
            better_acc_percentage = 0.0;
        }

        // * Lots of arbitrary values from testing.
        // * Considering to use derivation from perfect accuracy in a probabilistic manner - assume normal distribution.
        let mut acc_value =
            1.52163_f64.powf(self.attrs.od()) * better_acc_percentage.powf(24.0) * 2.83;

        // * Bonus for many hitcircles - it's harder to keep good accuracy up for longer.
        acc_value *= (f64::from(amount_hit_objects_with_acc) / 1000.0)
            .powf(0.3)
            .min(1.15);

        if self.mods.hd() {
            // * Decrease bonus for AR > 10
            acc_value *= 1.0 + 0.08 * reverse_lerp(self.attrs.ar, 11.5, 10.0);
        }

        if self.mods.fl() {
            acc_value *= 1.02;
        }

        acc_value
    }

    fn compute_flashlight_value(&self, effective_miss_count: f64) -> f64 {
        if !self.mods.fl() {
            return 0.0;
        }

        let mut flashlight_value = flashlight_difficulty_to_performance(self.attrs.flashlight);

        let total_hits = self.total_hits();

        // * Penalize misses by assessing # of misses relative to the total # of objects. Default a 3% reduction for any # of misses.
        if effective_miss_count > 0.0 {
            flashlight_value *= 0.97
                * (1.0 - (effective_miss_count / total_hits).powf(0.775))
                    .powf(effective_miss_count.powf(0.875));
        }

        flashlight_value *= self.get_combo_scaling_factor();

        // * Scale the flashlight value with accuracy _slightly_.
        flashlight_value *= 0.5 + self.acc / 2.0;

        flashlight_value
    }

    fn calculate_combo_based_estimated_miss_count(&self) -> f64 {
        let Self { state, attrs, .. } = self;

        if attrs.n_sliders == 0 {
            return f64::from(state.misses);
        }

        let mut miss_count = f64::from(state.misses);

        // * Consider that full combo is maximum combo minus dropped slider tails since they don't contribute to combo but also don't break it
        // * In classic scores we can't know the amount of dropped sliders so we estimate to 10% of all sliders on the map
        let full_combo_threshold = f64::from(attrs.max_combo) - 0.1 * f64::from(attrs.n_sliders);

        if f64::from(state.max_combo) < full_combo_threshold {
            miss_count = full_combo_threshold / f64::from(state.max_combo).max(1.0);
        }

        // * In classic scores there can't be more misses than a sum of all non-perfect judgements
        miss_count = miss_count.min(self.total_imperfect_hits());

        // * Every slider has *at least* 2 combo attributed in classic mechanics.
        // * If they broke on a slider with a tick, then this still works since they would have lost at least 2 combo (the tick and the end)
        // * Using this as a max means a score that loses 1 combo on a map can't possibly have been a slider break.
        // * It must have been a slider end.
        let max_possible_slider_breaks = cmp::min(
            attrs.n_sliders,
            (attrs.max_combo.saturating_sub(state.max_combo)) / 2,
        );

        let slider_breaks = miss_count - f64::from(state.misses);

        if slider_breaks > f64::from(max_possible_slider_breaks) {
            miss_count = f64::from(state.misses + max_possible_slider_breaks);
        }

        miss_count
    }

    fn calculate_estimated_slider_breaks(
        &self,
        top_weighted_slider_factor: f64,
        effective_miss_count: f64,
    ) -> f64 {
        let Self { attrs, state, .. } = self;

        if state.n100 == 0 {
            return 0.0;
        }

        let missed_combo_percent = 1.0 - f64::from(state.max_combo) / f64::from(attrs.max_combo);
        let mut estimated_slider_breaks =
            (effective_miss_count * top_weighted_slider_factor).min(f64::from(state.n100));

        // * Scores with more Oks are more likely to have slider breaks.
        let ok_adjustment =
            ((f64::from(state.n100) - estimated_slider_breaks) + 0.5) / f64::from(state.n100);

        // * There is a low probability of extra slider breaks on effective miss counts close to 1, as score based calculations are good at indicating if only a single break occurred.
        estimated_slider_breaks *= smoothstep(effective_miss_count, 1.0, 2.0);

        estimated_slider_breaks * ok_adjustment * logistic(missed_combo_percent, 0.33, 15.0, None)
    }

    fn calculate_speed_deviation(&self) -> Option<f64> {
        if self.total_successful_hits() == 0 {
            return None;
        }

        let state = &self.state;

        // * Calculate accuracy assuming the worst case scenario
        let mut speed_note_count = self.attrs.speed_note_count;
        speed_note_count += (f64::from(state.total_hits()) - self.attrs.speed_note_count) * 0.1;

        // * Assume worst case: all mistakes were on speed notes
        let relevant_count_miss = f64::min(f64::from(state.misses), speed_note_count);
        let relevant_count_meh =
            f64::min(f64::from(state.n50), speed_note_count - relevant_count_miss);
        let relevant_count_ok = f64::min(
            f64::from(state.n100),
            speed_note_count - relevant_count_miss - relevant_count_meh,
        );
        let relevant_count_great = f64::max(
            0.0,
            speed_note_count - relevant_count_miss - relevant_count_meh - relevant_count_ok,
        );

        self.calculate_deviation(relevant_count_great, relevant_count_ok, relevant_count_meh)
    }

    #[expect(clippy::unreadable_literal, reason = "staying in sync with rosu-pp")]
    fn calculate_deviation(
        &self,
        relevant_count_great: f64,
        relevant_count_ok: f64,
        relevant_count_meh: f64,
    ) -> Option<f64> {
        // * 99% critical value for the normal distribution (one-tailed).
        const Z: f64 = 2.32634787404;

        if relevant_count_great + relevant_count_ok + relevant_count_meh <= 0.0 {
            return None;
        }

        // * The sample proportion of successful hits.
        let n = f64::max(1.0, relevant_count_great + relevant_count_ok);
        let p = relevant_count_great / n;

        // * We can be 99% confident that the population proportion is at least this value.
        let p_lower_bound = ((n * p + Z * Z / 2.0) / (n + Z * Z)
            - Z / (n + Z * Z) * f64::sqrt(n * p * (1.0 - p) + Z * Z / 4.0))
        .min(p);

        let great_hit_window = self.attrs.great_hit_window;
        let ok_hit_window = self.attrs.ok_hit_window;
        let meh_hit_window = self.attrs.meh_hit_window;

        let mut deviation;

        if p_lower_bound > 0.01 {
            deviation = great_hit_window / (f64::sqrt(2.0) * erf_inv(p_lower_bound));

            // * Subtract the deviation provided by tails that land outside the ok hit window from the deviation computed above.
            // * This is equivalent to calculating the deviation of a normal distribution truncated at +-okHitWindow.
            let ok_hit_window_tail_amount = f64::sqrt(2.0 / PI)
                * ok_hit_window
                * f64::exp(-0.5 * f64::powf(ok_hit_window / deviation, 2.0))
                / (deviation * erf(ok_hit_window / (f64::sqrt(2.0) * deviation)));

            deviation *= f64::sqrt(1.0 - ok_hit_window_tail_amount);
        } else {
            // * A tested limit value for the case of a score only containing oks.
            deviation = ok_hit_window / f64::sqrt(3.0);
        }

        // * Compute and add the variance for mehs, assuming that they are uniformly distributed.
        let meh_variance = (meh_hit_window * meh_hit_window
            + ok_hit_window * meh_hit_window
            + ok_hit_window * ok_hit_window)
            / 3.0;

        let deviation = f64::sqrt(
            ((relevant_count_great + relevant_count_ok) * f64::powf(deviation, 2.0)
                + relevant_count_meh * meh_variance)
                / (relevant_count_great + relevant_count_ok + relevant_count_meh),
        );

        Some(deviation)
    }

    fn calculate_speed_high_deviation_nerf(&self, speed_deviation: f64) -> f64 {
        const SCALE: f64 = 50.0;

        let speed_value = difficulty_to_performance(self.attrs.speed);

        // * Decides a point where the PP value achieved compared to the speed deviation is assumed to be tapped improperly. Any PP above this point is considered "excess" speed difficulty.
        // * This is used to cause PP above the cutoff to scale logarithmically towards the original speed value thus nerfing the value.
        let excess_speed_difficulty_cutoff = 100.0 + 220.0 * f64::powf(22.0 / speed_deviation, 6.5);

        if speed_value <= excess_speed_difficulty_cutoff {
            return 1.0;
        }

        let mut adjusted_speed_value = SCALE
            * (f64::ln((speed_value - excess_speed_difficulty_cutoff) / SCALE + 1.0)
                + excess_speed_difficulty_cutoff / SCALE);

        // * 220 UR and less are considered tapped correctly to ensure that normal scores will be punished as little as possible
        let amount = 1.0 - reverse_lerp(speed_deviation, 22.0, 27.0);
        adjusted_speed_value = lerp(adjusted_speed_value, speed_value, amount);

        adjusted_speed_value / speed_value
    }

    // * Miss penalty assumes that a player will miss on the hardest parts of a map,
    // * so we use the amount of relatively difficult sections to adjust miss penalty
    // * to make it more punishing on maps with lower amount of hard sections.
    fn calculate_miss_penalty(miss_count: f64, diff_strain_count: f64) -> f64 {
        0.96 / ((miss_count / (4.0 * diff_strain_count.ln().powf(0.94))) + 1.0)
    }

    fn get_combo_scaling_factor(&self) -> f64 {
        if self.attrs.max_combo == 0 {
            1.0
        } else {
            (f64::from(self.state.max_combo).powf(0.8) / f64::from(self.attrs.max_combo).powf(0.8))
                .min(1.0)
        }
    }

    const fn total_hits(&self) -> f64 {
        self.state.total_hits() as f64
    }

    const fn total_successful_hits(&self) -> u32 {
        self.state.n300 + self.state.n100 + self.state.n50
    }

    fn total_imperfect_hits(&self) -> f64 {
        f64::from(self.state.n100 + self.state.n50 + self.state.misses)
    }
}
