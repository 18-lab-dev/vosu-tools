// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Port (translated code) of osu! (lazer) 2026.1005.0-lazer
// (9a10d935b05a3b896f4bd811d620f2023331db93): ManiaBeatmapConverter for
// native mania maps, PassThroughPatternGenerator, SpinnerPatternGenerator and
// LegacyRandom. See tools/mania-ratings/PROVENANCE.md.

//! A native osu!mania chart as the game plays it, so every calculator rates
//! the chart that is played.
//!
//! - The key count is lazer's (`mania_keys::key_count`); `CircleSize` is
//!   rewritten to it.
//! - A slider is a hold over the slider's duration (spans × path distance ÷
//!   velocity), in the column of its x.
//! - A spinner goes to a column drawn from the beatmap-seeded `LegacyRandom`
//!   (column 0 on 8K for a finish spinner shorter than 1 s); it is a hold when
//!   it lasts at least 100 ms, otherwise a note.
//!
//! Only those lines are rewritten (objects as `.osu` hold or circle lines);
//! every other byte is kept, and a chart that needs none is returned unchanged.

use mania_keys::{DEFAULT_CIRCLE_SIZE, MAX_MANIA_KEYS, key_count};
use rosu_map::{
    Beatmap,
    section::{
        general::GameMode,
        hit_objects::{CurveBuffers, HitObjectKind},
    },
};
use std::borrow::Cow;

/// `osu.Game/Utils/LegacyRandom.cs`: osu!stable's xorshift generator.
struct LegacyRandom {
    x: u32,
    y: u32,
    z: u32,
    w: u32,
}

impl LegacyRandom {
    fn new(seed: i32) -> Self {
        Self {
            x: seed as u32,
            y: 842_502_087,
            z: 3_579_807_591,
            w: 273_326_509,
        }
    }
    fn next_uint(&mut self) -> u32 {
        let t = self.x ^ (self.x << 11);
        self.x = self.y;
        self.y = self.z;
        self.z = self.w;
        self.w = self.w ^ (self.w >> 19) ^ t ^ (t >> 8);
        self.w
    }
    fn next_double(&mut self) -> f64 {
        const INT_TO_REAL: f64 = 1.0 / (i32::MAX as f64 + 1.0);
        INT_TO_REAL * f64::from((self.next_uint() & 0x7FFF_FFFF) as i32)
    }
    fn next(&mut self, lower: i32, upper: i32) -> i32 {
        (f64::from(lower) + self.next_double() * f64::from(upper - lower)) as i32
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Slider,
    Spinner,
    Other,
}

/// `ConvertHitObjectParser` checks the circle, slider, spinner and hold bits in
/// that order.
fn kind(line: &str) -> Option<Kind> {
    let kind: i32 = line.split(',').nth(3)?.trim().parse().ok()?;
    Some(if kind & 1 != 0 {
        Kind::Other
    } else if kind & 2 != 0 {
        Kind::Slider
    } else if kind & 8 != 0 {
        Kind::Spinner
    } else {
        Kind::Other
    })
}

struct Line {
    index: usize,
    time: f64,
    kind: Kind,
}

/// The chart as played: slider and spinner lines of a native mania `.osu`
/// rewritten as lazer converts them. Other charts are returned unchanged.
pub fn playable(bytes: &[u8]) -> Result<Cow<'_, [u8]>, String> {
    let lines: Vec<&[u8]> = bytes.split_inclusive(|&b| b == b'\n').collect();
    let mut objects = Vec::new();
    let mut section = String::new();
    let mut mania = false;
    let mut difficulty = None;
    let mut hit_objects = None;
    let mut sizes: Vec<(usize, Option<f32>)> = Vec::new();
    for (index, raw) in lines.iter().enumerate() {
        let line = String::from_utf8_lossy(raw);
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = line.to_owned();
            if line == "[Difficulty]" {
                difficulty.get_or_insert(index);
            } else if line == "[HitObjects]" {
                hit_objects.get_or_insert(index);
            }
            continue;
        }
        let value = |key: &str| {
            line.split_once(':')
                .filter(|(k, _)| k.trim() == key)
                .map(|(_, v)| v.trim().to_owned())
        };
        if section == "[General]" {
            if let Some(mode) = value("Mode") {
                mania = mode == "3";
            }
        } else if section == "[Difficulty]" {
            if let Some(size) = value("CircleSize") {
                sizes.push((index, size.parse().ok()));
            }
        } else if section == "[HitObjects]" && !line.is_empty() && !line.starts_with("//") {
            let Some(kind) = kind(line) else { continue };
            let Some(time) = line.split(',').nth(2).and_then(|t| t.trim().parse().ok()) else {
                continue;
            };
            objects.push(Line { index, time, kind });
        }
    }
    let convert = objects.iter().any(|o| o.kind != Kind::Other);
    let size = sizes.last().map_or(Some(DEFAULT_CIRCLE_SIZE), |s| s.1);
    let resize = sizes.is_empty()
        || size.is_none_or(|size| {
            key_count(size).map_or(true, |keys| sizes.iter().any(|s| s.1 != Some(keys as f32)))
        });
    if !mania || (!convert && !resize) {
        return Ok(Cow::Borrowed(bytes));
    }
    let map = Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?;
    if map.mode != GameMode::Mania {
        return Ok(Cow::Borrowed(bytes));
    }
    let total = key_count(map.circle_size)?;
    let mut replaced: Vec<Option<String>> = vec![None; lines.len()];
    for &(index, _) in &sizes {
        replaced[index] = Some(format!("CircleSize:{total}"));
    }
    if convert {
        convert_objects(&lines, &mut objects, map, total, &mut replaced)?;
    }

    // A missing CircleSize line goes into [Difficulty], or a new [Difficulty]
    // section before [HitObjects].
    let (after, before) = match (sizes.is_empty(), difficulty) {
        (false, _) => (None, None),
        (true, Some(header)) => (Some(header), None),
        (true, None) => (None, hit_objects),
    };
    let mut out = Vec::with_capacity(bytes.len() + objects.len() * 8);
    for (index, (raw, replacement)) in lines.iter().zip(replaced).enumerate() {
        let ending: &[u8] = if raw.ends_with(b"\r\n") {
            b"\r\n"
        } else {
            b"\n"
        };
        if before == Some(index) {
            out.extend_from_slice(b"[Difficulty]");
            out.extend_from_slice(ending);
            out.extend_from_slice(format!("CircleSize:{total}").as_bytes());
            out.extend_from_slice(ending);
            out.extend_from_slice(ending);
        }
        match replacement {
            Some(line) => {
                out.extend_from_slice(line.as_bytes());
                let content = raw.trim_ascii_end().len();
                out.extend_from_slice(&raw[content..]);
            }
            None => out.extend_from_slice(raw),
        }
        if after == Some(index) {
            out.extend_from_slice(format!("CircleSize:{total}").as_bytes());
            out.extend_from_slice(ending);
        }
    }
    Ok(Cow::Owned(out))
}

