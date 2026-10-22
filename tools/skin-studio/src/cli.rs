//! `vosux skin-studio …`: a thin client of this tool's own service.

use clap::{Parser, Subcommand};
use reqwest::Method;
use serde_json::{Value, json};
use vosu_tool_sdk::{
    ToolEnv,
    cli::{print_result, table, text},
    send_json,
};

#[derive(Parser)]
#[command(about = "Browse skins and build stable skin folders or lazer .osk files")]
struct Args {
    #[command(subcommand)]
    command: Command,
    /// Print JSON instead of a table
    #[arg(long, global = true)]
    json: bool,
}
#[derive(Subcommand)]
enum Command {
    /// List stable, added and lazer skins
    List,
    /// Copy one whole skin into a new stable skin or a lazer .osk
    Export {
        /// Skin name (case-insensitive) or library key
        skin: String,
        /// Output name; defaults to the source skin's name
        #[arg(long)]
        name: Option<String>,
        /// Create a stable skin folder instead of an .osk
        #[arg(long)]
        stable: bool,
        /// Replace an existing skin or .osk of the same name
        #[arg(long)]
        overwrite: bool,
    },
    /// Build from a plan JSON file saved by the studio (see the tool README)
    Build {
        plan: std::path::PathBuf,
        /// Override the plan's target: `stable` or `osk`
        #[arg(long)]
        target: Option<String>,
        #[arg(long)]
        overwrite: bool,
    },
}

pub async fn run(
    env: &ToolEnv,
    args: impl Iterator<Item = String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse_from(std::iter::once("vosux skin-studio".to_owned()).chain(args));
    let client = env.client();
    let value: Value = match args.command {
        Command::List => client.own_json("v1/library").await?,
        Command::Export {
            skin,
            name,
            stable,
            overwrite,
        } => {
            let library: Value = client.own_json("v1/library").await?;
            let skins = library["skins"].as_array().cloned().unwrap_or_default();
            let matches: Vec<&Value> = skins
                .iter()
                .filter(|s| {
                    s["available"] == true
                        && (s["key"] == skin.as_str()
                            || s["name"]
                                .as_str()
                                .is_some_and(|n| n.eq_ignore_ascii_case(&skin)))
                })
                .collect();
            let [found] = matches[..] else {
                return Err(format!(
                    "{} skins match {skin:?}; use the key from `list --json`.",
                    matches.len()
                )
                .into());
            };
            let key = found["key"].as_str().unwrap_or_default().to_owned();
            let snapshot: Value = send_json(
                client
                    .own(Method::GET, "v1/skin")
                    .query(&[("skin", key.as_str())]),
            )
            .await?;
            let files: Vec<Value> = snapshot["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f["name"].as_str())
                .filter(|n| !n.eq_ignore_ascii_case("skin.ini"))
                .map(|n| json!(n))
                .collect();
            let plan = json!({
                "name": name.unwrap_or_else(|| found["name"].as_str().unwrap_or("Skin").to_owned()),
                "target": if stable { "stable" } else { "osk" },
                "overwrite": overwrite,
                "ini": snapshot["text"],
                "sources": [{"skin": key, "files": files}],
            });
            send_json(client.own(Method::POST, "v1/build").json(&plan)).await?
        }
        Command::Build {
            plan,
            target,
            overwrite,
        } => {
            let mut plan: Value = serde_json::from_slice(&std::fs::read(plan)?)?;
            if let Some(target) = target {
                plan["target"] = json!(target);
            }
            if overwrite {
                plan["overwrite"] = json!(true);
            }
            send_json(client.own(Method::POST, "v1/build").json(&plan)).await?
        }
    };
    print_result(&value, args.json, || {
        if let Some(skins) = value["skins"].as_array() {
            let rows = skins
                .iter()
                .map(|s| {
                    vec![
                        text(&s["name"]),
                        text(&s["origin"]),
                        if s["current"] == true { "current" } else { "" }.to_owned(),
                        if s["available"] == true {
                            ""
                        } else {
                            "unavailable"
                        }
                        .to_owned(),
                    ]
                })
                .collect::<Vec<_>>();
            let mut out = table(&["Skin", "Source", "", ""], &rows);
            if let Some(error) = value["lazer"]["error"].as_str() {
                out.push_str(&format!("\nLazer skins: {error}"));
            }
            out
        } else {
            format!(
                "{} {} ({} files){}",
                if value["replaced"] == true {
                    "Replaced"
                } else {
                    "Created"
                },
                text(&value["path"]),
                value["files"],
                if value["opened"] == true {
                    "; opened for import"
                } else {
                    ""
                }
            )
        }
    })?;
    Ok(())
}
