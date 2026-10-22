// Ported from rosu-pp 4.0.1 src/util/difficulty.rs and src/util/float_ext.rs
// (MIT, Copyright (c) 2021 Max; see LICENSE-rosu-pp).

use std::f64::consts::PI;

/// `FloatExt::eq`: equality within machine epsilon.
pub fn almost_eq(a: f64, b: f64) -> bool {
    (a - b).abs() <= f64::EPSILON
}

/// `FloatExt::lerp`.
pub fn lerp(value1: f64, value2: f64, amount: f64) -> f64 {
    (value1 * (1.0 - amount)) + (value2 * amount)
}

pub fn logistic(x: f64, midpoint_offset: f64, multiplier: f64, max_value: Option<f64>) -> f64 {
    max_value.unwrap_or(1.0) / (1.0 + f64::exp(multiplier * (midpoint_offset - x)))
}

pub fn smoothstep(x: f64, start: f64, end: f64) -> f64 {
    let x = reverse_lerp(x, start, end);

    x * x * (3.0 - 2.0 * x)
}

pub fn reverse_lerp(x: f64, start: f64, end: f64) -> f64 {
    f64::clamp((x - start) / (end - start), 0.0, 1.0)
}

#[expect(clippy::unreadable_literal, reason = "staying in sync with rosu-pp")]
pub fn erf(x: f64) -> f64 {
    if almost_eq(x, 0.0) {
        return 0.0;
    }

    if x.is_infinite() {
        if x.is_sign_positive() {
            return 1.0;
        }

        if x.is_sign_negative() {
            return -1.0;
        }
    }

    if x.is_nan() {
        return f64::NAN;
    }

    // * Constants for approximation (Abramowitz and Stegun formula 7.1.26)
    let t = 1.0 / (1.0 + 0.3275911 * f64::abs(x));

    let tau = t
        * (0.254829592
            + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));

    let erf = 1.0 - tau * f64::exp(-x * x);

    if x >= 0.0 { erf } else { -erf }
}

pub fn erf_inv(mut x: f64) -> f64 {
    const A: f64 = 0.147;

    if x <= -1.0 {
        return f64::NEG_INFINITY;
    }

    if x >= 1.0 {
        return f64::INFINITY;
    }

    if almost_eq(x, 0.0) {
        return 0.0;
    }

    let sgn = f64::signum(x);
    x = f64::abs(x);

    let ln = f64::ln(1.0 - x * x);
    let t1 = 2.0 / (PI * A) + ln / 2.0;
    let t2 = ln / A;
    let base_approx = f64::sqrt(t1 * t1 - t2) - t1;

    // * Correction reduces max error from -0.005 to -0.00045.
    let c = if x >= 0.85 {
        f64::powf((x - 0.85) / 0.293, 8.0)
    } else {
        0.0
    };

    sgn * (f64::sqrt(base_approx) + c)
}
