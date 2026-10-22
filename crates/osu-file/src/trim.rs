//! Trims: keep one or more source-time ranges of a map and lay them end to end.
//!
//! Each range keeps the objects whose start lies inside it. Its *window* is the
//! source span from `lead_in_ms` before the first kept object to `lead_out_ms`
//! after the last kept tail; windows that touch or overlap merge. Windows are
//! placed back to back with `gap_ms` of silence between them, so a source time
//! `t` inside window `w` maps to `t - w.source_start + w.output_start` (before any
//! rate change). The same mapping cuts the audio, sample-exactly.
use crate::{
    audio::Audio,
    map::{Options, csv, number},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

pub const MAX_RANGES: usize = 32;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Range {
    pub start_ms: f64,
    pub end_ms: f64,
}

/// A kept source span and where it starts in the trimmed (pre-rate) timeline.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Window {
    pub source_start: f64,
    pub source_end: f64,
    pub output_start: f64,
}
impl Window {
    pub fn output_end(&self) -> f64 {
        self.output_start + self.source_end - self.source_start
    }
    fn contains(&self, t: f64) -> bool {
        (self.source_start..=self.source_end).contains(&t)
    }
    fn map(&self, t: f64) -> f64 {
        t - self.source_start + self.output_start
    }
}

/// Bounds that need no map: checked with the other options in `map::effective`.
pub fn validate(o: &Options) -> Result<()> {
    ensure!(
        o.trims.len() <= MAX_RANGES,
        "at most {MAX_RANGES} trim ranges"
    );
    for (name, v, max) in [
        ("lead-in", o.lead_in_ms, 30_000.0),
        ("lead-out", o.lead_out_ms, 30_000.0),
        ("gap", o.gap_ms, 30_000.0),
        ("fade", o.fade_ms, 10_000.0),
    ] {
        ensure!(
            v.is_finite() && (0.0..=max).contains(&v),
            "trim {name} must be 0–{max} ms"
        );
    }
    for r in &o.trims {
        ensure!(
            r.start_ms.is_finite() && r.end_ms.is_finite() && r.start_ms >= 0.0,
            "trim ranges must be finite, non-negative times"
        );
        ensure!(r.end_ms > r.start_ms, "trim range ends before it starts");
    }
    Ok(())
}

