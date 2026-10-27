use clap::Parser;
use serde_json::Value;
use std::io::Read;
use vosu_tool_sdk::{
    ToolEnv,
    cli::{Method, dan, number, print_result, range, ratings, table, text},
    send_json,
};
#[derive(Parser, Debug)]
#[command(
    name = "vosux map-analysis",
    about = "Calculate the selected beatmap, a .osu file, or stdin (-)"
)]
struct Args {
    file: Option<String>,
    #[arg(long)]
    mode: Option<String>,
    #[arg(long, default_value = "NM")]
    mods: String,
    #[arg(long, default_value="1", value_parser=rate)]
    rate: f64,
    #[arg(long, value_parser=score)]
    score: Option<f64>,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    systems: Option<String>,
    #[arg(long, conflicts_with = "section")]
    timeline: bool,
    #[arg(long, value_parser = parse_section)]
    section: Option<(f32, f32)>,
}
fn rate(s: &str) -> Result<f64, String> {
    range(s, 0.5, 2.0)
}
fn score(s: &str) -> Result<f64, String> {
    range(s, 0.0, 1.0)
}
fn parse_section(value: &str) -> Result<(f32, f32), String> {
    fn time(s: &str) -> Result<f32, String> {
        let parts = s.split(':').collect::<Vec<_>>();
        let seconds = match parts.as_slice() {
            [s] => s.parse::<f32>().map_err(|e| e.to_string())?,
            [m, s] => {
                m.parse::<f32>().map_err(|e| e.to_string())? * 60.0
                    + s.parse::<f32>().map_err(|e| e.to_string())?
            }
            _ => return Err("use seconds or m:ss".into()),
        };
        if !seconds.is_finite() || seconds < 0.0 {
            return Err("invalid section time".into());
        }
        Ok(seconds)
    }
    let (start, end) = value.split_once('-').ok_or("use 1:30-2:15")?;
    let pair = (time(start)?, time(end)?);
    if pair.1 <= pair.0 {
        return Err("section end must exceed start".into());
    }
    Ok(pair)
}
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse_from(
        std::iter::once("vosux map-analysis".to_owned()).chain(std::env::args().skip(2)),
    );
    let client = ToolEnv::from_env()?.client();
    let mut query = format!("rate={}&mods={}", args.rate, vosu_map_analysis::official::mods(&args.mods)?);
    if let Some(mode) = &args.mode {
        vosu_map_analysis::official::mode(mode)?;
        query.push_str(&format!("&mode={mode}"));
    }
    if let Some(score) = args.score {
        query.push_str(&format!("&score={score}"));
    }
    if let Some(systems) = &args.systems {
        vosu_map_analysis::analysis::systems(Some(systems))?;
        query.push_str(&format!("&systems={systems}"));
    }
    let result: Value = if let Some(file) = &args.file {
        let reader: Box<dyn Read> = if file == "-" {
            Box::new(std::io::stdin())
        } else {
            Box::new(std::fs::File::open(file)?)
        };
        let mut bytes = Vec::new();
        reader
            .take((vosu_map_analysis::MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > vosu_map_analysis::MAX_BYTES {
            return Err("beatmap exceeds 1 MiB".into());
        }
        send_json(
            client
                .own(Method::POST, &format!("v1/calculate?{query}"))
                .body(bytes),
        )
        .await?
    } else {
        client
            .own_json(&format!("v1/beatmap/current?{query}"))
            .await?
    };
    let header = format!(
        "{} — {} · {} notes · {}×",
        args.file.as_deref().unwrap_or("Selected beatmap"),
        if result["mode"] == "mania" { format!("{}K", result["keys"]) } else { text(&result["mode"]) },
        result["notes"],
        number(&result["rate"])
    );
    let checksum = result["checksum"]
        .as_str()
        .ok_or("missing beatmap checksum")?;
    let result = if args.timeline {
        let system = args
            .systems
            .as_deref()
            .unwrap_or("etterna")
            .split(',')
            .next()
            .unwrap_or("etterna");
        client
            .own_json::<Value>(&format!(
                "v1/beatmap/{checksum}/timeline?rate={}&system={system}",
                args.rate
            ))
            .await?
    } else if let Some((start, end)) = args.section {
        client
            .own_json::<Value>(&format!(
                "v1/beatmap/{checksum}/section?rate={}&start={start}&end={end}",
                args.rate
            ))
            .await?
    } else {
        result
    };
    print_result(&result, args.json, || human(&result, &header))?;
    Ok(())
}

fn human(result: &Value, header: &str) -> String {
    if result["official"].is_object() && result["mode"] != "mania" {
        let rows = result["official"]["skills"].as_object().into_iter().flatten()
            .map(|(name, value)| vec![name.clone(), number(value)]).collect::<Vec<_>>();
        let targets = result["performance"]["targets"].as_array().map(|targets| targets.iter()
            .map(|target| vec![number(&target["accuracy"]), number(&target["pp"])])
            .collect::<Vec<_>>());
        return format!("{header}\n{} stars · {}\n{}\n{}", number(&result["stars"]),text(&result["official"]["source"]),
            table(&["Attribute", "Value"], &rows), targets.map_or_else(||text(&result["performance"]["reason"]),|rows|table(&["Accuracy / %", "pp"],&rows)));
    }
    if let Some(points) = result["points"].as_array() {
        let rows = points
            .iter()
            .map(|p| vec![number(&p["time"]), number(&p["value"]), number(&p["nps"])])
            .collect::<Vec<_>>();
        return format!(
            "{header}\n{}\n{}",
            text(&result["units"]),
            table(&["Time / s", "Rating / strain", "NPS"], &rows)
        );
    }
    if result["rating"].is_object() {
        return human(&result["rating"], header);
    }
    // MinaCalc names its Jumpstream/Handstream slots differently outside 4K.
    let labels = minacalc::skill_names(result["keys"].as_u64().map_or(4, |k| k as u32));
    let unrated = |system: &str| {
        result["unrated"][system]["reason"]
            .as_str()
            .map(str::to_owned)
    };
    let reason = result["unsupported"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| unrated("reform"))
        .unwrap_or_else(|| "no estimate for this key count or rating".into());
    let unsupported = if result["unsupported"].is_string() {
        format!("\nUnsupported: {}", text(&result["unsupported"]))
    } else {
        String::new()
    };
    let msd = match unrated("etterna") {
        Some(why) if result["msd"].is_null() => format!("Etterna: — ({why})"),
        _ => ratings(&result["msd"], Some(&result["ssr"]), &labels),
    };
    let notes = ["quaver", "interlude"]
        .into_iter()
        .filter_map(|system| unrated(system).map(|why| format!("\n{why}")))
        .collect::<String>();
    format!(
        "{header}\n\n{msd}\n\nQuaver: {} · Interlude: {} · osu!mania: {} ★{notes}\n\n{}{}{}",
        number(&result["quaver"]),
        number(&result["interlude"]),
        number(&result["stars"]),
        dan(&result["dan"], &reason),
        extras(result),
        unsupported
    )
}
/// Prism, Interlude patterns, the 7K view and dan, and LN statistics, each
/// named by its source; only the ones that apply to the chart.
fn extras(result: &Value) -> String {
    let mut out = String::new();
    let pct = |v: &Value| {
        v.as_f64()
            .map_or("—".to_owned(), |v| format!("{:.0}%", v * 100.0))
    };
    if result["prism"].is_object() {
        let p = &result["prism"];
        out.push_str(&format!(
            "\n\nPrism (mania-tracker, not Etterna): {}{}",
            number(&p["overall"]),
            if p["ln"].is_null() {
                String::new()
            } else {
                format!(" · LN {}", number(&p["ln"]))
            }
        ));
    }
    if let Some(clusters) = result["patterns"]["clusters"].as_array() {
        let names: Vec<String> = clusters
            .iter()
            .take(3)
            .map(|c| format!("{} BPM {}", number(&c["bpm"]), text(&c["pattern"])))
            .collect();
        out.push_str(&format!(
            "\nInterlude patterns: {}{}",
            text(&result["patterns"]["category"]),
            if names.is_empty() {
                String::new()
            } else {
                format!(" ({}, chart BPM)", names.join(", "))
            }
        ));
    }
    if let Some(categories) = result["view7k"]["categories"].as_array() {
        let rows = categories
            .iter()
            .map(|c| {
                vec![
                    text(&c["label"]),
                    pct(&c["coverage"]),
                    c["main_bpm"].as_u64().map_or("—".into(), |b| b.to_string()),
                    c["msd"].as_f64().map_or("—".into(), |v| format!("{v:.1}")),
                ]
            })
            .collect::<Vec<_>>();
        out.push_str(&format!(
            "\n\n7K skills, pattern analysis (ours)\n{}",
            table(&["Category", "Coverage", "Main BPM", "MinaCalc"], &rows)
        ));
    }
    if result["dan7k"].is_object() {
        let d = &result["dan7k"];
        out.push_str(&format!(
            "\n7K Regular dan (ours, Jinjin courses): {} ({} ± {})",
            text(&d["label"]),
            d["value"]
                .as_f64()
                .map_or("—".into(), |v| format!("{v:.1}")),
            number(&d["uncertainty"])
        ));
    } else if let Some(why) = result["unrated"]["dan7k"]["reason"]
        .as_str()
        .filter(|_| result["keys"] == 7)
    {
        out.push_str(&format!("\n7K Regular dan (ours): — ({why})"));
    }
    if result["ln"].is_object() {
        let l = &result["ln"];
        out.push_str(&format!(
            "\nLN (ours): {} holds · coverage {} · {}/s releases (peak {}) · inverse {} · off-row releases {}{}",
            pct(&l["ln_share"]),
            pct(&l["coverage"]),
            l["releases_per_second"].as_f64().map_or("—".into(), |v| format!("{v:.1}")),
            number(&l["peak_releases_per_second"]),
            pct(&l["inverse_share"]),
            pct(&l["offbeat_release_share"]),
            l["indicators"]
                .as_array()
                .filter(|a| !a.is_empty())
                .map_or(String::new(), |a| format!(" · {}", a.iter().map(text).collect::<Vec<_>>().join(", ")))
        ));
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments() {
        assert_eq!(
            Args::try_parse_from(["difficulty", "-", "--rate", "0.85"])
                .unwrap()
                .file
                .as_deref(),
            Some("-")
        );
        for args in [
            vec!["difficulty", "--rate", "0.4"],
            vec!["difficulty", "--score", "1.01"],
            vec!["difficulty", "--rate", "NaN"],
        ] {
            assert!(Args::try_parse_from(args).is_err());
        }
        assert!(Args::try_parse_from(["difficulty", "--rates", "--json"]).is_ok());
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;
    #[test]
    fn terminal_tables_round_values_and_explain_missing_dan() {
        let value =
            serde_json::json!({"msd":{"overall":12.345678},"ssr":{"overall":11.123456},"dan":null});
        let output = human(&value, "chart.osu — 4K · 100 notes · 0.85×");
        assert!(output.contains("chart.osu"));
        assert!(output.contains("12.35") && output.contains("11.12"));
        assert!(output.contains("dan: — (no estimate"));
        assert!(!output.contains("12.345678"));
        let output = human(
            &serde_json::json!({"rates":[{"rate":0.7,"msd":{"overall":6.721776}}]}),
            "Rate table",
        );
        assert!(output.contains("0.70×") && output.contains("6.72"));
        assert!(!output.contains("rates["));
        let seven = human(
            &serde_json::json!({"keys":7,"msd":{"overall":31.0,"jumpstream":30.0},"ssr":null}),
            "7K",
        );
        assert!(seven.contains("chordstream") && seven.contains("bracketing"));
        assert!(!seven.contains("jumpstream") && !seven.contains("handstream"));
    }
}
