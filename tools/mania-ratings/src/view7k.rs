//! 7K skill view, "pattern analysis (ours)". The community 7K categories
//! (Jinjin's 7K dan courses, Ez2Lazer, mania-tracker; see KEYMODES.md) built
//! from Interlude's 7K pattern matches and MinaCalc 527's 7K skillsets. It
//! reports how much of the chart each category covers and the MinaCalc value
//! for it where MinaCalc has one; it is not a rating of its own.
use serde::{Deserialize, Serialize};

use crate::{
    Skills,
    ln::Stats,
    patterns::{CorePattern, Match},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Category {
    /// `jack`, `chordjack`, `stream`, `chordstream`, `bracket`, `tech`.
    pub id: String,
    pub label: String,
    /// Share of the chart's length covered by this category's matches, 0–1.
    pub coverage: f32,
    /// The steady BPM whose matches span the most chart time, at the playback
    /// rate, counting each row as a 1/16 note (Interlude's convention).
    pub main_bpm: Option<u32>,
    /// MinaCalc 527 7K skillset value for this category (one decimal), if it has one.
    pub msd: Option<f32>,
    /// Which MinaCalc skillset `msd` is, or why there is none.
    pub msd_source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LnCategory {
    /// `general`, `tech`, `inverse`, `release`.
    pub id: String,
    pub label: String,
    /// The LN statistic shown for this category.
    pub value: Option<f32>,
    /// `share` (0–1) or `per_second`.
    pub unit: String,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct View {
    pub method: String,
    pub categories: Vec<Category>,
    pub ln: Vec<LnCategory>,
}

fn category(m: &Match) -> Option<&'static str> {
    Some(match (m.pattern, m.specific) {
        (CorePattern::Jacks, Some("Chordjacks")) => "chordjack",
        (CorePattern::Jacks, _) => "jack",
        (CorePattern::Stream, _) => "stream",
        (CorePattern::Chordstream, Some("Double Stream")) => "stream",
        (CorePattern::Chordstream, Some("Brackets")) => "bracket",
        (CorePattern::Chordstream, _) => "chordstream",
    })
}

/// Covered length of half-open spans, clipped to `[0, length]`.
fn covered(mut spans: Vec<(f32, f32)>, length: f32) -> f32 {
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (mut total, mut end) = (0.0_f32, f32::NEG_INFINITY);
    for (s, e) in spans {
        let (s, e) = (s.clamp(0.0, length), e.clamp(0.0, length));
        if e <= end {
            continue;
        }
        total += e - s.max(end);
        end = e;
    }
    total
}

/// A MinaCalc skillset accessor and its display name.
type SkillSource = (fn(&Skills) -> f32, &'static str);

/// `matches` are Interlude's 7K matches; `length` is the chart's first-to-last
/// row span in chart ms; `msd` the MinaCalc 7K skillsets at the same rate.
pub fn build(matches: &[Match], length: f32, rate: f32, msd: Option<&Skills>, ln: &Stats) -> View {
    let length = length.max(1.0);
    let defs: [(&str, &str, Option<SkillSource>); 6] = [
        (
            "jack",
            "Jack",
            Some((|s| s.jackspeed, "MinaCalc Jack Speed")),
        ),
        (
            "chordjack",
            "Chordjack",
            Some((|s| s.chordjack, "MinaCalc Chordjack")),
        ),
        (
            "stream",
            "Speed / stream",
            Some((|s| s.stream, "MinaCalc Stream")),
        ),
        (
            "chordstream",
            "Chordstream",
            Some((|s| s.jumpstream, "MinaCalc Chordstream")),
        ),
        (
            "bracket",
            "Bracket",
            Some((|s| s.handstream, "MinaCalc Bracketing")),
        ),
        ("tech", "Tech", None),
    ];
    let categories = defs
        .iter()
        .map(|&(id, label, skill)| {
            let mine: Vec<&Match> = matches
                .iter()
                .filter(|m| {
                    if id == "tech" {
                        m.mixed
                    } else {
                        category(m) == Some(id)
                    }
                })
                .collect();
            // The steady BPM whose matches span the most chart time.
            let mut by_bpm: Vec<(u32, f32)> = Vec::new();
            for m in mine.iter().filter(|m| !m.mixed && m.ms_per_beat > 0.0) {
                let bpm = (60_000.0 / m.ms_per_beat * rate).round() as u32;
                match by_bpm.iter_mut().find(|(b, _)| *b == bpm) {
                    Some((_, span)) => *span += m.end - m.start,
                    None => by_bpm.push((bpm, m.end - m.start)),
                }
            }
            let main_bpm = by_bpm
                .iter()
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(bpm, _)| *bpm);
            let (msd, msd_source) = match (skill, msd) {
                (Some((get, name)), Some(s)) => {
                    (Some((get(s) * 10.0).round() / 10.0), name.to_owned())
                }
                (Some((_, name)), None) => {
                    (None, format!("{name}: no MinaCalc value at this rate"))
                }
                (None, _) => (None, "MinaCalc 527 has no 7K technical model".to_owned()),
            };
            Category {
                id: id.to_owned(),
                label: label.to_owned(),
                // Whole percent: the spans are pattern windows, not exact boundaries.
                coverage: (covered(mine.iter().map(|m| (m.start, m.end)).collect(), length)
                    / length
                    * 100.0)
                    .round()
                    / 100.0,
                main_bpm,
                msd,
                msd_source,
            }
        })
        .collect();
    let stat = |id: &str, label: &str, value: Option<f32>, unit: &str, source: &str| LnCategory {
        id: id.to_owned(),
        label: label.to_owned(),
        value,
        unit: unit.to_owned(),
        source: source.to_owned(),
    };
    View {
        method: "pattern analysis (ours): Interlude 7K patterns + MinaCalc 527 7K skillsets + LN statistics".into(),
        categories,
        ln: vec![
            stat("general", "LN general", Some(ln.ln_share), "share", "LN share of heads"),
            stat("tech", "LN tech", ln.offbeat_release_share, "share", "releases off press rows"),
            stat("inverse", "LN inverse", ln.inverse_share, "share", "holds re-pressed within 150 ms"),
            stat("release", "LN release", (ln.holds > 0).then_some(ln.peak_releases_per_second), "per_second", "peak releases per second"),
        ],
    }
}
