//! Prism, mania-tracker's MSD-scale calculator for 6K–8K (MIT, copyright 2026
//! aleju03), vendored unmodified in `vendor/prism`. Labelled "Prism
//! (mania-tracker)": it is not Etterna's MinaCalc.
use serde::Serialize;

pub const REVISION: &str = "mania-hub@9ab23951357831a0dbbc48da20dd2140f22bd850";

/// Prism's skillset outputs in its own order and names. Stamina is omitted:
/// Prism has no stamina source and always reports 0 there.
pub const SKILLSETS: [&str; 9] = [
    "Stream",
    "Jumpstream",
    "JumpstreamOnly",
    "Handstream",
    "JackSpeed",
    "Chordjack",
    "ChordjackOnly",
    "Technical",
    "Speed",
];

#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq)]
pub struct Rating {
    /// `prism-v25`.
    pub version: String,
    /// Overall press rating on the MSD scale at Prism's base goal (96.5%).
    pub overall: f64,
    /// Skillsets in [`SKILLSETS`] order, scaled so the largest equals `overall`.
    pub skillsets: Vec<(String, f64)>,
    /// LN rating from Prism's LN model, `None` when the chart has no holds.
    pub ln: Option<f64>,
    /// Hand Prism assigned the 7K centre column to (0 left, 1 right).
    pub centre_hand: u8,
}

pub fn supports(keys: u32) -> bool {
    prism::PRISM_KEY_COUNTS.contains(&(keys as i32))
}

/// Rates `.osu` text with Prism's own parser at `rate`. `None` outside 6K–8K.
pub fn rate(text: &str, rate: f32) -> Option<Rating> {
    let map = chart_parser::parse_mania_beatmap(text);
    let notes = prism::chart_notes(&map);
    let options = prism::PrismOptions {
        rate: Some(f64::from(rate)),
        ..Default::default()
    };
    let press = prism::analyze_prism(&notes, map.key_count, map.od, &options)?;
    let ln = notes
        .iter()
        .any(|n| n.is_hold)
        .then(|| prism::analyze_prism_ln(&notes, map.key_count, map.od, &options))
        .flatten();
    Some(Rating {
        version: prism::prism_engine_version(),
        overall: press.overall(),
        skillsets: SKILLSETS
            .iter()
            .filter_map(|name| press.value(name).map(|v| (name.to_string(), v)))
            .collect(),
        ln,
        centre_hand: press.centre_hand,
    })
}

/// Prism's overall press rating restricted to each chart-time window
/// (`PrismPrepared::within`), for the "prism" timeline. `None` outside 6K–8K;
/// a window without work is 0.
pub fn local(text: &str, rate: f32, windows: &[(f64, f64)]) -> Option<Vec<f64>> {
    let map = chart_parser::parse_mania_beatmap(text);
    let notes = prism::chart_notes(&map);
    let prepared = prism::prepare_prism(
        &notes,
        map.key_count,
        Some(f64::from(rate)),
        None,
        map.od,
        false,
        false,
    )?;
    Some(
        windows
            .iter()
            .map(|&(start, end)| prepared.within(&[(start, end)]).rate(None).overall())
            .collect(),
    )
}
