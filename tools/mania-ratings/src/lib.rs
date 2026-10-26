#![forbid(unsafe_op_in_unsafe_fn)]

use md5::{Digest, Md5};
use rosu_map::{
    Beatmap,
    section::{general::GameMode, hit_objects::HitObjectKind},
};
use serde::{Deserialize, Serialize};

pub mod analysis;
pub mod interlude;
pub mod quaver;

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
/// limit. Systems: etterna, quaver, interlude, osu, reform, nps.
pub fn support(system: &str, keys: u32) -> Result<(), String> {
    let (ok, reason) = match system {
        "etterna" | "etterna-native" => (
            minacalc::KEYS.contains(&keys),
            "MinaCalc 527 has dedicated models for 4K, 6K and 7K only",
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
        "osu" | "nps" => (true, ""),
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
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Calculator {
    pub msd: String,
    pub dan: String,
    pub quaver: String,
    pub interlude: String,
    pub osu: String,
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
            "{checksum}:{}:{:?}:{CALCULATOR}:{DAN_MODEL}:{}:{}:rosu-pp4.0.1:ratings3",
            self.rate_tick,
            self.score.map(f32::to_bits),
            quaver::REVISION,
            interlude::REVISION,
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
            _ => return Err("mania sliders and spinners are not supported".into()),
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
    let mut map = Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?;
    let mode = match map.mode {
        GameMode::Osu => "osu",
        GameMode::Taiko => "taiko",
        GameMode::Catch => "fruits",
        GameMode::Mania => "mania",
    };
    let keys = map.circle_size.round() as u32;
    let mut result = Difficulty {
        checksum: checksum(bytes),
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
        calculator: Calculator {
            msd: CALCULATOR.into(),
            dan: DAN_MODEL.into(),
            quaver: quaver::REVISION.into(),
            interlude: interlude::REVISION.into(),
            osu: "rosu-pp@4.0.1".into(),
        },
        unsupported: None,
        unrated: Default::default(),
    };
    if map.mode != GameMode::Mania {
        result.unsupported = Some("only native osu!mania beatmaps are supported".into());
        return Ok(result);
    }
    if !(1..=MAX_KEYS).contains(&keys) || keys as f32 != map.circle_size {
        result.unsupported = Some(format!(
            "osu!mania key count must be a whole number from 1 to {MAX_KEYS} (CircleSize {})",
            map.circle_size
        ));
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
        Ok(()) => result.quaver = Some(quaver::calculate(&map, rate).0),
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
    result.unrated = unrated;
    Ok(result)
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
    })
}
