// MIT License — Copyright (c) 2024 percyqaz.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//! "Interlude patterns": port of YAVSRG Prelude `Calculator/Patterns`
//! (Density, Primitives, Patterns, FindPatterns, Clustering, Categorise,
//! Summary) and `OsuConverter.convert_hit_objects` at
//! 1fe55766ae1fece3d433c966bf25822647bc8af6. Arithmetic is f32 in upstream
//! order; differential tests run the unmodified F# (tests/reference/patterns).
//! Not ported: SV conversion (`Metrics.sv_time`), so categories never carry
//! "SV"/"+ SV".
use serde::{Deserialize, Serialize};

use crate::interlude;

pub const REVISION: &str = "YAVSRG@1fe55766ae1fece3d433c966bf25822647bc8af6";

const NOTHING: u8 = 0;
const NORMAL: u8 = 1;
const HOLDHEAD: u8 = 2;
const HOLDBODY: u8 = 3;
const HOLDTAIL: u8 = 4;

/// Interlude imports osu!mania 3K–10K only (`OsuConverter.convert`).
pub fn supports(keys: u32) -> bool {
    (3..=10).contains(&keys)
}

/// Prelude's native chart: rows of note types (NORMAL, HOLDHEAD, HOLDBODY,
/// HOLDTAIL) at f32 millisecond times, tail-only rows included.
#[derive(Clone, Debug)]
pub struct Chart {
    pub keys: usize,
    pub rows: Vec<(f32, Vec<u8>)>,
}

impl Chart {
    pub fn is_head(t: u8) -> bool {
        t == NORMAL || t == HOLDHEAD
    }
    pub fn first(&self) -> f32 {
        self.rows[0].0
    }
    pub fn last(&self) -> f32 {
        self.rows[self.rows.len() - 1].0
    }
    /// Head bitmask per row (tail-only rows are 0).
    pub fn head_masks(&self) -> Vec<(f32, u32)> {
        self.rows
            .iter()
            .map(|(t, row)| {
                let mask = row
                    .iter()
                    .enumerate()
                    .filter(|(_, n)| Self::is_head(**n))
                    .fold(0u32, |m, (k, _)| m | 1 << k);
                (*t, mask)
            })
            .collect()
    }
    /// Hold note intervals `(column, head ms, tail ms)` in row order.
    pub fn holds(&self) -> Vec<(usize, f32, f32)> {
        let mut open: Vec<Option<f32>> = vec![None; self.keys];
        let mut out = Vec::new();
        for (t, row) in &self.rows {
            for (k, n) in row.iter().enumerate() {
                match *n {
                    HOLDHEAD => open[k] = Some(*t),
                    HOLDTAIL => {
                        if let Some(start) = open[k].take() {
                            out.push((k, start, *t));
                        }
                    }
                    _ => {}
                }
            }
        }
        out
    }
}

enum Object {
    Circle { x: f64, time: f64 },
    Hold { x: f64, time: f64, end: f64 },
    Other { time: f64 },
}

impl Object {
    fn time(&self) -> f64 {
        match *self {
            Object::Circle { time, .. } | Object::Hold { time, .. } | Object::Other { time } => {
                time
            }
        }
    }
}

fn num(s: &str) -> Result<f64, String> {
    s.trim()
        .parse::<f64>()
        .map_err(|_| format!("invalid number {s:?} in [HitObjects]"))
}

