// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// Seeded random compatibility algorithm: Copyright (c) .NET Foundation and
// Contributors, MIT. License texts ship in tools/practice/licenses/.
// Algorithms ported from ppy/osu 2f4e620cbc6245fb88fe1113c1842c213ea58701.
// See tools/practice/PROVENANCE.md and licenses/osu-MIT.txt.
use crate::map::{Options, csv, number, value};
use anyhow::{Context, Result, ensure};

pub const GAMEPLAY_ONLY: &str = "Gameplay-only (not baked): Hidden, Fade In, Flashlight, Traceable, Blinds, Cover, No Fail, Sudden Death, Perfect, Relax, Autopilot, Spun Out, Autoplay, Cinema, No Release, Alternate, Single Tap, Adaptive Speed, scoring/input/visibility mods. Nightcore percussion overlays are not baked. Unsupported transforms are rejected, never silently ignored.";

fn has(o: &Options, m: &str) -> bool {
    o.mods.iter().any(|x| x == m)
}
fn mode(text: &str) -> Result<u8> {
    Ok(value(text, "[General]", "Mode")
        .unwrap_or_else(|| "0".into())
        .parse()?)
}

pub fn validate(o: &Options, text: &str) -> Result<()> {
    let mode = mode(text)?;
    ensure!(
        ["horizontal", "vertical", "both"].contains(&o.mirror.as_str()),
        "mirror must be horizontal, vertical or both"
    );
    ensure!(
        !(has(o, "IN") && has(o, "HO")),
        "Invert and Hold Off are incompatible"
    );
    ensure!(
        !(has(o, "SW") && has(o, "RD")),
        "Swap and Random are incompatible"
    );
    ensure!(
        o.mods
            .iter()
            .filter(|m| matches!(m.as_str(), "DT" | "HT" | "NC" | "DC"))
            .count()
            <= 1,
        "choose one rate mod"
    );
    for m in &o.mods {
        let allowed = match m.as_str() {
            "DT" | "HT" | "NC" | "DC" | "DA" => true,
            "MR" => matches!(mode, 0 | 3),
            "RD" => matches!(mode, 1 | 3),
            "SW" => mode == 1,
            "IN" | "HO" => mode == 3,
            _ => false,
        };
        ensure!(
            allowed,
            "{m} is not available as a faithful static transform for this ruleset"
        );
    }
    ensure!(
        mode == 0 || o.mirror == "horizontal",
        "vertical mirror is osu! only"
    );
    if mode == 3 {
        let keys = value(text, "[Difficulty]", "CircleSize")
            .unwrap_or_else(|| "4".into())
            .parse::<f64>()?;
        ensure!(
            o.cs.is_none_or(|cs| cs == keys),
            "mania key-count conversion is not supported on native maps by lazer"
        );
    }
    Ok(())
}

// Seeded System.Random(int) uses the compatibility subtractive generator, not
// xoshiro. This also preserves the stable OrderBy(rng.Next()) column shuffle.
struct DotNetRandom {
    state: [i32; 56],
    next: usize,
    next_p: usize,
}
impl DotNetRandom {
    fn new(seed: i32) -> Self {
        let mut state = [0; 56];
        let subtraction = if seed == i32::MIN {
            i32::MAX
        } else {
            seed.abs()
        };
        let mut mj = 161803398 - subtraction;
        state[55] = mj;
        let mut mk = 1;
        for i in 1..55 {
            let ii = (21 * i) % 55;
            state[ii] = mk;
            mk = mj.wrapping_sub(mk);
            if mk < 0 {
                mk += i32::MAX;
            }
            mj = state[ii];
        }
        for _ in 0..4 {
            for i in 1..56 {
                state[i] = state[i].wrapping_sub(state[1 + (i + 30) % 55]);
                if state[i] < 0 {
                    state[i] += i32::MAX;
                }
            }
        }
        Self {
            state,
            next: 0,
            next_p: 21,
        }
    }
    fn next(&mut self) -> i32 {
        self.next = self.next % 55 + 1;
        self.next_p = self.next_p % 55 + 1;
        let mut n = self.state[self.next].wrapping_sub(self.state[self.next_p]);
        if n == i32::MAX {
            n -= 1;
        }
        if n < 0 {
            n += i32::MAX;
        }
        self.state[self.next] = n;
        n
    }
    fn next_two(&mut self) -> i32 {
        (f64::from(self.next()) / f64::from(i32::MAX) * 2.0) as i32
    }
}

