#![forbid(unsafe_op_in_unsafe_fn)]

use md5::{Digest, Md5};
use rosu_map::{
    Beatmap,
    section::{general::GameMode, hit_objects::HitObjectKind},
};
use serde::{Deserialize, Serialize};

pub mod analysis;
pub mod interlude;
pub mod ln;
pub mod patterns;
pub mod playable;
pub mod prism;
pub mod quaver;
pub mod view7k;
#[cfg(windows)]
mod windows_clock;

pub const CALCULATOR: &str = "minacalc-527@2d706147-heads-v1";
pub const DAN_MODEL: &str = "reform-v1-course-msd527@1";
pub const MAX_BYTES: usize = 1024 * 1024;

pub use minacalc::Row;
/// MinaCalc's eight outputs under its own skillset names. `technical` is `None`
/// where MinaCalc 527 has no technical model for the key count.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Skills {
    pub overall: f32,
    pub stream: f32,
    pub jumpstream: f32,
    pub handstream: f32,
    pub stamina: f32,
    pub jackspeed: f32,
    pub chordjack: f32,
    pub technical: Option<f32>,
}
impl Skills {
    pub fn new(v: [f32; 8], keys: u32) -> Self {
        Self {
            overall: v[0],
            stream: v[1],
            jumpstream: v[2],
            handstream: v[3],
            stamina: v[4],
            jackspeed: v[5],
            chordjack: v[6],
            technical: minacalc::technical_modelled(keys).then_some(v[7]),
        }
    }
}

/// Largest osu!mania key count (dual-stage 18K).
pub const MAX_KEYS: u32 = 18;