/// `.osu` → Prelude chart, as `OsuConverter.convert_hit_objects`. Parsing:
/// `CircleSize`, `[HitObjects]` x and time, type bit 128 = hold (end time
/// before the first `:`), bit 1 = circle.
pub fn convert(text: &str) -> Result<Chart, String> {
    let mut keys = None;
    let mut inside = false;
    let mut objects = Vec::new();
    for line in text.lines() {
        if line.starts_with('[') {
            inside = line.trim() == "[HitObjects]";
        } else if inside && line.contains(',') {
            let p: Vec<&str> = line.split(',').collect();
            if p.len() < 4 {
                return Err("malformed hit object".into());
            }
            let kind = num(p[3])? as i64;
            let (x, time) = (num(p[0])?, num(p[2])?);
            objects.push(if kind & 128 != 0 {
                let end = p
                    .get(5)
                    .and_then(|e| e.split(':').next())
                    .ok_or("hold without end time")?;
                Object::Hold {
                    x,
                    time,
                    end: num(end)?,
                }
            } else if kind & 1 != 0 {
                Object::Circle { x, time }
            } else {
                Object::Other { time }
            });
        } else if let Some(cs) = line.strip_prefix("CircleSize:") {
            keys = Some(num(cs)? as i64);
        }
    }
    let keys = keys.ok_or("missing CircleSize")?;
    if !(3..=10).contains(&keys) {
        return Err(format!("Interlude imports 3K–10K only, not {keys}K"));
    }
    let keys = keys as usize;
    // The osu! client sorts hit objects by time; List.sortBy is stable.
    objects.sort_by(|a, b| a.time().total_cmp(&b.time()));
    let mut c = Converter {
        keys,
        holding: vec![None; keys],
        rows: Vec::new(),
    };
    let column = |x: f64| {
        ((x / 512.0 * keys as f64) as i64)
            .min(keys as i64 - 1)
            .max(0) as usize
    };
    for o in &objects {
        match *o {
            Object::Circle { x, time } => c.add_note(column(x), time as f32)?,
            Object::Hold { x, time, end } if end > time => {
                c.start_hold(column(x), time as f32, end as f32)?
            }
            Object::Hold { x, time, .. } => c.add_note(column(x), time as f32)?,
            Object::Other { .. } => {}
        }
    }
    c.finish_holds(f32::INFINITY);
    if c.rows.is_empty() {
        return Err("chart has no notes".into());
    }
    Ok(Chart { keys, rows: c.rows })
}

struct Converter {
    keys: usize,
    holding: Vec<Option<f32>>,
    rows: Vec<(f32, Vec<u8>)>,
}

impl Converter {
    fn earliest_release(&self) -> f32 {
        self.holding
            .iter()
            .flatten()
            .fold(f32::INFINITY, |a, &b| a.min(b))
    }
    fn last_time(&self) -> f32 {
        self.rows.last().map_or(f32::NEG_INFINITY, |r| r.0)
    }
    fn new_row(&mut self, time: f32) {
        let row = self
            .holding
            .iter()
            .map(|h| if h.is_some() { HOLDBODY } else { NOTHING })
            .collect();
        self.rows.push((time, row));
    }
    fn finish_holds(&mut self, time: f32) {
        let mut earliest = self.earliest_release();
        while earliest < time {
            for k in 0..self.keys {
                if self.holding[k] == Some(earliest) {
                    if earliest > self.last_time() {
                        self.new_row(earliest);
                    }
                    let row = &mut self.rows.last_mut().expect("row").1;
                    // NOTHING | HOLDBODY -> HOLDTAIL (upstream asserts nothing else occurs)
                    row[k] = HOLDTAIL;
                    self.holding[k] = None;
                }
            }
            earliest = self.earliest_release();
        }
    }
    fn add_note(&mut self, column: usize, time: f32) -> Result<(), String> {
        self.finish_holds(time);
        if time > self.last_time() {
            self.new_row(time);
        }
        let cell = &mut self.rows.last_mut().expect("row").1[column];
        match *cell {
            NOTHING => *cell = NORMAL,
            NORMAL | HOLDHEAD => {} // stacked note, kept once
            _ => return Err(format!("stacked note at {time} coincides with a hold")),
        }
        Ok(())
    }
    fn start_hold(&mut self, column: usize, time: f32, end: f32) -> Result<(), String> {
        self.finish_holds(time);
        if time > self.last_time() {
            self.new_row(time);
        }
        let cell = &mut self.rows.last_mut().expect("row").1[column];
        match *cell {
            NOTHING | NORMAL => {
                *cell = HOLDHEAD;
                self.holding[column] = Some(end);
            }
            _ => return Err(format!("stacked hold at {time} coincides with a hold")),
        }
        Ok(())
    }
}

