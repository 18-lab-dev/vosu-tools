// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.
// OsuModRandom and OsuHitObjectGenerationUtils, ppy/osu
// 2f4e620cbc6245fb88fe1113c1842c213ea58701. See practice/PROVENANCE.md.
use crate::{map::Options, mods::DotNetRandom};
use anyhow::{Context, Result, ensure};
use rosu_map::{
    section::hit_objects::{CurveBuffers, HitObjectKind, SliderPath},
    util::Pos,
};
use std::f32::consts::{PI, TAU};
const CENTRE: Pos = Pos::new(256.0, 192.0);

struct Object {
    pos: Pos,
    end: Pos,
    path: Option<SliderPath>,
    tokens: Vec<(String, Option<Pos>)>,
    spans: i32,
    spinner: bool,
    new_combo: bool,
    combo_index: usize,
    relative: f32,
    distance: f32,
    rotation: f32,
    original_rotation: f32,
    modified: Pos,
    modified_end: Pos,
}
impl Object {
    fn rotation(&mut self, bufs: &mut CurveBuffers) -> f32 {
        self.path.as_mut().map_or(0.0, |p| {
            let end = p.curve_with_bufs(bufs).position_at(1.0);
            end.y.atan2(end.x)
        })
    }
    fn end(&mut self, bufs: &mut CurveBuffers) -> Pos {
        self.pos
            + self.path.as_mut().map_or(Pos::default(), |p| {
                p.curve_with_bufs(bufs)
                    .position_at(if self.spans % 2 == 0 { 0.0 } else { 1.0 })
            })
    }
    fn transform_path(&mut self, f: impl Fn(Pos) -> Pos) {
        if let Some(path) = &mut self.path {
            for point in path.control_points_mut() {
                point.pos = f(point.pos);
            }
            for (_, point) in &mut self.tokens {
                if let Some(p) = point {
                    *p = f(*p);
                }
            }
        }
    }
    fn centre_of_mass(&mut self, bufs: &mut CurveBuffers) -> Pos {
        let curve = self.path.as_mut().expect("slider").curve_with_bufs(bufs);
        if curve.dist() <= 50.0 {
            return curve.position_at(1.0) / 2.0;
        }
        let mut sum = Pos::default();
        let mut count = 0;
        let mut d = 0.0;
        while d < curve.dist() {
            sum += curve.position_at(d / curve.dist());
            count += 1;
            d += 50.0;
        }
        sum / count as f32
    }
    fn bounds(&mut self, radius: f32, bufs: &mut CurveBuffers) -> (f32, f32, f32, f32) {
        let mut min = Pos::new(f32::INFINITY, f32::INFINITY);
        let mut max = Pos::new(f32::NEG_INFINITY, f32::NEG_INFINITY);
        for p in self
            .path
            .as_mut()
            .expect("slider")
            .curve_with_bufs(bufs)
            .path()
        {
            min.x = min.x.min(p.x);
            min.y = min.y.min(p.y);
            max.x = max.x.max(p.x);
            max.y = max.y.max(p.y);
        }
        // Keep RectangleF's subtraction/addition order: changing it can move
        // a boundary by one float ULP before integer serialization.
        let left = -(min.x - radius);
        let right = 512.0 - (max.x + radius);
        let top = -(min.y - radius);
        let bottom = 384.0 - (max.y + radius);
        (left, left + (right - left), top, top + (bottom - top))
    }
}
fn rotate(v: Pos, angle: f32) -> Pos {
    let angle = v.y.atan2(v.x) + angle;
    let length = v.length();
    Pos::new(length * angle.cos(), length * angle.sin())
}
fn away(previous: Pos, relative: Pos) -> Pos {
    let mut distance = 0.0_f32;
    distance = distance.max(if previous.x < 256.0 {
        (192.0 - previous.x) / 192.0
    } else {
        (previous.x - 320.0) / 192.0
    });
    distance = distance.max(if previous.y < 192.0 {
        (144.0 - previous.y) / 144.0
    } else {
        (previous.y - 240.0) / 144.0
    });
    let destination = CENTRE - previous;
    let initial = relative.y.atan2(relative.x);
    let target = destination.y.atan2(destination.x);
    let mut diff = target - initial;
    while diff < -PI {
        diff += TAU;
    }
    while diff > PI {
        diff -= TAU;
    }
    let angle = initial + (distance * 0.5).min(1.0) * diff;
    Pos::new(
        relative.length() * angle.cos(),
        relative.length() * angle.sin(),
    )
}
fn clamp(p: Pos, radius: f32) -> Pos {
    Pos::new(
        p.x.clamp(radius, 512.0 - radius),
        p.y.clamp(radius, 384.0 - radius),
    )
}
fn angle_diff(a: f32, b: f32) -> f32 {
    let diff = (a - b).abs() % TAU;
    diff.min(TAU - diff)
}
fn gaussian(rng: &mut DotNetRandom, stddev: f32) -> f32 {
    let x1 = 1.0 - rng.double();
    let x2 = 1.0 - rng.double();
    stddev * ((-2.0 * x1.ln()).sqrt() * (std::f64::consts::TAU * x2).sin()) as f32
}
fn fast_diagonal() -> f32 {
    // osuTK Vector2.LengthFast, one Newton step; mathematical approximation.
    let squared = 512.0_f32 * 512.0 + 384.0 * 384.0;
    let guess = f32::from_bits(0x5f375a86 - (squared.to_bits() >> 1));
    1.0 / (guess * (1.5 - (0.5 * squared) * guess * guess))
}

