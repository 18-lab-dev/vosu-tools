use crate::{Difficulty, Params, calculate, checksum, interlude, rows};
use rosu_map::{Beatmap, section::general::GameMode};
use serde_json::{Value, json};

pub fn systems(value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        for system in value.split(',') {
            if !matches!(
                system,
                "etterna" | "etterna-native" | "quaver" | "interlude" | "osu" | "nps"
            ) {
                return Err(format!(
                    "unsupported system {system}; available: etterna,etterna-native,quaver,interlude,osu,nps"
                ));
            }
        }
    }
    Ok(())
}
pub fn rate_ticks(step: f32) -> Result<Vec<u8>, String> {
    if !step.is_finite()
        || !(0.05..=1.5).contains(&step)
        || (step * 20.0 - (step * 20.0).round()).abs() > 0.0001
    {
        return Err("step must be a multiple of 0.05 between 0.05 and 1.5".into());
    }
    Ok((10..=40).step_by((step * 20.0).round() as usize).collect())
}
/// Half-open chart-time range; retain heads in range and entire associated holds.
/// Reset calculator state at t0. Do not rebase timestamps: native first-note timing
/// affects the upstream Interlude model, and this preserves whole-map equality.
pub fn section(bytes: &[u8], p: Params, start: f32, end: f32) -> Result<Value, String> {
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start || end > 24001.0 {
        return Err("section requires 0 <= start < end <= 24001 (chart seconds)".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let mut objects = false;
    let mut clipped = String::with_capacity(text.len());
    for line in text.lines() {
        if line.trim().starts_with('[') {
            objects = line.trim() == "[HitObjects]";
        }
        if objects
            && !line.trim().starts_with('[')
            && !line.trim().is_empty()
            && !line.trim().starts_with("//")
        {
            let time = line
                .split(',')
                .nth(2)
                .ok_or("invalid hit object")?
                .trim()
                .parse::<f32>()
                .map_err(|e| e.to_string())?
                / 1000.0;
            if time < start || time >= end {
                continue;
            }
        }
        clipped.push_str(line);
        clipped.push('\n');
    }
    let rating: Difficulty = calculate(clipped.as_bytes(), p)?;
    Ok(
        json!({"checksum":checksum(bytes),"start":start,"end":end,"context":"reset_at_start; original chart timestamps; heads in [start,end), complete holds retained","rating":rating}),
    )
}
pub fn timeline(
    bytes: &[u8],
    p: Params,
    system: &str,
    window: f32,
    hop: f32,
) -> Result<Value, String> {
    systems(Some(system))?;
    if !window.is_finite()
        || !hop.is_finite()
        || !(0.1..=60.0).contains(&window)
        || !(0.05..=60.0).contains(&hop)
    {
        return Err("window must be 0.1–60s; hop must be 0.05–60s".into());
    }
    let map = Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?;
    if map.mode != GameMode::Mania {
        return Err("native mania maps only".into());
    }
    let keys = map.circle_size as u32;
    let rows = rows(&map, keys)?;
    let duration = rows.last().map_or(0.0, |r| r.seconds + 0.001);
    if system == "etterna" {
        return local_msd(bytes, &rows, keys, p, window, hop, duration);
    }
    let native = if system == "etterna-native" {
        minacalc::intervals(&rows, keys, p.rate())?
    } else {
        Vec::new()
    };
    let interlude_series = if system == "interlude" {
        interlude::calculate(&rows, keys as usize, p.rate()).1
    } else {
        Vec::new()
    };
    let quaver_series = if system == "quaver" {
        crate::quaver::calculate(&map, p.rate()).1
    } else {
        Vec::new()
    };
    let osu_series = if system == "osu" {
        let map = rosu_pp::Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?;
        rosu_pp::Difficulty::new()
            .clock_rate(f64::from(p.rate()))
            .strains_for_mode::<rosu_pp::mania::Mania>(&map)
            .map_err(|e| e.to_string())?
            .strains
    } else {
        Vec::new()
    };
    let mut points = Vec::new();
    for i in 0..=(duration / hop).ceil() as usize {
        let start = i as f32 * hop;
        if start > duration {
            break;
        }
        let end = start + window;
        let heads: u32 = rows
            .iter()
            .filter(|r| r.seconds >= start && r.seconds < end)
            .map(|r| r.notes.count_ones())
            .sum();
        let nps = heads as f32 * p.rate() / window;
        let mut skills = [0.0_f32; 8];
        let value = match system {
            "etterna-native" => {
                for (index, interval) in native.iter().enumerate() {
                    let time = index as f32 * 0.5 * p.rate();
                    if time < end && time + 0.5 * p.rate() > start {
                        for (peak, &v) in skills.iter_mut().zip(interval) {
                            *peak = peak.max(v);
                        }
                    }
                }
                skills.iter().copied().fold(0.0_f32, f32::max)
            }
            "interlude" => interlude_series
                .iter()
                .filter(|(t, _)| *t * p.rate() >= start && *t * p.rate() < end)
                .map(|(_, v)| *v)
                .fold(0.0_f32, f32::max),
            "quaver" => quaver_series
                .iter()
                .filter(|(t, _)| *t * p.rate() >= start && *t * p.rate() < end)
                .map(|(_, v)| *v)
                .fold(0.0_f32, f32::max),
            "osu" => osu_series
                .iter()
                .enumerate()
                .filter(|(i, _)| {
                    let time = *i as f32 * 0.4 * p.rate();
                    time < end && time + 0.4 * p.rate() > start
                })
                .map(|(_, v)| *v as f32)
                .fold(0.0_f32, f32::max),
            _ => nps,
        };
        points.push(json!({"time":start,"value":value,"nps":nps,"skills":skills}));
    }
    Ok(
        json!({"checksum":checksum(bytes),"rate":p.rate(),"system":system,"window":window,"hop":hop,"time_unit":"chart_seconds","smoothing":"none","aggregation":"overlapping-window maximum of native full-chart strains; NPS counts heads / playback window duration","units":match system {"etterna-native"=>"native base-adjusted interval difficulty (max hand); NOT local MSD", "quaver"=>"action strain", "interlude"=>"finger strain", "osu"=>"strain peak (rosu-pp 4.0.1, 400ms playback sections)", _=>"notes per playback second"},"duration":duration,"points":points}),
    )
}

fn local_msd(
    bytes: &[u8],
    rows: &[crate::Row],
    keys: u32,
    p: Params,
    window: f32,
    hop: f32,
    duration: f32,
) -> Result<Value, String> {
    let overall = minacalc::calculate(rows, keys, p.rate(), None)?;
    let mut points = Vec::with_capacity((duration / hop).ceil() as usize + 1);
    let mut clipped = Vec::new();
    for i in 0..=(duration / hop).floor() as usize {
        let time = i as f32 * hop;
        let start = (time - window / 2.0).max(0.0);
        let end = (time + window / 2.0).min(duration);
        let lo = rows.partition_point(|r| r.seconds < start);
        let hi = rows.partition_point(|r| r.seconds < end);
        clipped.clear();
        clipped.extend(rows[lo..hi].iter().map(|r| crate::Row {
            notes: r.notes,
            seconds: r.seconds - start,
        }));
        let skills = minacalc::calculate(&clipped, keys, p.rate(), None)?;
        let heads: u32 = clipped.iter().map(|r| r.notes.count_ones()).sum();
        let nps = if end > start {
            heads as f32 * p.rate() / (end - start)
        } else {
            0.0
        };
        points.push(json!({"time":time,"start":start,"end":end,"value":skills[0],"skills":skills,"nps":nps}));
    }
    Ok(json!({
        "checksum":checksum(bytes),"rate":p.rate(),"system":"etterna",
        "mode":"local_msd","calculator":crate::CALCULATOR,
        "window":window,"hop":hop,"time_unit":"chart_seconds","smoothing":"none",
        "context":"independent centered windows; reset context; heads in [start,end); timestamps rebased to window start; clipped at chart edges",
        "aggregation":"MinaCalc CalcMain independently on each window at 0.93 goal; no averaging or strain-to-MSD conversion",
        "units":"local MSD","overall":overall[0],"overall_skills":overall,
        "skill_names":["overall","stream","jumpstream","handstream","stamina","jackspeed","chordjack","technical"],
        "duration":duration,"points":points
    }))
}
