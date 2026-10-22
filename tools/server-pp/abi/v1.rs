// server-pp custom calculator ABI, version 1: slot layout.
//
// This file is the single source of truth for the layout. The host
// (`src/custom.rs`) and the Rust guest helper (`examples/guest`) both
// `include!` it; `CALCULATORS.md` documents the same numbers for other
// languages. Every slot is a little-endian f64. Integers (mods bits, counts,
// ids) are exact. Flags are 0.0 or 1.0. Unknown values are NaN.
//
// Changing a number here is an ABI break: add slots in reserved positions
// only, and bump ABI_VERSION for anything else.

/// The value `vosu_pp_abi_version` must return and `input::ABI` carries.
pub const ABI_VERSION: i32 = 1;
/// f64 slots in the input block (512 bytes).
pub const INPUT_SLOTS: usize = 64;
/// f64 slots in the output block (128 bytes): pp followed by the breakdown.
pub const OUTPUT_SLOTS: usize = 16;
/// Breakdown values after pp in the output block.
pub const BREAKDOWN_SLOTS: usize = OUTPUT_SLOTS - 1;
/// Maximum length of the NUL-terminated `vosu_pp_info` JSON, NUL excluded.
pub const INFO_MAX_BYTES: usize = 4096;
/// Maximum length of the NUL-terminated `vosu_pp_error` text, NUL excluded.
pub const ERROR_MAX_BYTES: usize = 512;

/// Status codes returned by `vosu_pp_calculate`. Any other non-zero value is
/// a module-defined failure.
pub mod status {
    pub const OK: i32 = 0;
    pub const UNSUPPORTED_RULESET: i32 = 1;
    pub const UNSUPPORTED_MODS: i32 = 2;
    pub const INVALID_INPUT: i32 = 3;
}

/// Ruleset numbers carried in `input::RULESET`.
pub mod ruleset {
    pub const OSU: f64 = 0.0;
    pub const TAIKO: f64 = 1.0;
    pub const CATCH: f64 = 2.0;
    pub const MANIA: f64 = 3.0;
}

/// Input slot indices.
pub mod input {
    // Request.
    pub const ABI: usize = 0;
    pub const RULESET: usize = 1;
    /// Legacy mod bitmask (osu! API bits; NC includes DT, PF includes SD).
    pub const MODS: usize = 2;
    pub const CLOCK_RATE: usize = 3;
    pub const RELAX: usize = 4;
    pub const AUTOPILOT: usize = 5;
    pub const SCORE_V2: usize = 6;
    /// 0 = the score as played, 1 = full-map projection at the achieved
    /// accuracy with no misses and maximum combo.
    pub const PROJECTION: usize = 7;

    // Score state (stable judgement semantics, see CALCULATORS.md).
    /// Stable accuracy for the ruleset, 0..1.
    pub const ACCURACY: usize = 8;
    pub const COMBO: usize = 9;
    pub const N300: usize = 10;
    pub const N100: usize = 11;
    pub const N50: usize = 12;
    pub const N_GEKI: usize = 13;
    pub const N_KATU: usize = 14;
    pub const MISSES: usize = 15;
    pub const PASSED_OBJECTS: usize = 16;
    pub const TOTAL_OBJECTS: usize = 17;
    pub const SLIDER_END_HITS: usize = 18;
    pub const LARGE_TICK_HITS: usize = 19;
    pub const SMALL_TICK_HITS: usize = 20;

    // Map at these mods (and passed objects).
    pub const STARS: usize = 24;
    pub const MAX_COMBO: usize = 25;
    pub const IS_CONVERT: usize = 26;
    /// Approach rate, overall difficulty, circle size and HP drain after mods,
    /// AR/OD adjusted for the clock rate.
    pub const AR: usize = 27;
    pub const OD: usize = 28;
    pub const CS: usize = 29;
    pub const HP: usize = 30;

    // Server context.
    /// 1 when the score is the game's live play, 0 for files and queries.
    pub const LIVE: usize = 32;
    /// From the .osu [Metadata] section; NaN when absent.
    pub const BEATMAP_ID: usize = 33;
    pub const BEATMAPSET_ID: usize = 34;

    /// First ruleset-specific difficulty attribute slot.
    pub const ATTRIBUTES: usize = 40;
}

/// osu!standard difficulty attribute slots (rosu-pp 4.0.1 field names).
pub mod osu {
    pub const AIM: usize = 40;
    pub const AIM_DIFFICULT_SLIDER_COUNT: usize = 41;
    pub const SPEED: usize = 42;
    pub const FLASHLIGHT: usize = 43;
    pub const SLIDER_FACTOR: usize = 44;
    pub const AIM_TOP_WEIGHTED_SLIDER_FACTOR: usize = 45;
    pub const SPEED_TOP_WEIGHTED_SLIDER_FACTOR: usize = 46;
    pub const SPEED_NOTE_COUNT: usize = 47;
    pub const AIM_DIFFICULT_STRAIN_COUNT: usize = 48;
    pub const SPEED_DIFFICULT_STRAIN_COUNT: usize = 49;
    pub const NESTED_SCORE_PER_OBJECT: usize = 50;
    pub const LEGACY_SCORE_BASE_MULTIPLIER: usize = 51;
    pub const MAXIMUM_LEGACY_COMBO_SCORE: usize = 52;
    pub const AR: usize = 53;
    pub const GREAT_HIT_WINDOW: usize = 54;
    pub const OK_HIT_WINDOW: usize = 55;
    pub const MEH_HIT_WINDOW: usize = 56;
    pub const HP: usize = 57;
    pub const N_CIRCLES: usize = 58;
    pub const N_SLIDERS: usize = 59;
    pub const N_LARGE_TICKS: usize = 60;
    pub const N_SPINNERS: usize = 61;
}

/// osu!taiko difficulty attribute slots.
pub mod taiko {
    pub const STAMINA: usize = 40;
    pub const RHYTHM: usize = 41;
    pub const COLOR: usize = 42;
    pub const READING: usize = 43;
    pub const GREAT_HIT_WINDOW: usize = 44;
    pub const OK_HIT_WINDOW: usize = 45;
    pub const MONO_STAMINA_FACTOR: usize = 46;
    pub const MECHANICAL_DIFFICULTY: usize = 47;
    pub const CONSISTENCY_FACTOR: usize = 48;
}

/// osu!catch difficulty attribute slots.
pub mod catch {
    pub const PREEMPT: usize = 40;
    pub const N_FRUITS: usize = 41;
    pub const N_DROPLETS: usize = 42;
    pub const N_TINY_DROPLETS: usize = 43;
}

/// osu!mania difficulty attribute slots.
pub mod mania {
    pub const N_OBJECTS: usize = 40;
    pub const N_HOLD_NOTES: usize = 41;
}