fn objects(text: &str) -> Result<Vec<Vec<String>>> {
    let mut active = false;
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            active = line == "[HitObjects]";
            continue;
        }
        if active && !line.is_empty() && !line.starts_with("//") {
            let p = csv(line);
            ensure!(p.len() >= 5, "invalid hit object");
            for i in [0, 1, 2, 3, 4] {
                p[i].parse::<f64>().context("invalid hit object number")?;
            }
            out.push(p);
        }
    }
    Ok(out)
}
fn start(p: &[String]) -> f64 {
    p[2].parse().expect("validated start time")
}
fn kind(p: &[String]) -> Result<u32> {
    Ok(p[3].parse()?)
}
fn sample(p: &[String]) -> String {
    if p[3].parse::<u32>().unwrap_or(0) & 128 != 0 {
        p.get(5)
            .and_then(|v| v.split_once(':'))
            .map(|(_, s)| s.to_owned())
            .unwrap_or_else(|| "0:0:0:0:".into())
    } else {
        p.get(5).cloned().unwrap_or_else(|| "0:0:0:0:".into())
    }
}
fn timings(text: &str) -> Result<Vec<(f64, f64)>> {
    let mut active = false;
    let mut out = Vec::new();
    for l in text.lines() {
        if l.starts_with('[') {
            active = l.trim() == "[TimingPoints]";
            continue;
        }
        if active && !l.trim().is_empty() && !l.trim().starts_with("//") {
            let p = csv(l);
            ensure!(p.len() >= 2, "invalid timing point");
            let beat = p[1].parse::<f64>()?;
            if beat > 0.0 {
                out.push((p[0].parse::<f64>()?, beat));
            }
        }
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    ensure!(!out.is_empty(), "no timing points");
    Ok(out)
}
fn beat_at(timing: &[(f64, f64)], t: f64) -> f64 {
    timing
        .iter()
        .rev()
        .find(|p| p.0 <= t)
        .unwrap_or(&timing[0])
        .1
}

pub fn apply(text: &str, o: &Options) -> Result<String> {
    validate(o, text)?;
    if !o
        .mods
        .iter()
        .any(|m| matches!(m.as_str(), "IN" | "HO" | "MR" | "RD" | "SW"))
    {
        return Ok(text.to_owned());
    }
    let mode = mode(text)?;
    let keys = value(text, "[Difficulty]", "CircleSize")
        .unwrap_or_else(|| "4".into())
        .parse::<f64>()? as usize;
    ensure!(
        mode != 3 || (1..=18).contains(&keys),
        "invalid mania key count"
    );
    let mut notes = objects(text)?;
    let timing = timings(text)?;
    if has(o, "IN") {
        let mut inverted = Vec::new();
        for column in 0..keys {
            let mut lane: Vec<_> = notes
                .iter()
                .filter(|p| {
                    ((p[0].parse::<f64>().unwrap() / 512.0 * keys as f64) as usize).min(keys - 1)
                        == column
                })
                .collect();
            lane.sort_by(|a, b| start(a).total_cmp(&start(b)));
            for pair in lane.windows(2) {
                let t = start(pair[0]);
                let next = start(pair[1]);
                let delta = next - t;
                let end = t + (delta / 2.0).max(delta - beat_at(&timing, next) / 4.0);
                let mut p = pair[0].clone();
                p[3] = "128".into();
                p.truncate(5);
                p.push(format!("{}:{}", number(end.round()), sample(pair[0])));
                inverted.push(p);
            }
        }
        notes = inverted;
    }
    if has(o, "HO") {
        for p in &mut notes {
            if kind(p)? & 128 != 0 {
                let s = sample(p);
                p[3] = "1".into();
                p.truncate(5);
                p.push(s);
            }
        }
    }
    let mut random = DotNetRandom::new(o.seed);
    let mut permutation: Vec<usize> = (0..keys).collect();
    if mode == 3 && has(o, "RD") {
        let mut keyed: Vec<_> = permutation.iter().map(|k| (random.next(), *k)).collect();
        keyed.sort_by_key(|p| p.0);
        permutation = keyed.into_iter().map(|p| p.1).collect();
    }
    notes.sort_by(|a, b| start(a).total_cmp(&start(b)));
    for p in &mut notes {
        let k = kind(p)?;
        if mode == 3 && (has(o, "MR") || has(o, "RD")) {
            let mut column = ((p[0].parse::<f64>()? / 512.0 * keys as f64) as usize).min(keys - 1);
            if has(o, "RD") {
                column = permutation[column];
            }
            if has(o, "MR") {
                column = keys - 1 - column;
            }
            p[0] = number(((column as f64 + 0.5) * 512.0 / keys as f64).floor());
        } else if mode == 0 && has(o, "MR") && k & 8 == 0 {
            let horizontal = o.mirror != "vertical";
            let vertical = o.mirror != "horizontal";
            if horizontal {
                p[0] = number(512.0 - p[0].parse::<f64>()?);
            }
            if vertical {
                p[1] = number(384.0 - p[1].parse::<f64>()?);
            }
            if k & 2 != 0 {
                let path = p.get(5).context("missing slider path")?;
                let mut points = path.split('|').map(str::to_owned).collect::<Vec<_>>();
                for point in points.iter_mut().skip(1) {
                    if let Some((x, y)) = point.split_once(':') {
                        let x = x.parse::<f64>()?;
                        let y = y.parse::<f64>()?;
                        *point = format!(
                            "{}:{}",
                            number(if horizontal { 512.0 - x } else { x }),
                            number(if vertical { 384.0 - y } else { y })
                        );
                    }
                }
                p[5] = points.join("|");
            }
        } else if mode == 1 && k & 1 != 0 && (has(o, "SW") || has(o, "RD")) {
            let sound = p[4].parse::<u32>()?;
            let rim = if has(o, "RD") {
                random.next_two() != 0
            } else {
                sound & 10 == 0
            };
            p[4] = ((sound & !10) | if rim { 8 } else { 0 }).to_string();
        }
    }
    let mut out = Vec::new();
    let mut section = "";
    let mut wrote = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            section = line;
        }
        if section == "[HitObjects]" {
            if !wrote {
                out.push(raw.to_owned());
                out.extend(notes.iter().map(|p| p.join(",")));
                wrote = true;
            }
            continue;
        }
        if section == "[Events]" && has(o, "IN") && matches!(csv(line)[0].as_str(), "2" | "Break") {
            continue;
        }
        out.push(raw.to_owned());
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let output = out.join(newline) + newline;
    if has(o, "HO") {
        let ratio = common_beat_length(text)? / common_beat_length(&output)?;
        if (ratio - 1.0).abs() > 1e-7 {
            return scale_scroll(&output, ratio);
        }
    }
    Ok(output)
}