/// `Density.process_chart`: per row, the highest per-column density.
pub fn density(chart: &Chart) -> Vec<f32> {
    const SENSITIVITY: f32 = 0.9;
    let mut densities = vec![0.0_f32; chart.keys];
    let mut since = vec![f32::NEG_INFINITY; chart.keys];
    chart
        .rows
        .iter()
        .map(|(t, row)| {
            for k in 0..chart.keys {
                if Chart::is_head(row[k]) {
                    let next = 1000.0 / (t - since[k]);
                    densities[k] = densities[k] * SENSITIVITY + next * (1.0 - SENSITIVITY);
                    since[k] = *t;
                }
            }
            densities.iter().copied().fold(f32::NEG_INFINITY, f32::max)
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    None,
    Left,
    Right,
    Outwards,
    Inwards,
}

struct RowInfo<'a> {
    time: f32,
    ms_per_beat: f32,
    notes: usize,
    jacks: usize,
    direction: Direction,
    roll: bool,
    density: f32,
    strains: &'a [f32],
    raw: Vec<usize>,
}

fn direction(previous: &[usize], current: &[usize]) -> (Direction, bool) {
    let (pl, pr) = (previous[0] as i64, previous[previous.len() - 1] as i64);
    let (cl, cr) = (current[0] as i64, current[current.len() - 1] as i64);
    let (lc, rc) = (cl - pl, cr - pr);
    let d = if lc > 0 {
        if rc > 0 {
            Direction::Right
        } else {
            Direction::Inwards
        }
    } else if lc < 0 {
        if rc < 0 {
            Direction::Left
        } else {
            Direction::Outwards
        }
    } else if rc < 0 {
        Direction::Inwards
    } else if rc > 0 {
        Direction::Outwards
    } else {
        Direction::None
    };
    (d, pl > cr || pr < cl)
}

fn heads(row: &[u8]) -> Vec<usize> {
    (0..row.len()).filter(|&k| Chart::is_head(row[k])).collect()
}

fn primitives<'a>(chart: &Chart, density: &[f32], strains: &'a [Vec<f32>]) -> Vec<RowInfo<'a>> {
    let first = chart.first();
    let mut previous = heads(&chart.rows[0].1);
    if previous.is_empty() {
        return Vec::new();
    }
    let mut previous_time = first;
    let mut out = Vec::new();
    for (index, (t, row)) in chart.rows.iter().enumerate().skip(1) {
        let current = heads(row);
        if current.is_empty() {
            continue;
        }
        let (dir, roll) = direction(&previous, &current);
        out.push(RowInfo {
            time: t - first,
            ms_per_beat: (t - previous_time) * 4.0,
            notes: current.len(),
            jacks: current.iter().filter(|k| previous.contains(k)).count(),
            direction: dir,
            roll,
            density: density[index],
            strains: &strains[index],
            raw: current.clone(),
        });
        previous = current;
        previous_time = *t;
    }
    out
}

type Recogniser = fn(&[RowInfo]) -> usize;
/// A core pattern, its recogniser and the key count's specific recognisers.
type Core = (
    CorePattern,
    Recogniser,
    &'static [(&'static str, Recogniser)],
);
/// Clusters group by (core pattern, mixed rhythm, BPM).
type GroupKey = (CorePattern, bool, i32);

