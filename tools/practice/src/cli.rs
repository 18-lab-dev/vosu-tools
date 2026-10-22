use clap::{Parser, Subcommand};
use serde_json::Value;
use vosu_tool_sdk::{
    ToolEnv,
    cli::{CliError, Method, Progress, print_result, range, table, text},
    send_json,
};
#[derive(Parser, Debug)]
#[command(
    name = "vosux practice",
    about = "Generate practice copies of the selected beatmap",
    after_help = osu_file::mods::GAMEPLAY_ONLY,
    args_conflicts_with_subcommands = true
)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long, conflicts_with="bpm", value_parser=rate)]
    rate: Option<f64>,
    #[arg(long, value_parser=bpm)]
    bpm: Option<f64>,
    #[arg(long, conflicts_with = "no_pitch")]
    pitch: bool,
    #[arg(long)]
    no_pitch: bool,
    #[arg(long,value_parser=stat)]
    hp: Option<f64>,
    #[arg(long,value_parser=stat)]
    cs: Option<f64>,
    #[arg(long,value_parser=stat)]
    ar: Option<f64>,
    #[arg(long,value_parser=stat)]
    od: Option<f64>,
    #[arg(long)]
    lock_ar: bool,
    #[arg(long)]
    lock_od: bool,
    /// Comma-separated mods: IN,HO,MR,RD,SW,CS,DA,HT,DC,DT,NC. Ruleset restrictions apply.
    #[arg(long, value_delimiter = ',')]
    mods: Vec<String>,
    /// Seed for lazer-compatible osu!, mania and taiko Random.
    #[arg(long, default_value_t = 0, allow_hyphen_values = true)]
    seed: i32,
    /// osu! Mirror axis.
    #[arg(long, default_value="horizontal", value_parser=["horizontal","vertical","both"])]
    mirror: String,
    /// osu! Random angle sharpness (1–10, default 7).
    #[arg(long, default_value_t = 7.0)]
    angle_sharpness: f32,
    /// Keep only this part of the map, as START-END in seconds or m:ss
    /// (e.g. 1:05-1:40). Repeat for several sections.
    #[arg(long = "trim", value_parser = trim_range)]
    trims: Vec<osu_file::trim::Range>,
    /// Lead-in before each section's first object, ms (default: tool setting).
    #[arg(long, value_parser = padding)]
    lead_in: Option<f64>,
    /// Time kept after each section's last object, ms (default: tool setting).
    #[arg(long, value_parser = padding)]
    lead_out: Option<f64>,
    /// Silence between sections, ms (default: tool setting).
    #[arg(long, value_parser = padding)]
    gap: Option<f64>,
    /// Audio fade at section edges, ms; 0 cuts hard (default: tool setting).
    #[arg(long, value_parser = padding)]
    fade: Option<f64>,
    #[arg(long, global = true)]
    json: bool,
}
#[derive(Subcommand, Debug)]
enum Command {
    List,
    Delete { id: String },
}
fn rate(s: &str) -> Result<f64, String> {
    range(s, 0.5, 2.)
}
fn stat(s: &str) -> Result<f64, String> {
    range(s, 0., 10.)
}
fn bpm(s: &str) -> Result<f64, String> {
    let n = range(s, f64::MIN_POSITIVE, f64::MAX)?;
    Ok(n)
}
fn padding(s: &str) -> Result<f64, String> {
    range(s, 0., 30_000.)
}
fn seconds(s: &str) -> Result<f64, String> {
    let value = match s.split_once(':') {
        Some((m, rest)) => {
            let m: f64 = m.parse().map_err(|_| format!("invalid time {s}"))?;
            let rest: f64 = rest.parse().map_err(|_| format!("invalid time {s}"))?;
            m * 60.0 + rest
        }
        None => s.parse().map_err(|_| format!("invalid time {s}"))?,
    };
    if !value.is_finite() || value < 0.0 {
        return Err(format!("invalid time {s}"));
    }
    Ok(value * 1000.0)
}
fn trim_range(s: &str) -> Result<osu_file::trim::Range, String> {
    let (start, end) = s
        .split_once('-')
        .ok_or_else(|| format!("expected START-END, got {s}"))?;
    let range = osu_file::trim::Range {
        start_ms: seconds(start.trim())?,
        end_ms: seconds(end.trim())?,
    };
    if range.end_ms <= range.start_ms {
        return Err(format!("{s} ends before it starts"));
    }
    Ok(range)
}
pub async fn run() -> anyhow::Result<()> {
    let args = Args::parse_from(
        std::iter::once("vosux practice".to_owned()).chain(std::env::args().skip(2)),
    );
    let client = ToolEnv::from_env()?.client();
    let result: Value = match args.command {
        Some(Command::List) => client.own_json("v1/generated").await?,
        Some(Command::Delete { id }) => {
            send_json(client.own(Method::POST, &format!("v1/delete/{id}"))).await?
        }
        None => {
            // Unset padding follows the tool's dashboard settings.
            let defaults: crate::map::Options = serde_json::from_value(
                client.own_json::<Value>("v1/profiles").await?["defaults"].clone(),
            )?;
            let options = crate::map::Options {
                rate: args.rate.unwrap_or(1.),
                target_bpm: args.bpm,
                pitch_preserving: !args.pitch,
                hp: args.hp,
                cs: args.cs,
                ar: args.ar,
                od: args.od,
                lock_ar: args.lock_ar,
                lock_od: args.lock_od,
                mods: args.mods.iter().map(|m| m.to_uppercase()).collect(),
                seed: args.seed,
                mirror: args.mirror,
                angle_sharpness: args.angle_sharpness,
                trims: args.trims,
                lead_in_ms: args.lead_in.unwrap_or(defaults.lead_in_ms),
                lead_out_ms: args.lead_out.unwrap_or(defaults.lead_out_ms),
                gap_ms: args.gap.unwrap_or(defaults.gap_ms),
                fade_ms: args.fade.unwrap_or(defaults.fade_ms),
            };
            let job: Value =
                send_json(client.own(Method::POST, "v1/generate").json(&options)).await?;
            let id = job["job"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing job id"))?;
            let label = match args.bpm {
                Some(bpm) => format!("generating at {bpm:.2} BPM"),
                None => format!("generating {:.2}×", options.rate),
            };
            let mut progress = Progress::new(label);
            let job = client
                .wait_job("practice", id, |job| progress.update(job))
                .await;
            drop(progress);
            let job = match job {
                Ok(job) => job,
                Err(e) => {
                    eprintln!("vosux practice: {e}");
                    std::process::exit(e.exit_code());
                }
            };
            if let Some(warnings) = job["result"]["warnings"].as_array() {
                for warning in warnings {
                    if !args.json {
                        println!("Warning: {}", text(warning));
                    }
                }
            }
            if !args.json {
                println!(
                    "{}",
                    created_path(&job["result"]).ok_or_else(|| CliError::Failed(
                        "service returned no practice file".into()
                    ))?
                );
                return Ok(());
            }
            job["result"].clone()
        }
    };
    print_result(&result, args.json, || human(&result))?;
    Ok(())
}
fn created_path(result: &Value) -> Option<&str> {
    result["files"]
        .as_array()?
        .iter()
        .filter_map(|f| f["path"].as_str())
        .find(|p| p.ends_with(".osu") || p.ends_with(".osz"))
}

fn human(result: &Value) -> String {
    if let Some(id) = result["deleted"].as_str() {
        return format!("Deleted {id}");
    }
    let rows = result["maps"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            vec![
                text(&entry["id"]),
                text(&entry["name"]),
                created_path(entry).unwrap_or("—").to_owned(),
            ]
        })
        .collect::<Vec<_>>();
    table(&["ID", "Practice copy", "Path"], &rows)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments() {
        for a in [
            vec!["practice", "--rate", "1", "--bpm", "120"],
            vec!["practice", "--rate", "2.1"],
            vec!["practice", "--hp", "11"],
            vec!["practice", "--bpm", "0"],
            vec!["practice", "--pitch", "--no-pitch"],
        ] {
            assert!(Args::try_parse_from(a).is_err());
        }
        assert!(Args::try_parse_from(["practice", "--rate", "0.85", "--json"]).is_ok());
        assert!(Args::try_parse_from(["practice", "list", "--json"]).is_ok());
    }
    #[test]
    fn output() {
        assert_eq!(
            created_path(
                &serde_json::json!({"files":[{"path":"audio.ogg"},{"path":"practice.osu"}]})
            ),
            Some("practice.osu")
        );
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;
    #[test]
    fn list_and_delete_are_concise() {
        let output = human(
            &serde_json::json!({"maps":[{"id":"abc","name":"Practice","files":[{"path":"/Songs/practice.osu"}]}]}),
        );
        assert!(output.contains("Practice copy") && output.contains("/Songs/practice.osu"));
        assert!(!output.contains("maps["));
        assert_eq!(human(&serde_json::json!({"deleted":"abc"})), "Deleted abc");
    }
}