pub(crate) fn apply(text: &str, rows: &mut [Vec<String>], options: &Options) -> Result<()> {
    rows.sort_by(|a, b| {
        a[2].parse::<f64>()
            .unwrap()
            .total_cmp(&b[2].parse::<f64>().unwrap())
    });
    let parsed = rosu_map::Beatmap::from_bytes(text.as_bytes())?;
    ensure!(
        parsed.hit_objects.len() == rows.len(),
        "osu! Random cannot decode every hit object"
    );
    let mut bufs = CurveBuffers::default();
    let mut objects: Vec<Object> = Vec::with_capacity(rows.len());
    let mut previous = CENTRE;
    let mut previous_angle = 0.0;
    let mut combo_index = 0;
    for (i, (raw, hit)) in rows.iter().zip(parsed.hit_objects).enumerate() {
        ensure!(
            (raw[2].parse::<f64>()? - hit.start_time).abs() < 0.001,
            "hit object ordering mismatch"
        );
        let pos = Pos::new(raw[0].parse()?, raw[1].parse()?);
        let spinner = matches!(hit.kind, HitObjectKind::Spinner(_));
        let new_combo = hit.new_combo() || (!spinner && (i == 0 || objects[i - 1].spinner));
        combo_index = if new_combo { 0 } else { combo_index + 1 };
        let (path, spans) = if let HitObjectKind::Slider(s) = hit.kind {
            (Some(s.path), s.repeat_count + 1)
        } else {
            (None, 1)
        };
        let mut tokens = Vec::new();
        if path.is_some() {
            for token in raw.get(5).context("missing slider path")?.split('|') {
                tokens.push((
                    if token.contains(':') {
                        String::new()
                    } else {
                        token.to_owned()
                    },
                    if let Some((x, y)) = token.split_once(':') {
                        Some(Pos::new(
                            x.parse::<f32>()? - pos.x,
                            y.parse::<f32>()? - pos.y,
                        ))
                    } else {
                        None
                    },
                ));
            }
        }
        let relative = pos - previous;
        let absolute = relative.y.atan2(relative.x);
        let mut object = Object {
            pos,
            end: pos,
            path,
            tokens,
            spans,
            spinner,
            new_combo,
            combo_index,
            relative: absolute - previous_angle,
            distance: relative.length(),
            rotation: 0.0,
            original_rotation: 0.0,
            modified: pos,
            modified_end: pos,
        };
        let mut absolute = absolute;
        if object.path.is_some() {
            let rotation = object.rotation(&mut bufs);
            object.rotation = rotation - absolute;
            absolute = rotation;
        }
        object.end = object.end(&mut bufs);
        previous = object.end;
        previous_angle = absolute;
        objects.push(object);
    }
    let mut timing = Vec::new();
    let mut active = false;
    for line in text.lines() {
        if line.starts_with('[') {
            active = line.trim() == "[TimingPoints]";
            continue;
        }
        if active && !line.trim().is_empty() && !line.trim().starts_with("//") {
            let p = crate::map::csv(line);
            let beat = p[1].parse::<f64>()?;
            if beat > 0.0 {
                timing.push((
                    p[0].parse::<f64>()?,
                    beat,
                    p.get(2).map_or(Ok(4.0), |p| p.parse::<f64>())?,
                ));
            }
        }
    }
    ensure!(!timing.is_empty(), "no timing points");
    let on_beat = |index: usize, down: bool| {
        let time = rows[index][2].parse::<f64>().unwrap();
        let &(offset, beat, meter) = timing
            .iter()
            .rev()
            .find(|p| p.0 <= time)
            .unwrap_or(&timing[0]);
        (time - offset + 1.0).abs() % (beat * if down { meter } else { 1.0 }) < 2.0
    };
    let mut rng = DotNetRandom::new(options.seed);
    let mut section = 0.0;
    let mut flow = false;
    let sharpness = (options.angle_sharpness / 0.1).round_ties_even() * 0.1;
    let multiplier = (15.0 - sharpness) / 8.0;
    let diagonal = fast_diagonal();
    for i in 0..objects.len() {
        let previous_combo =
            i > 0 && objects[i.saturating_sub(2)].combo_index > 1 && objects[i - 1].new_combo;
        let new_section = i == 0
            || (previous_combo && rng.double() < f64::from(0.6_f32))
            || on_beat(i - 1, true)
            || (on_beat(i - 1, false) && rng.double() < f64::from(0.4_f32));
        if new_section {
            section = gaussian(&mut rng, 0.0008 * multiplier);
            flow = !flow;
        }
        if objects[i].path.is_some() && rng.double() < 0.5 {
            objects[i].transform_path(|p| Pos::new(-p.x, p.y));
        }
        if i == 0 {
            objects[i].distance = (rng.double() * 384.0 / 2.0) as f32;
            objects[i].relative =
                (rng.double() * 2.0 * std::f64::consts::PI - std::f64::consts::PI) as f32;
        } else {
            let one_time = gaussian(&mut rng, 0.002 * multiplier);
            let mut change = 0.0;
            if previous_combo && rng.double() < f64::from(0.6_f32) {
                change = gaussian(&mut rng, 0.002 * multiplier);
                flow = !flow;
            }
            let distance = objects[i].distance;
            let offset = (section + one_time) * distance + change * (diagonal - distance);
            let sharp = sharpness / 10.0;
            let wide = 1.0 - sharp;
            let custom_x = sharp * 100.0 - 70.0;
            let custom_y = wide * 0.25 - 0.075;
            let target = distance + custom_x;
            let mut angle = (2.16
                / (1.0 + 200.0 * (0.036 * f64::from(target - 310.0 + custom_x)).exp())
                + 0.5) as f32;
            angle += offset + custom_y;
            let relative = PI - angle;
            objects[i].relative = if flow { -relative } else { relative };
        }
    }
    let cs = options.cs.unwrap_or(f64::from(parsed.circle_size));
    let radius = 64.0 * ((1.0 - f64::from(0.7_f32) * ((cs - 5.0) / 5.0)) as f32 / 2.0 * 1.00041);
    for o in &mut objects {
        o.original_rotation = o.rotation(&mut bufs);
        o.modified = o.pos;
        o.modified_end = o.end(&mut bufs);
    }
    for i in 0..objects.len() {
        if objects[i].spinner {
            continue;
        }
        let previous_angle = if i == 0 {
            0.0
        } else if objects[i - 1].path.is_some() {
            objects[i - 1].rotation(&mut bufs)
        } else {
            let earliest = if i > 1 {
                objects[i - 2].end(&mut bufs)
            } else {
                CENTRE
            };
            let relative = objects[i - 1].pos - earliest;
            relative.y.atan2(relative.x)
        };
        let absolute = previous_angle + objects[i].relative;
        let previous_end = if i > 0 {
            objects[i - 1].modified_end
        } else {
            CENTRE
        };
        let relative = away(
            previous_end,
            Pos::new(
                objects[i].distance * absolute.cos(),
                objects[i].distance * absolute.sin(),
            ),
        );
        objects[i].modified = previous_end + relative;
        if objects[i].path.is_some() {
            let absolute = relative.y.atan2(relative.x);
            let original = objects[i].centre_of_mass(&mut bufs);
            let current_rotation = objects[i].rotation(&mut bufs);
            let modified = away(
                objects[i].modified,
                rotate(original, objects[i].rotation + absolute - current_rotation),
            );
            let rotation = modified.y.atan2(modified.x) - original.y.atan2(original.x);
            if rotation.abs() > 1e-3 {
                objects[i].transform_path(|p| rotate(p, rotation));
            }
        }
        let previous_position = objects[i].modified;
        if objects[i].path.is_none() {
            objects[i].modified = clamp(previous_position, radius);
            objects[i].modified_end = objects[i].modified;
            objects[i].pos = objects[i].modified;
        } else {
            let mut bounds = objects[i].bounds(radius, &mut bufs);
            if bounds.1 < bounds.0 || bounds.3 < bounds.2 {
                let rotation = objects[i].rotation(&mut bufs);
                let original = objects[i].original_rotation;
                let target = if angle_diff(original, rotation) < angle_diff(original + PI, rotation)
                {
                    original
                } else {
                    original + PI
                };
                objects[i].transform_path(|p| rotate(p, target - rotation));
                bounds = objects[i].bounds(radius, &mut bufs);
            }
            let pos = Pos::new(
                if bounds.1 < bounds.0 {
                    bounds.0.clamp(0.0, 512.0)
                } else {
                    previous_position.x.clamp(bounds.0, bounds.1)
                },
                if bounds.3 < bounds.2 {
                    bounds.2.clamp(0.0, 384.0)
                } else {
                    previous_position.y.clamp(bounds.2, bounds.3)
                },
            );
            objects[i].pos = pos;
            objects[i].modified = pos;
            objects[i].modified_end = objects[i].end(&mut bufs);
        }
        let shift = objects[i].modified - previous_position;
        if shift != Pos::default() {
            let mut count = 0;
            for j in (i.saturating_sub(10)..i).rev() {
                if objects[j].path.is_some() || objects[j].spinner {
                    break;
                }
                count += 1;
            }
            for j in 0..count {
                let index = i - 1 - j;
                objects[index].pos = clamp(
                    objects[index].pos + shift * ((count - j) as f32 / (count + 1) as f32),
                    radius,
                );
            }
        }
    }
    for (row, object) in rows.iter_mut().zip(objects) {
        if object.spinner {
            continue;
        }
        row[0] = (object.pos.x.round_ties_even() as i32).to_string();
        row[1] = (object.pos.y.round_ties_even() as i32).to_string();
        if object.path.is_some() {
            row[5] = object
                .tokens
                .iter()
                .map(|(token, point)| {
                    point.map_or_else(
                        || token.clone(),
                        |p| {
                            format!(
                                "{}:{}",
                                (p.x + object.pos.x).round_ties_even() as i32,
                                (p.y + object.pos.y).round_ties_even() as i32
                            )
                        },
                    )
                })
                .collect::<Vec<_>>()
                .join("|");
        }
    }
    Ok(())
}
