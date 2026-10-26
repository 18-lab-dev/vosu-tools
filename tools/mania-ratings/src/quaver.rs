// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2017-2018 Swan & The Quaver Team <support@quavergame.com>.
// Rust port of Quaver.API DifficultyProcessorKeys 0.0.5 and solver structures,
// pinned to a921d561b2ece7f6bf3682446696c06c17b81649. Default constants only.
// Deliberately preserves upstream odd-key second-pass accumulation, bin-index
// behavior, chord anchor EndTime, and repeated CalculateStrainValue accumulation.
use rosu_map::{Beatmap, section::hit_objects::HitObjectKind};
pub const REVISION: &str = "Quaver.API@a921d561b2ece7f6bf3682446696c06c17b81649";
#[derive(Clone)]
struct Point {
    time: f32,
    end: f32,
    hand: bool,
    fingers: Vec<u32>,
    state: u32,
    next: Option<usize>,
    action: u8,
    duration: f32,
    coefficient: f32,
    manipulation: f32,
    ln: f32,
    total: f32,
}
fn coefficient(duration: f32, action: u8, density: f32) -> f32 {
    let (lo, hi, max, exponent) = match action {
        1 => (30.0, 230.0, 55.0, 1.13),
        2 => (40.0, 320.0, 68.0, 1.17),
        3 => (40.0, 330.0, 70.0, 1.14),
        _ => (30.0, 230.0, 56.0, 1.13),
    };
    let ratio = (1.0_f32 - (duration - lo) / (hi - lo)).max(0.0);
    if ratio == 0.0 && density < 4.0 {
        return if density < 1.0 {
            0.4
        } else {
            density * 0.266 + 0.134
        };
    }
    1.0 + (max - 1.0) * f64::from(ratio).powf(exponent) as f32
}
fn solve(data: &mut Vec<Point>, additions: &[Point], density: f32, odd: bool) -> f32 {
    data.extend_from_slice(additions);
    let mut i = 0;
    while i + 1 < data.len() {
        let mut j = i + 1;
        while j < data.len() {
            let delta = data[j].time - data[i].time;
            if delta > 8.0 {
                break;
            }
            if delta.abs() <= 8.0 && data[i].hand == data[j].hand {
                let other = data.remove(j);
                for finger in other.fingers {
                    if !data[i].fingers.contains(&finger) {
                        data[i].fingers.push(finger);
                    }
                }
            }
            j += 1; // upstream advances after RemoveAt without revisiting the shifted point
        }
        i += 1;
    }
    for point in data.iter_mut() {
        for &finger in &point.fingers {
            point.state |= finger;
        }
    }
    for i in 0..data.len().saturating_sub(1) {
        for j in i + 1..data.len() {
            if data[i].hand == data[j].hand && data[j].time > data[i].time {
                let a = &data[i];
                let b = &data[j];
                let action = if a.fingers.len() == 1 && b.fingers.len() == 1 && a.state != b.state {
                    1
                } else if a.state == b.state {
                    2
                } else if a.state & b.state != 0 {
                    3
                } else {
                    4
                };
                let duration = b.time - a.time;
                data[i].next = Some(j);
                data[i].duration = duration;
                data[i].action = action;
                data[i].coefficient = coefficient(duration, action, density);
                break;
            }
        }
    }
    let mut index = 0.0_f32;
    for i in 0..data.len() {
        let mut found = false;
        if let Some(middle) = data[i].next
            && let Some(last) = data[middle].next
            && data[i].action == 1
            && data[middle].action == 1
            && data[i].state == data[last].state
        {
            let ratio = (data[i].duration / data[middle].duration)
                .max(data[middle].duration / data[i].duration);
            if ratio >= 2.0 {
                data[i].manipulation =
                    1.0 / (1.0 + (ratio - 1.0) * 0.25) * (1.0 - index / 14.0 * (1.0 - 0.6));
                found = true;
                if index < 14.0 {
                    index += 1.0;
                }
            }
        }
        if !found && index > 0.0 {
            index -= 1.0;
        }
    }
    let mut jack_length = 0.0_f32;
    for i in 0..data.len() {
        if let Some(next) = data[i].next
            && data[i].action == 2
            && data[next].action == 2
        {
            let duration = ((88.2 + 88.2 - data[i].duration) / 88.2).clamp(0.0, 1.0);
            data[i].manipulation =
                (1.0 - duration * (1.0 - 0.75)) * (1.0 - jack_length / 6.0 * (1.0 - 0.3));
            if jack_length < 6.0 {
                jack_length += 1.0;
            }
        } else {
            jack_length = 0.0;
        }
    }
    for i in 0..data.len() {
        if data[i].end > data[i].time {
            let duration =
                1.0 - ((93.7 + 60.0 - (data[i].end - data[i].time)) / 60.0).clamp(0.0, 1.0);
            data[i].ln = 1.0 + duration * 0.6;
            if let Some(next) = data[i].next
                && data[next].time < data[i].end - 42.0
                && data[next].time >= data[i].time + 42.0
            {
                data[i].ln *= if data[next].end > data[i].end + 42.0 {
                    1.0
                } else if data[next].end > 0.0 {
                    1.3
                } else {
                    1.05
                };
            }
        }
    }
    if data.is_empty() {
        return 0.0;
    }
    for p in data.iter_mut() {
        let strain = p.coefficient * p.manipulation * p.ln;
        for _ in &p.fingers {
            p.total += strain;
        }
        p.total /= p.fingers.len() as f32;
    }
    // LINQ Average(float) sums using double precision.
    let mut overall =
        (data.iter().map(|p| f64::from(p.total)).sum::<f64>() / data.len() as f64) as f32;
    let start = data.iter().map(|p| p.time).fold(f32::INFINITY, f32::min);
    let end = data
        .iter()
        .map(|p| p.time.max(p.end))
        .fold(0.0_f32, f32::max);
    let (mut left, mut right) = (0, 0);
    let mut bins = Vec::new();
    let mut time = start;
    while time < end {
        let average = if odd {
            let mut sum = 0.0_f64;
            let mut count = 0;
            for p in data
                .iter()
                .filter(|p| p.time >= time && p.time < time + 1000.0)
            {
                sum += f64::from(p.total);
                count += 1;
            }
            if count > 0 {
                (sum / count as f64) as f32
            } else {
                0.0
            }
        } else {
            while right < data.len() - 1 && data[right + 1].time < time + 1000.0 {
                right += 1;
            }
            if left >= data.len() {
                0.0
            } else {
                let slice = &data[left..=right];
                (slice.iter().map(|p| f64::from(p.total)).sum::<f64>() / slice.len() as f64) as f32
            }
        };
        bins.push(average);
        left = right + 1;
        time += 1000.0;
    }
    if !bins.iter().any(|v| *v > 0.0) {
        return 0.0;
    }
    let cutoff = (bins.len() as f64 * 0.4).floor() as usize;
    let mut sorted = bins.clone();
    sorted.sort_by(|a, b| b.total_cmp(a));
    let easy = if cutoff > 0 {
        (sorted[..cutoff].iter().map(|v| f64::from(*v)).sum::<f64>() / cutoff as f64) as f32
    } else {
        0.0
    };
    let positive = bins.iter().filter(|v| **v > 0.0).collect::<Vec<_>>();
    let continuity = (positive
        .iter()
        .map(|v| f64::from(**v / easy).sqrt())
        .sum::<f64>()
        / positive.len() as f64) as f32;
    let adjustment = if continuity > 0.85 {
        ((1.0 - (continuity - 0.85) / (1.0 - 0.85)) * (1.0 - 0.9) + 0.9).clamp(0.9, 1.0)
    } else {
        ((1.0 - (continuity - 0.6) / (0.85 - 0.6)) * (1.05 - 1.0) + 1.0).clamp(1.0, 1.05)
    };
    overall *= adjustment;
    let drain = bins.len() as f32 * continuity * 1000.0;
    overall *= (0.25 * f64::from(drain / 60000.0).sqrt() + 0.75).clamp(0.75, 1.0) as f32;
    overall
}
pub fn calculate(map: &Beatmap, rate: f32) -> (f32, Vec<(f32, f32)>) {
    let keys = map.circle_size as usize;
    if map.hit_objects.len() < 2 {
        return (0.0, Vec::new());
    }
    let mut additions = Vec::with_capacity(map.hit_objects.len());
    let mut length = 0.0_f32;
    for note in &map.hit_objects {
        let (x, end) = match &note.kind {
            HitObjectKind::Circle(c) => (c.pos.x, 0.0),
            HitObjectKind::Hold(h) => (h.pos_x, (note.start_time + h.duration) as f32),
            _ => continue,
        };
        let lane = ((x * keys as f32 / 512.0).floor() as usize).min(keys - 1) + 1;
        let half = keys / 2;
        let hand = lane > half;
        // Upstream LaneToFinger: 10K puts both middle lanes on the thumbs.
        let finger = if keys == 10 {
            match lane {
                1..=4 => 1 << (4 - lane),
                5 | 6 => 16,
                _ => 1 << (lane - 7),
            }
        } else if lane <= half {
            1 << (half - lane)
        } else if keys % 2 == 1 && lane == half + 1 {
            16
        } else {
            1 << (lane - half - 1 - usize::from(keys % 2 == 1))
        };
        let time = note.start_time as f32;
        length = length.max(time.max(end));
        additions.push(Point {
            time: time / rate,
            end: end / rate,
            hand,
            fingers: vec![finger],
            state: 0,
            next: None,
            action: 0,
            duration: 0.0,
            coefficient: 1.0,
            manipulation: 1.0,
            ln: 1.0,
            total: 0.0,
        });
    }
    let density = 1000.0 * map.hit_objects.len() as f32 / (length * (-0.5 * rate + 1.5));
    let mut data = Vec::new();
    if keys % 2 == 1 {
        // Upstream evaluates left assumption first, then right on the SAME processor.
        for p in &mut additions {
            if p.fingers[0] == 16 {
                p.hand = false;
            }
        }
        let left = solve(&mut data, &additions, density, true);
        for p in &mut additions {
            if p.fingers[0] == 16 {
                p.hand = true;
            }
        }
        let right = solve(&mut data, &additions, density, true);
        (
            (left + right) / 2.0,
            data.iter().map(|p| (p.time / 1000.0, p.total)).collect(),
        )
    } else {
        let rating = solve(&mut data, &additions, density, false);
        (
            rating,
            data.iter().map(|p| (p.time / 1000.0, p.total)).collect(),
        )
    }
}
