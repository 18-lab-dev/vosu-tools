//! LN statistics (ours): measured facts about a chart's long notes for every
//! key count. Not a rating and not from any upstream calculator. Thresholds
//! for the indicators are ours and documented in KEYMODES.md.
use rosu_map::{Beatmap, section::hit_objects::HitObjectKind};
use serde::{Deserialize, Serialize};

/// A release within this many chart milliseconds of a head in any column
/// counts as "on a press row".
const ROW_TOLERANCE_MS: f64 = 2.0;
/// Gap (playback ms) from a release to the next note in the same column below
/// which the release is an inverse-style hand-off.
const INVERSE_GAP_MS: f64 = 150.0;
/// Holds shorter than this (playback ms) behave like taps with a release.
const SHORT_HOLD_MS: f64 = 150.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Stats {
    /// Heads (taps and hold heads).
    pub notes: usize,
    pub holds: usize,
    /// Holds / heads.
    pub ln_share: f32,
    /// Hold time / (columns × chart length): how much of the field is held.
    pub coverage: f32,
    /// Releases per playback second over the chart.
    pub releases_per_second: f32,
    /// Most releases in any playback second.
    pub peak_releases_per_second: f32,
    /// Share of holds whose column is pressed again within 150 ms of the
    /// release (inverse / full-LN hand-offs). `None` without holds.
    pub inverse_share: Option<f32>,
    /// Share of releases that do not fall on a press row (releases timed
    /// independently of taps: release reading / LN tech). `None` without holds.
    pub offbeat_release_share: Option<f32>,
    /// Share of holds shorter than 150 ms (playback). `None` without holds.
    pub short_share: Option<f32>,
    /// Indicators from the values above: "full LN", "LN-heavy", "inverse",
    /// "release tech"; empty for rice charts.
    pub indicators: Vec<String>,
}

pub fn stats(map: &Beatmap, keys: u32, rate: f32) -> Stats {
    let rate = f64::from(rate);
    let mut heads: Vec<(u32, f64)> = Vec::with_capacity(map.hit_objects.len());
    let mut holds: Vec<(u32, f64, f64)> = Vec::new();
    for note in &map.hit_objects {
        let (x, end) = match &note.kind {
            HitObjectKind::Circle(c) => (c.pos.x, None),
            HitObjectKind::Hold(h) if h.duration > 0.0 => {
                (h.pos_x, Some(note.start_time + h.duration))
            }
            HitObjectKind::Hold(h) => (h.pos_x, None),
            _ => continue,
        };
        let column = ((x * keys as f32 / 512.0).floor().max(0.0) as u32).min(keys - 1);
        heads.push((column, note.start_time));
        if let Some(end) = end {
            holds.push((column, note.start_time, end));
        }
    }
    heads.sort_by(|a, b| a.1.total_cmp(&b.1));
    let first = heads.first().map_or(0.0, |h| h.1);
    let last = heads
        .iter()
        .map(|h| h.1)
        .chain(holds.iter().map(|h| h.2))
        .fold(first, f64::max);
    let length = (last - first).max(1.0);
    let held: f64 = holds.iter().map(|h| h.2 - h.1).sum();
    let mut releases: Vec<f64> = holds.iter().map(|h| h.2).collect();
    releases.sort_by(f64::total_cmp);
    let window = 1000.0 * rate;
    let (mut peak, mut lo) = (0usize, 0usize);
    for hi in 0..releases.len() {
        while releases[hi] - releases[lo] >= window {
            lo += 1;
        }
        peak = peak.max(hi - lo + 1);
    }
    let head_times: Vec<f64> = heads.iter().map(|h| h.1).collect();
    let on_row = |t: f64| {
        let i = head_times.partition_point(|&h| h < t - ROW_TOLERANCE_MS);
        head_times
            .get(i)
            .is_some_and(|&h| h <= t + ROW_TOLERANCE_MS)
    };
    let mut columns: Vec<Vec<f64>> = vec![Vec::new(); keys as usize];
    for &(column, time) in &heads {
        columns[column as usize].push(time);
    }
    // Heads are sorted, so each column's list is too.
    let next_in_column = |column: u32, after: f64| {
        let times = &columns[column as usize];
        times.get(times.partition_point(|&t| t < after)).copied()
    };
    let share = |count: usize| (!holds.is_empty()).then(|| count as f32 / holds.len() as f32);
    let inverse = share(
        holds
            .iter()
            .filter(|h| {
                next_in_column(h.0, h.2).is_some_and(|n| (n - h.2) / rate <= INVERSE_GAP_MS)
            })
            .count(),
    );
    let offbeat = share(holds.iter().filter(|h| !on_row(h.2)).count());
    let short = share(
        holds
            .iter()
            .filter(|h| (h.2 - h.1) / rate < SHORT_HOLD_MS)
            .count(),
    );
    let ln_share = if heads.is_empty() {
        0.0
    } else {
        holds.len() as f32 / heads.len() as f32
    };
    let coverage = (held / (length * f64::from(keys))) as f32;
    let mut indicators = Vec::new();
    if ln_share >= 0.9 {
        indicators.push("full LN".to_owned());
    } else if ln_share >= 0.3 {
        indicators.push("LN-heavy".to_owned());
    }
    if inverse.is_some_and(|v| v >= 0.5) && coverage >= 0.4 {
        indicators.push("inverse".to_owned());
    }
    if ln_share >= 0.3 && offbeat.is_some_and(|v| v >= 0.5) {
        indicators.push("release tech".to_owned());
    }
    Stats {
        notes: heads.len(),
        holds: holds.len(),
        ln_share,
        coverage,
        releases_per_second: (releases.len() as f64 / (length / 1000.0 / rate)) as f32,
        peak_releases_per_second: peak as f32,
        inverse_share: inverse,
        offbeat_release_share: offbeat,
        short_share: short,
        indicators,
    }
}

/// Hold releases (chart ms) for the "ln" timeline.
pub fn releases(map: &Beatmap) -> Vec<f64> {
    let mut out: Vec<f64> = map
        .hit_objects
        .iter()
        .filter_map(|n| match &n.kind {
            HitObjectKind::Hold(h) if h.duration > 0.0 => Some(n.start_time + h.duration),
            _ => None,
        })
        .collect();
    out.sort_by(f64::total_cmp);
    out
}
