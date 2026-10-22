// Fidelity reference: the stable (`lazer(false)`) performance formulas of
// rosu-pp 4.0.1 (MIT, Copyright (c) 2021 Max; see LICENSE-rosu-pp), ported to
// the server-pp calculator ABI. The host computes rosu-pp 4.0.1 difficulty
// attributes and score state; this module only applies the formula, so its
// result must match native rosu-pp `Performance::calculate` for the same
// inputs. server-pp's test suite checks exactly that.

mod catch;
mod mania;
mod osu;
mod taiko;
mod util;

use vosu_pp_guest::{Error, Input, Output, Ruleset, mods};

/// Legacy mod queries used by the formulas. Lazer-only mods (Blinds,
/// Traceable, Classic) cannot be expressed as legacy bits, so their branches
/// in the original source never apply to stable scores and are omitted.
pub(crate) struct Mods(u32);

impl Mods {
    pub fn nf(&self) -> bool {
        self.0 & mods::NF != 0
    }
    pub fn ez(&self) -> bool {
        self.0 & mods::EZ != 0
    }
    pub fn hd(&self) -> bool {
        self.0 & mods::HD != 0
    }
    pub fn fl(&self) -> bool {
        self.0 & mods::FL != 0
    }
    pub fn so(&self) -> bool {
        self.0 & mods::SO != 0
    }
    pub fn rx(&self) -> bool {
        self.0 & mods::RX != 0
    }
    pub fn ap(&self) -> bool {
        self.0 & mods::AP != 0
    }
}

fn calculate(input: &Input) -> Result<Output, Error> {
    let mods = Mods(input.mods());
    match input.ruleset() {
        Some(Ruleset::Osu) => Ok(osu::calculate(input, &mods)),
        Some(Ruleset::Taiko) => Ok(taiko::calculate(input, &mods)),
        Some(Ruleset::Catch) => Ok(catch::calculate(input, &mods)),
        Some(Ruleset::Mania) => Ok(mania::calculate(input, &mods)),
        None => Err(Error::unsupported_ruleset("unknown ruleset")),
    }
}

vosu_pp_guest::export_calculator! {
    info: r#"{"name":"rosu-pp 4.0.1 reference","version":"4.0.1","author":"18-LAB (port of rosu-pp by Max, MIT)","description":"Stable performance formulas of rosu-pp 4.0.1, for verifying the calculator ABI.","rulesets":["osu","taiko","fruits","mania"],"breakdown":{"osu":["aim","speed","accuracy","flashlight","effective_miss_count"],"taiko":["difficulty","accuracy","estimated_unstable_rate"],"mania":["difficulty"]}}"#,
    calculate: calculate,
}