fn stream(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, d, e, ..]
            if [a, b, c, d, e].iter().all(|x| x.notes == 1 && x.jacks == 0)
                && a.raw[0] != e.raw[0] =>
        {
            5
        }
        _ => 0,
    }
}
fn jacks(r: &[RowInfo]) -> usize {
    match r {
        [a, ..] if a.jacks > 1 && a.ms_per_beat < 2000.0 => 1,
        _ => 0,
    }
}
fn chordstream(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, d, ..]
            if [a, b, c, d].iter().all(|x| x.jacks == 0)
                && a.notes > 1
                && (b.notes > 1 || c.notes > 1 || d.notes > 1) =>
        {
            4
        }
        _ => 0,
    }
}
fn chordjacks(r: &[RowInfo]) -> usize {
    match r {
        [a, b, ..]
            if a.notes > 2
                && b.notes > 1
                && b.jacks >= 1
                && (b.notes < a.notes || b.jacks < b.notes) =>
        {
            2
        }
        _ => 0,
    }
}
fn minijacks(r: &[RowInfo]) -> usize {
    match r {
        [a, b, ..] if a.jacks > 0 && b.jacks == 0 => 2,
        _ => 0,
    }
}
fn longjacks(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, d, e, ..]
            if [a, b, c, d, e].iter().all(|x| x.jacks > 0)
                && a.raw.iter().any(|x| {
                    b.raw.contains(x) && c.raw.contains(x) && d.raw.contains(x) && e.raw.contains(x)
                }) =>
        {
            5
        }
        _ => 0,
    }
}
fn quadstream(r: &[RowInfo]) -> usize {
    match r {
        [a, _, c, d, ..] if a.notes == 4 && c.jacks == 0 && d.jacks == 0 => 4,
        _ => 0,
    }
}
fn gluts(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, ..] if b.jacks == 1 && c.jacks == 1 => {
            if a.raw.iter().any(|x| b.raw.contains(x) && c.raw.contains(x)) {
                0
            } else {
                3
            }
        }
        _ => 0,
    }
}
fn handstream(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, d, ..] if a.notes == 3 && [a, b, c, d].iter().all(|x| x.jacks == 0) => 4,
        _ => 0,
    }
}
fn jumpstream(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, d, ..]
            if a.notes == 2
                && b.notes == 1
                && [a, b, c, d].iter().all(|x| x.jacks == 0)
                && c.notes < 3
                && d.notes < 3 =>
        {
            4
        }
        _ => 0,
    }
}
fn jumptrill(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, d, ..] if a.notes == 2 && [b, c, d].iter().all(|x| x.notes == 2 && x.roll) => 4,
        _ => 0,
    }
}
fn splittrill(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, ..]
            if a.notes == 2
                && [b, c]
                    .iter()
                    .all(|x| x.notes == 2 && x.jacks == 0 && !x.roll) =>
        {
            3
        }
        _ => 0,
    }
}
fn roll(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, ..]
            if [a, b, c]
                .iter()
                .all(|x| x.notes == 1 && x.direction == Direction::Left)
                || [a, b, c]
                    .iter()
                    .all(|x| x.notes == 1 && x.direction == Direction::Right) =>
        {
            3
        }
        _ => 0,
    }
}
fn trill(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, d, ..]
            if [b, c, d].iter().all(|x| x.jacks == 0) && a.raw == c.raw && b.raw == d.raw =>
        {
            4
        }
        _ => 0,
    }
}
fn minitrill(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, d, ..] if b.jacks == 0 && c.jacks == 0 && a.raw == c.raw && b.raw != d.raw => 4,
        _ => 0,
    }
}
fn double_streams(r: &[RowInfo]) -> usize {
    match r {
        [a, b, ..] if a.notes == 2 && b.notes == 2 && b.jacks == 0 && !b.roll => 2,
        _ => 0,
    }
}
fn dense_chordstream(r: &[RowInfo]) -> usize {
    match r {
        [a, b, ..] if b.jacks == 0 && a.notes > 1 && b.notes > 1 => 2,
        _ => 0,
    }
}
fn light_chordstream(r: &[RowInfo]) -> usize {
    match r {
        [a, b, ..] if b.jacks == 0 && a.notes > 1 && b.notes == 1 => 2,
        _ => 0,
    }
}
fn chord_roll(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, ..]
            if a.notes > 1
                && b.notes > 1
                && c.notes > 1
                && ([b, c]
                    .iter()
                    .all(|x| x.direction == Direction::Left && x.roll)
                    || [b, c]
                        .iter()
                        .all(|x| x.direction == Direction::Right && x.roll)) =>
        {
            3
        }
        _ => 0,
    }
}
fn brackets(r: &[RowInfo]) -> usize {
    match r {
        [a, b, c, ..]
            if [b, c].iter().all(|x| !x.roll && x.jacks == 0)
                && a.notes > 2
                && b.notes > 2
                && c.notes > 2
                && a.notes + b.notes + c.notes > 9 =>
        {
            3
        }
        _ => 0,
    }
}

struct Specific {
    stream: &'static [(&'static str, Recogniser)],
    chordstream: &'static [(&'static str, Recogniser)],
    jack: &'static [(&'static str, Recogniser)],
}

const SPECIFIC_4K: Specific = Specific {
    stream: &[
        ("Rolls", roll),
        ("Trills", trill),
        ("Minitrills", minitrill),
    ],
    chordstream: &[
        ("Handstream", handstream),
        ("Split Trill", splittrill),
        ("Jumptrill", jumptrill),
        ("Jumpstream", jumpstream),
    ],
    jack: &[
        ("Longjacks", longjacks),
        ("Quadstream", quadstream),
        ("Gluts", gluts),
        ("Chordjacks", chordjacks),
        ("Minijacks", minijacks),
    ],
};
const SPECIFIC_7K: Specific = Specific {
    stream: &[],
    chordstream: &[
        ("Brackets", brackets),
        ("Double Stream", double_streams),
        ("Dense Chordstream", dense_chordstream),
        ("Light Chordstream", light_chordstream),
    ],
    jack: &[
        ("Longjacks", longjacks),
        ("Chordjacks", chordjacks),
        ("Minijacks", minijacks),
    ],
};
const SPECIFIC_OTHER: Specific = Specific {
    stream: &[],
    chordstream: &[
        ("Chord Rolls", chord_roll),
        ("Double Stream", double_streams),
        ("Dense Chordstream", dense_chordstream),
        ("Light Chordstream", light_chordstream),
    ],
    jack: &[
        ("Longjacks", longjacks),
        ("Chordjacks", chordjacks),
        ("Minijacks", minijacks),
    ],
};