/// Windows for `text` (empty when `o.trims` is empty). Window edges are whole
/// milliseconds so that .osu timestamps stay integral.
pub fn windows(text: &str, o: &Options) -> Result<Vec<Window>> {
    validate(o)?;
    if o.trims.is_empty() {
        return Ok(Vec::new());
    }
    let spans = crate::mods::spans(text)?;
    let mut ranges = o.trims.clone();
    ranges.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let mut spans_by_range = Vec::new();
    for r in &ranges {
        let kept: Vec<_> = spans
            .iter()
            .filter(|s| (r.start_ms..=r.end_ms).contains(&s.0))
            .collect();
        ensure!(
            !kept.is_empty(),
            "trim {}–{} contains no objects",
            clock(r.start_ms),
            clock(r.end_ms)
        );
        let first = kept.iter().map(|s| s.0).fold(f64::INFINITY, f64::min);
        let last = kept.iter().map(|s| s.1).fold(f64::NEG_INFINITY, f64::max);
        spans_by_range.push((
            (first - o.lead_in_ms).max(0.0).floor(),
            (last + o.lead_out_ms).ceil(),
        ));
    }
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (a, b) in spans_by_range {
        match merged.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    let mut out = Vec::with_capacity(merged.len());
    let mut cursor = 0.0;
    for (a, b) in merged {
        out.push(Window {
            source_start: a,
            source_end: b,
            output_start: cursor,
        });
        cursor += b - a + o.gap_ms.round();
    }
    Ok(out)
}

fn clock(ms: f64) -> String {
    let s = (ms / 1000.0).max(0.0);
    format!("{}:{:04.1}", (s / 60.0).floor(), s % 60.0)
}

/// Compact label for difficulty names, e.g. `0:31-1:05+1:40-2:10`.
pub fn label(o: &Options) -> String {
    let mut ranges = o.trims.clone();
    ranges.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let whole = |ms: f64| {
        let s = (ms / 1000.0).round() as i64;
        format!("{}:{:02}", s / 60, s % 60)
    };
    ranges
        .iter()
        .map(|r| format!("{}-{}", whole(r.start_ms), whole(r.end_ms)))
        .collect::<Vec<_>>()
        .join("+")
}

#[derive(Clone, Debug)]
struct Point {
    time: f64,
    beat: f64,
    fields: Vec<String>,
}

/// Trims `text`. Returns the trimmed map, its windows and warnings about dropped
/// content. With no trims the input is returned unchanged.
pub fn apply(text: &str, o: &Options) -> Result<(String, Vec<Window>, Vec<String>)> {
    let windows = windows(text, o)?;
    if windows.is_empty() {
        return Ok((text.to_owned(), windows, Vec::new()));
    }
    let mut ranges = o.trims.clone();
    ranges.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let keep = |t: f64| ranges.iter().any(|r| (r.start_ms..=r.end_ms).contains(&t));
    let window_of = |t: f64| windows.iter().find(|w| w.contains(t));
    let mut warnings = Vec::new();
    let mut dropped_storyboard = false;

    let points = timing_points(text)?;
    // PreviewTime outside every window falls back to the first kept object.
    let first_object = crate::mods::spans(text)?
        .iter()
        .map(|s| s.0)
        .filter(|t| keep(*t))
        .fold(f64::INFINITY, f64::min);
    let first_kept = windows[0].map(first_object);
    let mut section = String::new();
    let mut out = Vec::new();
    let mut hit_objects_window: Option<usize> = None;
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.starts_with('[') {
            section = line.to_owned();
            out.push(raw.to_owned());
            if section == "[TimingPoints]" {
                emit_timing(&mut out, &points, &windows)?;
            }
            if section == "[Events]" {
                // Section gaps become breaks when long enough for the client.
                for pair in windows.windows(2) {
                    let (start, end) = (pair[0].output_end(), pair[1].output_start);
                    if end - start >= 650.0 {
                        out.push(format!("2,{},{}", number(start), number(end)));
                    }
                }
            }
            continue;
        }
        if line.is_empty() || line.starts_with("//") {
            // Timing comments would land between re-anchored points; blank
            // lines keep the section layout.
            if line.is_empty() || section != "[TimingPoints]" {
                out.push(raw.to_owned());
            }
            continue;
        }
        match section.as_str() {
            "[General]" => {
                if let Some((key, val)) = line.split_once(':')
                    && key.trim() == "PreviewTime"
                {
                    let t: f64 = val.trim().parse().context("invalid PreviewTime")?;
                    let mapped = window_of(t).map_or(first_kept, |w| w.map(t));
                    out.push(format!("PreviewTime:{}", number(mapped.round())));
                } else {
                    out.push(raw.to_owned());
                }
            }
            "[Editor]" => {
                if let Some((key, val)) = line.split_once(':')
                    && key.trim() == "Bookmarks"
                {
                    let kept = val
                        .split(',')
                        .filter_map(|s| s.trim().parse::<f64>().ok())
                        .filter_map(|t| window_of(t).map(|w| number(w.map(t).round())))
                        .collect::<Vec<_>>();
                    out.push(format!("Bookmarks:{}", kept.join(",")));
                } else {
                    out.push(raw.to_owned());
                }
            }
            "[Events]" => {
                let mut p = csv(line);
                match p[0].trim() {
                    "0" | "Background" if !raw.starts_with([' ', '_']) => out.push(raw.to_owned()),
                    "2" | "Break" => {
                        let (s, e): (f64, f64) = (
                            p.get(1).context("missing break start")?.trim().parse()?,
                            p.get(2).context("missing break end")?.trim().parse()?,
                        );
                        for w in &windows {
                            let (cs, ce) = (s.max(w.source_start), e.min(w.source_end));
                            if ce - cs >= 650.0 {
                                p[1] = number(w.map(cs));
                                p[2] = number(w.map(ce));
                                out.push(p.join(","));
                            }
                        }
                    }
                    _ => dropped_storyboard = true,
                }
            }
            "[TimingPoints]" => {}
            "[HitObjects]" => {
                let mut p = csv(line);
                ensure!(p.len() >= 5, "invalid hit object");
                let t: f64 = p[2].trim().parse().context("invalid hit object time")?;
                if !keep(t) {
                    continue;
                }
                let w = windows
                    .iter()
                    .position(|w| w.contains(t))
                    .context("kept object outside its window")?;
                let mut kind: u32 = p[3].trim().parse()?;
                if hit_objects_window != Some(w) {
                    kind |= 4;
                    hit_objects_window = Some(w);
                }
                p[3] = kind.to_string();
                p[2] = number(windows[w].map(t));
                if kind & 8 != 0 {
                    let end: f64 = p.get(5).context("missing spinner end")?.trim().parse()?;
                    p[5] = number(windows[w].map(end));
                }
                if kind & 128 != 0 {
                    let end = p.get(5).context("missing hold end")?.clone();
                    let (time, rest) = end.split_once(':').unwrap_or((&end, ""));
                    p[5] = format!("{}:{rest}", number(windows[w].map(time.parse()?)));
                }
                out.push(p.join(","));
            }
            _ => out.push(raw.to_owned()),
        }
    }
    if dropped_storyboard {
        warnings.push(
            "Trimmed maps keep the background only; storyboard, video and event samples were removed."
                .into(),
        );
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    Ok((out.join(newline) + newline, windows, warnings))
}

fn timing_points(text: &str) -> Result<Vec<Point>> {
    let mut active = false;
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            active = line == "[TimingPoints]";
            continue;
        }
        if active && !line.is_empty() && !line.starts_with("//") {
            let fields = csv(line);
            ensure!(fields.len() >= 2, "invalid timing point");
            out.push(Point {
                time: fields[0]
                    .trim()
                    .parse()
                    .context("invalid timing point time")?,
                beat: fields[1].trim().parse().context("invalid beat length")?,
                fields,
            });
        }
    }
    // Stable order: by time, uninherited before inherited at equal times.
    out.sort_by(|a, b| {
        a.time
            .total_cmp(&b.time)
            .then((b.beat > 0.0).cmp(&(a.beat > 0.0)))
    });
    ensure!(
        out.iter().any(|p| p.beat > 0.0),
        "map has no uninherited timing point"
    );
    Ok(out)
}