/// Slider and spinner lines rewritten as the hold or note lazer plays.
fn convert_objects(
    lines: &[&[u8]],
    objects: &mut [Line],
    map: Beatmap,
    total: u32,
    replaced: &mut [Option<String>],
) -> Result<(), String> {
    if map.hit_objects.len() != objects.len() {
        return Err("cannot match the chart's slider and spinner lines to its objects".into());
    }
    // lazer orders objects by start time, keeping file order on ties; the
    // spinner columns are drawn in that order.
    objects.sort_by(|a, b| a.time.total_cmp(&b.time));
    let offset = if map.format_version < 5 { 24.0 } else { 0.0 };

    // ManiaBeatmapConverter: the LegacyRandom seed from the decoder's clamped
    // difficulty (floats, MathF.Round rounds half to even).
    let hp = map.hp_drain_rate.clamp(0.0, 10.0);
    let cs = map.circle_size.clamp(1.0, MAX_MANIA_KEYS as f32);
    let od = map.overall_difficulty.clamp(0.0, 10.0);
    let ar = map.approach_rate.clamp(0.0, 10.0);
    let columns = total as i32;
    let mut random = LegacyRandom::new(
        ((hp + cs).round_ties_even() as i32)
            .wrapping_mul(20)
            .wrapping_add((f64::from(od) * 41.2) as i32)
            .wrapping_add(ar.round_ties_even() as i32),
    );

    let mut bufs = CurveBuffers::default();
    for (line, mut object) in objects.iter().zip(map.hit_objects) {
        if (line.time + offset - object.start_time).abs() > 1e-6 {
            return Err("cannot match the chart's slider and spinner lines to its objects".into());
        }
        let text = String::from_utf8_lossy(lines[line.index]);
        let fields: Vec<&str> = text.trim().split(',').collect();
        let (time, hitsound) = (fields[2].trim(), fields.get(4).map_or("0", |s| s.trim()));
        match (&mut object.kind, line.kind) {
            (HitObjectKind::Slider(slider), Kind::Slider) => {
                // PassThroughPatternGenerator: a hold over the slider.
                let duration = slider.duration_with_bufs(&mut bufs);
                let duration = if duration.is_finite() {
                    duration.max(0.0)
                } else {
                    0.0
                };
                replaced[line.index] = Some(format!(
                    "{},{},{time},128,{hitsound},{}:0:0:0:0:",
                    fields[0].trim(),
                    fields[1].trim(),
                    line.time + duration
                ));
            }
            (HitObjectKind::Spinner(spinner), Kind::Spinner) => {
                // SpinnerPatternGenerator. No earlier pattern exists for a
                // native map, so the first drawn column is always free.
                let end = (object.start_time + spinner.duration) as i32;
                let length = f64::from(end) - object.start_time;
                let finish = hitsound.parse::<i32>().is_ok_and(|h| h & 4 != 0);
                let column = match columns {
                    8 if finish && length < 1000.0 => 0,
                    8 => random.next(1, columns),
                    _ => random.next(0, columns),
                };
                let x = ((f64::from(column) + 0.5) * 512.0 / f64::from(total)).floor();
                replaced[line.index] = Some(if length >= 100.0 {
                    format!(
                        "{x},192,{time},128,{hitsound},{}:0:0:0:0:",
                        line.time + length
                    )
                } else {
                    format!("{x},192,{time},1,{hitsound},0:0:0:0:")
                });
            }
            (_, Kind::Other) => {}
            _ => {
                return Err(
                    "cannot match the chart's slider and spinner lines to its objects".into(),
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charts_without_sliders_or_spinners_are_borrowed() {
        let text = b"osu file format v14\n\n[General]\nMode: 3\n\n[Difficulty]\nCircleSize:4\n\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n192,192,1500,128,0,2000:0:0:0:0:\n";
        assert!(matches!(playable(text).unwrap(), Cow::Borrowed(_)));
    }
}