/// Interlude's three core patterns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CorePattern {
    Stream,
    Chordstream,
    Jacks,
}

impl CorePattern {
    fn rating_multiplier(self) -> f32 {
        match self {
            CorePattern::Stream => 1.0 / 3.0,
            CorePattern::Chordstream => 0.5,
            CorePattern::Jacks => 1.0,
        }
    }
}

/// One matched pattern (`FoundPattern`), times in chart milliseconds from the
/// first note.
#[derive(Clone, Debug)]
pub struct Found<'a> {
    pub pattern: CorePattern,
    pub specific: Option<&'static str>,
    pub mixed: bool,
    pub start: f32,
    pub end: f32,
    pub ms_per_beat: f32,
    strains: &'a [f32],
    density: f32,
}

fn average(values: impl Iterator<Item = f32>) -> f32 {
    let (mut sum, mut n) = (0.0_f32, 0usize);
    for v in values {
        sum += v;
        n += 1;
    }
    sum / n as f32
}

fn find<'a>(chart: &Chart, rows: &[RowInfo<'a>]) -> Vec<Found<'a>> {
    let specific = match chart.keys {
        4 => &SPECIFIC_4K,
        7 => &SPECIFIC_7K,
        _ => &SPECIFIC_OTHER,
    };
    // Upstream compares row times (relative to the first note) with the
    // absolute `chart.LastNote` for the final pattern's end; kept as is.
    let last_note = chart.last();
    let mut out = Vec::new();
    for i in 0..rows.len() {
        let remaining = &rows[i..];
        let cores: [Core; 3] = [
            (CorePattern::Stream, stream, specific.stream),
            (CorePattern::Chordstream, chordstream, specific.chordstream),
            (CorePattern::Jacks, jacks, specific.jack),
        ];
        for (pattern, core, specifics) in cores {
            let n = core(remaining);
            if n == 0 {
                continue;
            }
            let (n, name) = match specifics.iter().find_map(|(name, p)| {
                let m = p(remaining);
                (m != 0).then_some((m, *name))
            }) {
                None => (n, None),
                Some((m, name)) => (n.max(m), Some(name)),
            };
            let d = &remaining[..n];
            let mean = average(d.iter().map(|r| r.ms_per_beat));
            let next = remaining.get(n).map_or(last_note, |r| r.time);
            let head = &remaining[0];
            out.push(Found {
                pattern,
                specific: name,
                mixed: !d.iter().all(|r| (r.ms_per_beat - mean).abs() < 5.0),
                start: head.time,
                end: if pattern == CorePattern::Jacks {
                    (head.time + head.ms_per_beat * 0.5).max(next)
                } else {
                    next
                },
                ms_per_beat: mean,
                strains: head.strains,
                density: average(d.iter().map(|r| r.density)),
            });
        }
    }
    out
}

/// A `Cluster`: patterns of one core type at one BPM (or mixed).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Cluster {
    pub pattern: CorePattern,
    /// Specific pattern names with their share of this cluster's matches.
    pub specific: Vec<(String, f32)>,
    /// Chart-time BPM (1.00×); multiply by the rate for display.
    pub bpm: i32,
    pub mixed: bool,
    /// Interlude strain rating of the cluster at the analysed rate (`null`
    /// when no strain is positive).
    pub rating: Option<f32>,
    /// 10th/25th/50th/75th/90th percentile density (notes/s at 1.00×).
    pub density: [f32; 5],
    /// Chart time covered, ms.
    pub amount: f32,
    pub importance: f32,
}

impl Cluster {
    /// Interlude's display name (`Cluster.Format` without the BPM).
    pub fn name(&self) -> &str {
        match self.specific.first() {
            Some((name, share)) if *share > 0.4 => name,
            _ => match self.pattern {
                CorePattern::Stream => "Stream",
                CorePattern::Chordstream => "Chordstream",
                CorePattern::Jacks => "Jacks",
            },
        }
    }
}