/// Whether `system` rates `keys`-key charts; `Err` carries the calculator's own
/// limit. Systems: etterna, quaver, interlude, osu, reform, nps, prism,
/// patterns (Interlude patterns), view7k, dan7k, ln.
pub fn support(system: &str, keys: u32) -> Result<(), String> {
    let (ok, reason) = match system {
        "etterna" | "etterna-native" => (
            minacalc::KEYS.contains(&keys),
            "MinaCalc 527 has dedicated models for 4K–7K only",
        ),
        "quaver" => (
            (1..=10).contains(&keys),
            "Quaver.API assigns fingers for 1K–10K only",
        ),
        "interlude" => (
            (3..=10).contains(&keys),
            "Interlude's hand layout covers 3K–10K only",
        ),
        "reform" => (keys == 4, "Reform dan courses are 4K only"),
        "prism" => (
            prism::supports(keys),
            "Prism (mania-tracker) rates 6K–8K only",
        ),
        "patterns" => (
            patterns::supports(keys),
            "Interlude imports 3K–10K charts only",
        ),
        "view7k" => (keys == 7, "the 7K skill view is for 7K charts"),
        "dan7k" => (keys == 7, "Jinjin's Regular dan courses are 7K only"),
        "osu" | "nps" | "ln" => (true, ""),
        _ => return Err(format!("unknown system {system}")),
    };
    if ok {
        Ok(())
    } else {
        Err(format!("Not rated for {keys}K: {reason}."))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Dan {
    pub system: String,
    pub label: String,
    pub value: f32,
    pub experimental: bool,
    /// ± in dan steps (held-out calibration error), where measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncertainty: Option<f32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Calculator {
    pub msd: String,
    pub dan: String,
    pub quaver: String,
    pub interlude: String,
    pub osu: String,
    pub prism: String,
    pub patterns: String,
    pub dan7k: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Difficulty {
    pub checksum: String,
    pub title: String,
    pub artist: String,
    pub version: String,
    pub creator: String,
    pub rate: f32,
    pub mode: String,
    pub keys: u32,
    pub notes: usize,
    pub msd: Option<Skills>,
    pub interlude: Option<f32>,
    pub stars: Option<f64>,
    pub quaver: Option<f32>,
    pub score: Option<f32>,
    pub ssr: Option<Skills>,
    pub dan: Option<Dan>,
    /// Prism (mania-tracker) for 6K–8K; not Etterna.
    pub prism: Option<prism::Rating>,
    /// Interlude patterns for 3K–10K.
    pub patterns: Option<patterns::Report>,
    /// LN statistics (ours), every key count.
    pub ln: Option<ln::Stats>,
    /// 7K skill view, pattern analysis (ours).
    pub view7k: Option<view7k::View>,
    /// ≈ Jinjin 7K Regular dan (ours), with its held-out uncertainty.
    pub dan7k: Option<Dan>,
    pub calculator: Calculator,
    /// Whole-map refusal (not a native osu!mania map, invalid key count).
    pub unsupported: Option<String>,
    /// Per-system reasons for a missing value: etterna, quaver, interlude, reform.
    #[serde(default)]
    pub unrated: std::collections::BTreeMap<String, Unrated>,
}
/// Why a system has no value for this chart and rate.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Unrated {
    pub scope: Scope,
    pub reason: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// The calculator has no model for this key count (any rate).
    Keys,
    /// The calculator has no rating at this rate (its range or a skipped chart).
    Rate,
    /// A derived estimate outside its calibration or missing its input.
    Estimate,
}
impl Unrated {
    fn new(scope: Scope, reason: impl Into<String>) -> Self {
        Self {
            scope,
            reason: reason.into(),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub rate_tick: u8,
    pub score: Option<f32>,
}
impl Params {
    pub fn new(rate: f32, score: Option<f32>) -> Result<Self, String> {
        if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
            return Err("rate must be finite and between 0.5 and 2.0".into());
        }
        if score.is_some_and(|s| !s.is_finite() || !(0.0..=1.0).contains(&s)) {
            return Err("score must be finite and between 0 and 1".into());
        }
        Ok(Self {
            rate_tick: (rate * 20.0).round() as u8,
            score: score.map(|s| if s == 0.0 { 0.0 } else { s }),
        })
    }
    pub fn rate(self) -> f32 {
        f32::from(self.rate_tick) / 20.0
    }
    pub fn key(self, checksum: &str) -> String {
        format!(
            "{checksum}:{}:{:?}:{CALCULATOR}:{DAN_MODEL}:{}:{}:rosu-pp4.0.1:{}:{}:{DAN7K_MODEL}:ratings5",
            self.rate_tick,
            self.score.map(f32::to_bits),
            quaver::REVISION,
            interlude::REVISION,
            prism::REVISION,
            patterns::REVISION,
        )
    }
}
pub fn checksum(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(32);
    for b in Md5::digest(bytes) {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

/// Rows of note heads for a `keys`-column chart (1K–18K).
pub fn rows(map: &Beatmap, keys: u32) -> Result<Vec<Row>, String> {
    if !(1..=MAX_KEYS).contains(&keys) {
        return Err(format!("unsupported key count {keys}"));
    }
    let mut rows: Vec<Row> = Vec::with_capacity(map.hit_objects.len());
    for note in &map.hit_objects {
        let x = match &note.kind {
            HitObjectKind::Circle(c) => c.pos.x,
            HitObjectKind::Hold(h) => h.pos_x,
            _ => return Err("convert sliders and spinners with playable::playable first".into()),
        };
        let seconds = (note.start_time / 1000.0) as f32;
        if !x.is_finite()
            || !(0.0..=512.0).contains(&x)
            || !seconds.is_finite()
            || !(0.0..=24000.0).contains(&seconds)
        {
            return Err(
                "invalid note position or time (supported duration: 0–24000 seconds)".into(),
            );
        }
        let col = ((x * keys as f32 / 512.0).floor() as u32).min(keys - 1);
        rows.push(Row {
            notes: 1 << col,
            seconds,
        });
    }
    rows.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
    let mut merged: Vec<Row> = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(last) = merged.last_mut().filter(|last| last.seconds == row.seconds) {
            last.notes |= row.notes;
        } else {
            merged.push(row);
        }
    }
    Ok(merged)
}
pub fn native(rows: &[Row], keys: u32, rate: f32, score: Option<f32>) -> Result<Skills, String> {
    minacalc::calculate(rows, keys, rate, score)
        .map(|v| Skills::new(v, keys))
        .map_err(String::from)
}
pub fn calculate(bytes: &[u8], params: Params) -> Result<Difficulty, String> {
    if bytes.len() > MAX_BYTES {
        return Err("beatmap exceeds 1 MiB".into());
    }
    if !bytes.starts_with(b"osu file format v")
        && !bytes.starts_with(b"\xef\xbb\xbfosu file format v")
    {
        return Err("expected an osu beatmap".into());
    }
    // Every calculator rates the chart as played: sliders and spinners
    // converted as the game converts them. The checksum stays the file's.
    let original = bytes;
    let converted = playable::playable(original)?;
    let bytes: &[u8] = &converted;
    let mut map = Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?;
    let mode = match map.mode {
        GameMode::Osu => "osu",
        GameMode::Taiko => "taiko",
        GameMode::Catch => "fruits",
        GameMode::Mania => "mania",
    };
    // Converted osu! maps are not rated; their CircleSize is only echoed.
    let keys = if map.mode == GameMode::Mania {
        mania_keys::key_count(map.circle_size)?
    } else {
        map.circle_size.round() as u32
    };
    let mut result = Difficulty {
        checksum: checksum(original),
        title: std::mem::take(&mut map.title),
        artist: std::mem::take(&mut map.artist),
        version: std::mem::take(&mut map.version),
        creator: std::mem::take(&mut map.creator),
        rate: params.rate(),
        mode: mode.into(),
        keys,
        notes: map.hit_objects.len(),
        msd: None,
        interlude: None,
        stars: None,
        quaver: None,
        score: params.score,
        ssr: None,
        dan: None,
        prism: None,
        patterns: None,
        ln: None,
        view7k: None,
        dan7k: None,
        calculator: Calculator {
            msd: CALCULATOR.into(),
            dan: DAN_MODEL.into(),
            quaver: quaver::REVISION.into(),
            interlude: interlude::REVISION.into(),
            osu: "rosu-pp@4.0.1".into(),
            prism: prism::REVISION.into(),
            patterns: patterns::REVISION.into(),
            dan7k: DAN7K_MODEL.into(),
        },
        unsupported: None,
        unrated: Default::default(),
    };
    if map.mode != GameMode::Mania {
        result.unsupported = Some("only native osu!mania beatmaps are supported".into());
        return Ok(result);
    }
    let rows = rows(&map, keys)?;
    let rate = params.rate();
    let mut unrated = std::collections::BTreeMap::new();
    let mut refuse = |system: &str, reason: String| {
        unrated.insert(system.to_owned(), Unrated::new(Scope::Keys, reason));
    };
    match support("interlude", keys) {
        Ok(()) => result.interlude = Some(interlude::calculate(&rows, keys as usize, rate).0),
        Err(reason) => refuse("interlude", reason),
    }
    match support("quaver", keys) {
        Ok(()) => result.quaver = Some(quaver::calculate(&map, keys as usize, rate).0),
        Err(reason) => refuse("quaver", reason),
    }
    let reform_keys = support("reform", keys);
    let etterna = support("etterna", keys);
    if let Err(reason) = &etterna {
        refuse("etterna", reason.clone());
    }
    if let Err(reason) = &reform_keys {
        refuse("reform", reason.clone());
    }
    let pp_map = rosu_pp::Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?;
    result.stars = Some(
        rosu_pp::Difficulty::new()
            .clock_rate(f64::from(rate))
            .calculate(&pp_map)
            .stars(),
    );
    if etterna.is_ok() {
        match native(&rows, keys, rate, None) {
            Ok(msd) => {
                result.ssr = params
                    .score
                    .and_then(|s| native(&rows, keys, rate, Some(s)).ok());
                result.msd = Some(msd);
            }
            Err(reason) => {
                unrated.insert("etterna".into(), Unrated::new(Scope::Rate, reason));
            }
        }
    }
    if reform_keys.is_ok() {
        let reform = match &result.msd {
            None => Err("Reform needs a MinaCalc rating.".to_owned()),
            Some(msd) => estimate_dan(msd.overall).ok_or_else(|| {
                format!(
                    "MSD {:.2} is outside the Reform calibration range.",
                    msd.overall
                )
            }),
        };
        match reform {
            Ok(dan) => result.dan = Some(dan),
            Err(reason) => {
                unrated.insert("reform".into(), Unrated::new(Scope::Estimate, reason));
            }
        }
    }
    let ln = ln::stats(&map, keys, rate);
    let text = String::from_utf8_lossy(bytes);
    match support("prism", keys) {
        Ok(()) => match prism::rate(&text, rate) {
            Some(rating) => result.prism = Some(rating),
            None => {
                unrated.insert(
                    "prism".into(),
                    Unrated::new(Scope::Rate, "Prism returned no rating for this chart."),
                );
            }
        },
        Err(reason) => {
            unrated.insert("prism".into(), Unrated::new(Scope::Keys, reason));
        }
    }
    let mut matches = None;
    match support("patterns", keys) {
        Ok(()) => match patterns::convert(&text) {
            Ok(chart) => {
                let length = chart.last() - chart.first();
                let (found, report) = patterns::analyse(&chart, rate);
                result.patterns = Some(report);
                matches = Some((found, length));
            }
            Err(reason) => {
                unrated.insert(
                    "patterns".into(),
                    Unrated::new(
                        Scope::Rate,
                        format!("Interlude refuses this chart: {reason}."),
                    ),
                );
            }
        },
        Err(reason) => {
            unrated.insert("patterns".into(), Unrated::new(Scope::Keys, reason));
        }
    }
    if keys == 7 {
        match &matches {
            Some((found, length)) => {
                result.view7k = Some(view7k::build(
                    found,
                    *length,
                    rate,
                    result.msd.as_ref(),
                    &ln,
                ));
            }
            None => {
                unrated.insert(
                    "view7k".into(),
                    Unrated::new(
                        Scope::Estimate,
                        "The 7K skill view needs Interlude patterns.",
                    ),
                );
            }
        }
        let dan = match &result.msd {
            None => Err("The 7K dan estimate needs a MinaCalc 7K rating.".to_owned()),
            Some(_) if ln.ln_share >= DAN7K_MAX_LN_SHARE => Err(format!(
                "{:.0}% of the notes are holds; Jinjin's Regular courses are rice, so LN-heavy charts are not estimated.",
                ln.ln_share * 100.0
            )),
            Some(msd) => estimate_dan_7k(msd.overall).ok_or_else(|| {
                format!(
                    "MSD {:.2} is outside the 7K Regular dan calibration range.",
                    msd.overall
                )
            }),
        };
        match dan {
            Ok(dan) => result.dan7k = Some(dan),
            Err(reason) => {
                unrated.insert("dan7k".into(), Unrated::new(Scope::Estimate, reason));
            }
        }
    } else {
        for (system, why) in [
            ("view7k", "the 7K skill view is for 7K charts"),
            ("dan7k", "Jinjin's Regular dan courses are 7K only"),
        ] {
            unrated.insert(
                system.into(),
                Unrated::new(Scope::Keys, format!("Not rated for {keys}K: {why}.")),
            );
        }
    }
    result.ln = Some(ln);
    result.unrated = unrated;
    Ok(result)
}

pub const DAN7K_MODEL: &str = "jinjin-7k-regular-msd527@1";
/// Charts with at least this hold share get no 7K Regular dan estimate.
pub const DAN7K_MAX_LN_SHARE: f32 = 0.3;
/// Held-out (leave-one-out) maximum error of the 7K course interpolation, in
/// dan steps; `calibration-7k-sources.json` records the measurement.
pub const DAN7K_UNCERTAINTY: f32 = 0.2;
/// Jinjin's 7K Regular course names, in calibration order.
pub const DAN7K_NAMES: [&str; 14] = [
    "0th", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "Gamma",
    "Azimuth", "Zenith",
];

/// Piecewise-linear interpolation of 7K overall MSD between the 14 Jinjin
/// Regular course charts (`calibration-7k.json`); `None` outside them.
pub fn estimate_dan_7k(overall: f32) -> Option<Dan> {
    static ANCHORS: std::sync::LazyLock<[f32; 14]> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../calibration-7k.json")).expect("embedded calibration")
    });
    let anchors = &*ANCHORS;
    if !overall.is_finite() || overall < anchors[0] || overall > anchors[13] {
        return None;
    }
    let index = anchors
        .windows(2)
        .position(|w| overall <= w[1])
        .unwrap_or(12);
    let value = index as f32 + (overall - anchors[index]) / (anchors[index + 1] - anchors[index]);
    let nearest = DAN7K_NAMES[(value.round() as usize).min(13)];
    Some(Dan {
        system: "dan7k".into(),
        label: format!("≈ {nearest} Dan"),
        value,
        experimental: true,
        uncertainty: Some(DAN7K_UNCERTAINTY),
    })
}

pub fn estimate_dan(overall: f32) -> Option<Dan> {
    static ANCHORS: std::sync::LazyLock<[f32; 10]> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../calibration.json")).expect("embedded calibration")
    });
    let anchors = &*ANCHORS;
    if !overall.is_finite() || overall < anchors[0] || overall > anchors[9] {
        return None;
    }
    let index = anchors
        .windows(2)
        .position(|w| overall <= w[1])
        .unwrap_or(8);
    let value =
        1.0 + index as f32 + (overall - anchors[index]) / (anchors[index + 1] - anchors[index]);
    Some(Dan {
        system: "reform".into(),
        label: format!("Reform {}", value.floor() as u32),
        value,
        experimental: true,
        uncertainty: None,
    })
}
