//! An example custom osu! formula, written for this example only (it is not
//! any real server's formula). It shows the parts a server formula usually
//! needs: difficulty attributes, the score state, RX/AP handling, a breakdown,
//! and clear errors for what it does not support.
//!
//! Build: `cargo build --release` in `tools/server-pp/examples`, then use
//! `target/wasm32-unknown-unknown/release/rust_example.wasm`.

use vosu_pp_guest::{Error, Input, Output, Ruleset, input, mods, osu};

/// The usual osu! skill curve: difficulty to raw pp.
fn skill_pp(difficulty: f64) -> f64 {
    (5.0 * (difficulty / 0.0675).max(1.0) - 4.0).powi(3) / 100_000.0
}

fn calculate(i: &Input) -> Result<Output, Error> {
    if i.ruleset() != Some(Ruleset::Osu) {
        return Err(Error::unsupported_ruleset("this example scores osu! only"));
    }
    if i.has_mods(mods::V2) {
        return Err(Error::unsupported_mods("this example has no ScoreV2 rules"));
    }
    let relax = i.flag(input::RELAX);
    let autopilot = i.flag(input::AUTOPILOT);

    let objects = f64::from(
        i.count(input::N300) + i.count(input::N100) + i.count(input::N50) + i.count(input::MISSES),
    );
    if objects == 0.0 {
        return Ok(Output::new(0.0).with(0, 0.0).with(1, 0.0).with(2, 0.0));
    }
    let accuracy = i.get(input::ACCURACY);
    let misses = f64::from(i.count(input::MISSES));
    let max_combo = f64::from(i.count(input::MAX_COMBO)).max(1.0);
    let combo_scale = (f64::from(i.count(input::COMBO)) / max_combo)
        .clamp(0.0, 1.0)
        .powf(0.8);
    let length = 0.95 + 0.4 * (objects / 2000.0).min(1.0);
    let miss_penalty = 0.97_f64.powf(misses);

    // Relax players do not tap, autopilot players do not aim.
    let aim = if autopilot {
        0.0
    } else {
        skill_pp(i.get(osu::AIM)) * length * miss_penalty * combo_scale * accuracy
    };
    let speed = if relax {
        0.0
    } else {
        skill_pp(i.get(osu::SPEED)) * length * miss_penalty * combo_scale * accuracy.powi(4)
    };
    // Timing accuracy only counts when the player hits the circles themselves.
    let circles = f64::from(i.count(osu::N_CIRCLES)).max(1.0);
    let accuracy_pp = if relax {
        0.0
    } else {
        1.52_f64.powf(i.get(input::OD))
            * accuracy.powi(24)
            * 2.8
            * (circles / 1000.0).powf(0.3).min(1.15)
    };

    let pp = (aim.powf(1.1) + speed.powf(1.1) + accuracy_pp.powf(1.1)).powf(1.0 / 1.1) * 1.1;
    Ok(Output::new(pp)
        .with(0, aim)
        .with(1, speed)
        .with(2, accuracy_pp))
}

vosu_pp_guest::export_calculator! {
    info: r#"{"name":"Rust example","version":"1.0.0","author":"18-LAB","description":"Example osu! formula: aim, speed and accuracy with RX/AP handling.","rulesets":["osu"],"breakdown":["aim","speed","accuracy"]}"#,
    calculate: calculate,
}