struct Builder {
    sum: f32,
    original: f32,
    count: usize,
}

impl Builder {
    fn bpm(&self) -> i32 {
        let average = self.sum / self.count as f32;
        (60_000.0_f32 / average).round_ties_even() as i32
    }
}

fn percentile(p: f32, sorted: &[f32]) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[(p * sorted.len() as f32).floor() as usize]
}

fn percentiles(sorted: &[f32]) -> [f32; 5] {
    [0.1, 0.25, 0.5, 0.75, 0.9].map(|p| percentile(p, sorted))
}

fn amount(starts_ends: &[(f32, f32)]) -> f32 {
    let mut total = 0.0_f32;
    let (mut start, mut end) = starts_ends[0];
    for &(s, e) in starts_ends {
        if end < e {
            total += end - start;
            start = s;
            end = e;
        } else {
            end = end.max(e);
        }
    }
    total + (end - start)
}

fn clusters(found: &[Found]) -> Vec<Cluster> {
    let mut plain: Vec<Builder> = Vec::new();
    let mut mixed: Vec<(CorePattern, Builder)> = Vec::new();
    // (is_mixed, index into plain or mixed)
    let mut assigned = Vec::with_capacity(found.len());
    for f in found {
        if f.mixed {
            match mixed.iter_mut().position(|(p, _)| *p == f.pattern) {
                Some(i) => {
                    mixed[i].1.sum += f.ms_per_beat;
                    mixed[i].1.count += 1;
                    assigned.push((true, i));
                }
                None => {
                    mixed.push((
                        f.pattern,
                        Builder {
                            sum: f.ms_per_beat,
                            original: f.ms_per_beat,
                            count: 1,
                        },
                    ));
                    assigned.push((true, mixed.len() - 1));
                }
            }
        } else {
            match plain
                .iter()
                .position(|c| (c.original - f.ms_per_beat).abs() < 5.0)
            {
                Some(i) => {
                    plain[i].sum += f.ms_per_beat;
                    plain[i].count += 1;
                    assigned.push((false, i));
                }
                None => {
                    plain.push(Builder {
                        sum: f.ms_per_beat,
                        original: f.ms_per_beat,
                        count: 1,
                    });
                    assigned.push((false, plain.len() - 1));
                }
            }
        }
    }
    let bpm_of = |(is_mixed, i): (bool, usize)| {
        if is_mixed {
            mixed[i].1.bpm()
        } else {
            plain[i].bpm()
        }
    };
    // Array.groupBy keeps first-occurrence key order.
    let mut groups: Vec<(GroupKey, Vec<&Found>)> = Vec::new();
    for (f, a) in found.iter().zip(&assigned) {
        let key = (f.pattern, f.mixed, bpm_of(*a));
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => v.push(f),
            None => groups.push((key, vec![f])),
        }
    }
    groups
        .into_iter()
        .map(|((pattern, mixed, bpm), data)| {
            let starts_ends: Vec<(f32, f32)> = data.iter().map(|f| (f.start, f.end)).collect();
            let mut densities: Vec<f32> = data.iter().map(|f| f.density).collect();
            densities.sort_by(f32::total_cmp);
            let count = data.len() as f32;
            let mut specific: Vec<(String, usize)> = Vec::new();
            for name in data.iter().filter_map(|f| f.specific) {
                match specific.iter_mut().find(|(n, _)| n == name) {
                    Some((_, c)) => *c += 1,
                    None => specific.push((name.to_string(), 1)),
                }
            }
            let mut specific: Vec<(String, f32)> = specific
                .into_iter()
                .map(|(n, c)| (n, c as f32 / count))
                .collect();
            specific.sort_by(|a, b| b.1.total_cmp(&a.1));
            let rating =
                interlude::weighted_overall(data.iter().flat_map(|f| f.strains.iter().copied()));
            let amount = amount(&starts_ends);
            Cluster {
                pattern,
                specific,
                bpm,
                mixed,
                rating: rating.is_finite().then_some(rating),
                density: percentiles(&densities),
                amount,
                importance: amount * pattern.rating_multiplier() * bpm as f32,
            }
        })
        .collect()
}

