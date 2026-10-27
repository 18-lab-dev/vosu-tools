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
// Port of YAVSRG Prelude NoteDifficulty.fs, Strain.fs (finger strains),
// Difficulty.fs and Layout.fs at 1fe55766ae1fece3d433c966bf25822647bc8af6.
// The upstream upcoming hand-strain model and variety are not used in Overall.
use crate::Row;
pub const REVISION: &str = "YAVSRG@1fe55766ae1fece3d433c966bf25822647bc8af6";
pub fn calculate(rows: &[Row], keys: usize, rate: f32) -> (f32, Vec<(f32, f32)>) {
    if rows.is_empty() {
        return (0.0, Vec::new());
    }
    let heads: Vec<(f32, u32)> = rows.iter().map(|r| (r.seconds * 1000.0, r.notes)).collect();
    let strains = finger_strains(&heads, keys, rate);
    let series = rows
        .iter()
        .zip(&strains)
        .map(|(row, s)| {
            (
                row.seconds / rate,
                s.iter().copied().fold(0.0_f32, f32::max),
            )
        })
        .collect();
    (overall(strains.iter().flatten().copied()), series)
}

/// Upstream `Strain.calculate_finger_strains` (`StrainV1Notes`): one array per
/// row of `(time ms, head bitmask)`, holding the burst strain of each column
/// with a head in that row and 0 elsewhere. Rows without heads (hold tails in
/// Prelude's native chart) keep their index and yield zeros.
pub fn finger_strains(rows: &[(f32, u32)], keys: usize, rate: f32) -> Vec<Vec<f32>> {
    let Some(&(first, _)) = rows.first() else {
        return Vec::new();
    };
    let split = keys.div_ceil(2);
    let mut previous = vec![first - 1_000_000.0; keys];
    let mut previous_strain = vec![0.0; keys];
    let mut strain = vec![0.0; keys];
    let mut out = Vec::with_capacity(rows.len());
    for &(time, notes) in rows {
        let mut row = vec![0.0_f32; keys];
        for k in 0..keys {
            if notes & (1 << k) == 0 {
                continue;
            }
            let delta = (time - previous[k]) / rate;
            let j = (15000.0 / delta).min(230.0);
            let mut sl = 0.0_f32;
            let mut sr = 0.0_f32;
            let bounds = if k < split { 0..split } else { split..keys };
            for h in bounds {
                if h == k {
                    continue;
                }
                let d = (time - previous[h]) / rate;
                let stream = (300.0 / (0.02 * d) - 300.0 / (0.02 * d).powf(10.0) / 10.0).max(0.0);
                let compensation = (delta / d).log2().max(0.0).sqrt().min(1.0);
                if h < k {
                    sl = sl.max(stream * compensation);
                } else {
                    sr = sr.max(stream * compensation);
                }
            }
            let total =
                ((6.0 * sl.powf(0.5)).powf(3.0) + (6.0 * sr.powf(0.5)).powf(3.0) + j.powf(3.0))
                    .powf(1.0 / 3.0);
            let dt = (time - previous_strain[k]) / rate;
            let decay_rate = 0.5_f32.ln() / 1575.0;
            let decay = (decay_rate * dt.min(200.0)).exp();
            let cap = if dt > 200.0 {
                (decay_rate * (dt - 200.0)).exp()
            } else {
                1.0
            };
            let a = strain[k] * cap;
            let b = total * total * 0.01626;
            strain[k] = b - (b - a) * decay;
            previous_strain[k] = time;
            row[k] = strain[k];
        }
        for (k, p) in previous.iter_mut().enumerate() {
            if notes & (1 << k) != 0 {
                *p = time;
            }
        }
        out.push(row);
    }
    out
}

/// Upstream `Difficulty.weighted_overall_difficulty` over the positive values.
pub fn weighted_overall(values: impl Iterator<Item = f32>) -> f32 {
    let mut values: Vec<f32> = values.filter(|v| *v > 0.0).collect();
    values.sort_by(f32::total_cmp);
    let len = values.len() as f32;
    let (mut weight, mut total) = (0.0, 0.0);
    for (i, value) in values.into_iter().enumerate() {
        let w = 0.002 + ((i as f32 + 2500.0 - len) / 2500.0).max(0.0).powf(4.0);
        weight += w;
        total += value * w;
    }
    (total / weight).powf(0.6) * 0.4056
}

fn overall(values: impl Iterator<Item = f32>) -> f32 {
    let rating = weighted_overall(values);
    if rating.is_finite() { rating } else { 0.0 }
}