fn common_beat_length(text: &str) -> Result<f64> {
    let timing = timings(text)?;
    let last = summary(text)?.1;
    let mut durations: Vec<(f64, f64)> = Vec::new();
    for (i, (time, beat)) in timing.iter().enumerate() {
        let duration = if *time > last {
            0.0
        } else {
            timing.get(i + 1).map_or(last, |p| p.0) - if i == 0 { 0.0 } else { *time }
        };
        let rounded = (beat * 1000.0).round() / 1000.0;
        if let Some(p) = durations.iter_mut().find(|p| p.0 == rounded) {
            p.1 += duration;
        } else {
            durations.push((rounded, duration));
        }
    }
    // LINQ OrderByDescending is stable, so ties retain first timing-point order.
    durations.sort_by(|a, b| b.1.total_cmp(&a.1));
    Ok(durations.first().map_or(500.0, |p| p.0))
}

fn scale_scroll(text: &str, ratio: f64) -> Result<String> {
    let mut out = Vec::new();
    let mut active = false;
    for raw in text.lines() {
        if raw.starts_with('[') {
            active = raw.trim() == "[TimingPoints]";
        }
        if !active || raw.trim().is_empty() || raw.starts_with('[') || raw.trim().starts_with("//")
        {
            out.push(raw.to_owned());
            continue;
        }
        let mut p = csv(raw);
        let beat = p[1].parse::<f64>()?;
        if beat < 0.0 {
            p[1] = number(beat / ratio);
            out.push(p.join(","));
        } else {
            out.push(raw.to_owned());
            p.resize(8, "0".into());
            p[1] = number(-100.0 / ratio);
            p[6] = "0".into();
            out.push(p.join(","));
        }
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    Ok(out.join(newline) + newline)
}

/// Parsed object count and final playable timestamp, including hold/slider tails.
pub fn summary(text: &str) -> Result<(usize, f64)> {
    let notes = objects(text)?;
    let timing = timings(text)?;
    let slider_multiplier = value(text, "[Difficulty]", "SliderMultiplier")
        .unwrap_or_else(|| "1.4".into())
        .parse::<f64>()?;
    let mut last = 0.0_f64;
    for p in &notes {
        let mut end = start(p);
        let k = kind(p)?;
        if k & 128 != 0 {
            end = p
                .get(5)
                .context("missing hold end")?
                .split(':')
                .next()
                .context("missing hold end")?
                .parse()?;
        } else if k & 8 != 0 {
            end = p.get(5).context("missing spinner end")?.parse()?;
        } else if k & 2 != 0 {
            let length = p.get(7).context("missing slider length")?.parse::<f64>()?;
            let repeats = p.get(6).context("missing repeats")?.parse::<f64>()?;
            let mut section = "";
            let mut sv = 1.0;
            for line in text.lines() {
                if line.starts_with('[') {
                    section = line.trim();
                    continue;
                }
                if section != "[TimingPoints]"
                    || line.trim().is_empty()
                    || line.trim().starts_with("//")
                {
                    continue;
                }
                let point = csv(line);
                if point.len() < 2 {
                    continue;
                }
                if point[0].parse::<f64>()? > end {
                    break;
                }
                let beat = point[1].parse::<f64>()?;
                sv = if beat < 0.0 {
                    (-100.0 / beat).clamp(0.1, 10.0)
                } else {
                    1.0
                };
            }
            end += length * repeats * beat_at(&timing, end) / (100.0 * slider_multiplier * sv);
        }
        last = last.max(end);
    }
    Ok((notes.len(), last))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dotnet_seeded_reference() {
        let mut r = DotNetRandom::new(1);
        assert_eq!(
            (0..5).map(|_| r.next()).collect::<Vec<_>>(),
            vec![534011718, 237820880, 1002897798, 1657007234, 1412011072]
        );
    }
}