/// Interlude's `PatternReport` for one chart at one rate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Report {
    pub keys: u32,
    /// `Categorise.categorise_chart` (without SV).
    pub category: String,
    /// Up to three clusters per core pattern, by importance.
    pub clusters: Vec<Cluster>,
    /// Hold heads / all heads.
    pub ln_percent: f32,
    /// Percentiles of the per-row density, notes/s at 1.00×.
    pub density: [f32; 5],
    /// First to last row, ms.
    pub duration: f32,
}

fn categorise(clusters: &[Cluster]) -> String {
    let Some(first) = clusters.first() else {
        return "Uncategorised".into();
    };
    let important: Vec<&Cluster> = clusters
        .iter()
        .take_while(|c| c.importance / first.importance > 0.5)
        .collect();
    // Upstream throws when the top cluster has zero importance; report it as
    // uncategorised instead.
    let Some(&one) = important.first() else {
        return "Uncategorised".into();
    };
    let hybrid = matches!(
        (one.pattern, important.get(1).map(|c| c.pattern)),
        (
            CorePattern::Stream | CorePattern::Chordstream,
            Some(CorePattern::Jacks)
        ) | (
            CorePattern::Jacks,
            Some(CorePattern::Stream | CorePattern::Chordstream)
        )
    );
    let name = match one.specific.as_slice() {
        [(main, amount), ..] if *amount > 0.4 => main.clone(),
        [(a, a1), (b, a2), ..] if a == "Jumpstream" && b == "Handstream" && a2 / a1 > 0.4 => {
            "Jumpstream/Handstream".into()
        }
        _ => one.name().to_string(),
    };
    format!(
        "{name}{}{}",
        if hybrid { " Hybrid" } else { "" },
        if one.mixed { " Tech" } else { "" }
    )
}

/// Every matched pattern (`Patterns.find`), before clustering: core
/// pattern, specific name, mixed rhythm, and chart-ms span from the first note.
#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    pub pattern: CorePattern,
    pub specific: Option<&'static str>,
    pub mixed: bool,
    pub start: f32,
    pub end: f32,
    pub ms_per_beat: f32,
}

/// Interlude's matched patterns and its report for one chart at `rate`.
pub fn analyse(chart: &Chart, rate: f32) -> (Vec<Match>, Report) {
    let strains = interlude::finger_strains(&chart.head_masks(), chart.keys, rate);
    let density = density(chart);
    let rows = primitives(chart, &density, &strains);
    let found = find(chart, &rows);
    let matches = found
        .iter()
        .map(|f| Match {
            pattern: f.pattern,
            specific: f.specific,
            mixed: f.mixed,
            start: f.start,
            end: f.end,
            ms_per_beat: f.ms_per_beat,
        })
        .collect();
    (matches, report_from(chart, &found, density))
}

/// `PatternReport.from_chart_uncached` with Interlude's difficulty strains at
/// `rate`.
pub fn report(chart: &Chart, rate: f32) -> Report {
    analyse(chart, rate).1
}

fn report_from(chart: &Chart, found: &[Found], density: Vec<f32>) -> Report {
    let mut all: Vec<Cluster> = clusters(found).into_iter().filter(|c| c.bpm > 25).collect();
    all.sort_by(|a, b| b.amount.total_cmp(&a.amount));
    let prunable = |c: &Cluster| {
        all.iter()
            .any(|o| o.pattern == c.pattern && o.amount * 0.5 > c.amount && o.bpm > c.bpm)
    };
    let kept: Vec<&Cluster> = all.iter().filter(|c| !prunable(c)).collect();
    let mut pruned: Vec<Cluster> = [
        CorePattern::Stream,
        CorePattern::Chordstream,
        CorePattern::Jacks,
    ]
    .into_iter()
    .flat_map(|p| {
        kept.iter()
            .filter(move |c| c.pattern == p)
            .take(3)
            .map(|c| (*c).clone())
    })
    .collect();
    pruned.sort_by(|a, b| b.importance.total_cmp(&a.importance));
    let (mut notes, mut lnotes) = (0u32, 0u32);
    for (_, row) in &chart.rows {
        for n in row {
            if *n == NORMAL {
                notes += 1;
            } else if *n == HOLDHEAD {
                notes += 1;
                lnotes += 1;
            }
        }
    }
    let mut sorted = density;
    sorted.sort_by(f32::total_cmp);
    Report {
        keys: chart.keys as u32,
        category: categorise(&pruned),
        clusters: pruned,
        ln_percent: lnotes as f32 / notes as f32,
        density: percentiles(&sorted),
        duration: chart.last() - chart.first(),
    }
}