/// Field 6 is "uninherited" in v6+ maps; older lines omit it.
fn with_time(fields: &[String], time: f64, beat: f64, uninherited: bool) -> String {
    let mut f = fields.to_vec();
    f[0] = number(time);
    f[1] = number(beat);
    if f.len() > 6 {
        f[6] = if uninherited { "1" } else { "0" }.into();
    }
    f.join(",")
}

/// Re-anchors the timing state active at each window start, then shifts the
/// points inside the window. The anchor keeps the beat phase (a whole number
/// of beats from the source red line) whenever it fits after the previous
/// window; otherwise it sits at the window start.
fn emit_timing(out: &mut Vec<String>, points: &[Point], windows: &[Window]) -> Result<()> {
    let mut previous_end = f64::NEG_INFINITY;
    for w in windows {
        let before = points.partition_point(|p| p.time < w.source_start);
        let red = points[..before]
            .iter()
            .rev()
            .find(|p| p.beat > 0.0)
            .or_else(|| points.iter().find(|p| p.beat > 0.0))
            .context("map has no uninherited timing point")?;
        if red.time < w.source_start {
            // The latest point supplies volume, sample set and effects.
            let latest = &points[before - 1];
            let mut anchor = red.time + ((w.source_start - red.time) / red.beat).floor() * red.beat;
            while w.map(anchor) < previous_end && anchor + red.beat <= w.source_start {
                anchor += red.beat;
            }
            if w.map(anchor) < previous_end {
                anchor = w.source_start;
            }
            // Volume, sample set and effects come from the latest point; the
            // meter from the red line.
            let mut fields = latest.fields.clone();
            if let (Some(dst), Some(meter)) = (fields.get_mut(2), red.fields.get(2)) {
                dst.clone_from(meter);
            }
            out.push(with_time(&fields, w.map(anchor), red.beat, true));
            if latest.beat < 0.0 {
                out.push(with_time(
                    &latest.fields,
                    w.map(w.source_start),
                    latest.beat,
                    false,
                ));
            }
        }
        for p in &points[before..] {
            if p.time > w.source_end {
                break;
            }
            out.push(with_time(&p.fields, w.map(p.time), p.beat, p.beat > 0.0));
        }
        previous_end = w.output_end();
    }
    Ok(())
}

/// Cuts `audio` to `windows`: each window's samples are copied to its output
/// position (silence past the end of the source and in gaps), with optional
/// raised-cosine fades of `fade_ms` at both window edges.
pub fn cut(audio: &Audio, windows: &[Window], fade_ms: f64) -> Result<Audio> {
    ensure!(!windows.is_empty(), "no trim windows");
    let rate = f64::from(audio.sample_rate) / 1000.0;
    let at = |ms: f64| (ms * rate).round() as usize;
    let last = windows.last().context("no trim windows")?;
    let total = at(last.output_end());
    let fade = at(fade_ms);
    let mut channels = vec![vec![0.0_f32; total]; audio.channels.len()];
    for w in windows {
        let (src, dst) = (at(w.source_start), at(w.output_start));
        let len = at(w.source_end) - src;
        let len = len.min(total - dst);
        let edge = fade.min(len / 2);
        for (out, input) in channels.iter_mut().zip(&audio.channels) {
            for i in 0..len {
                let Some(&v) = input.get(src + i) else { break };
                let gain = if edge == 0 {
                    1.0
                } else {
                    let d = i.min(len - 1 - i);
                    if d >= edge {
                        1.0
                    } else {
                        let x = d as f32 / edge as f32;
                        (std::f32::consts::FRAC_PI_2 * x).sin().powi(2)
                    }
                };
                out[dst + i] = v * gain;
            }
        }
    }
    Ok(Audio {
        sample_rate: audio.sample_rate,
        channels,
    })
}
