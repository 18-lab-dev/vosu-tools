//! `vosux skin-studio …`: a thin client of this tool's own service.

use clap::{Parser, Subcommand};
use reqwest::Method;
use serde_json::{Value, json};
use std::{io::Write, path::PathBuf};
use vosu_tool_sdk::{
    ToolEnv,
    cli::{print_result, table, text},
    send_json,
};

#[derive(Parser)]
#[command(about = "Browse skins; build stable skin folders or save .osk files")]
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
    /// Copy one whole skin into an .osk file (or a new stable skin)
    Export {
        /// Skin name (case-insensitive) or library key
        skin: String,
        /// Output name; defaults to the source skin's name
        #[arg(long)]
        name: Option<String>,
        /// Create a stable skin folder instead of an .osk
        #[arg(long, conflicts_with = "out")]
        stable: bool,
        /// .osk path; defaults to `<name>.osk` in the current folder
        #[arg(long)]
        out: Option<PathBuf>,
        /// Replace an existing skin or file of the same name
        #[arg(long)]
        overwrite: bool,
    },
    /// Build a plan JSON saved by the studio ("Download plan") as a stable skin
    Build {
        plan: PathBuf,
        /// Save an .osk at this path instead of creating a stable skin
        #[arg(long)]
        osk: Option<PathBuf>,
        #[arg(long)]
        overwrite: bool,
    },
}

/// Saves a plan as an .osk through the service's streamed export.
async fn save_osk(
    client: &vosu_tool_sdk::Client,
    plan: &Value,
    out: Option<PathBuf>,
    overwrite: bool,
) -> Result<Value, Box<dyn std::error::Error>> {
    let export: Value = send_json(client.own(Method::POST, "v1/exports").json(plan)).await?;
    let path = out.unwrap_or_else(|| PathBuf::from(text(&export["filename"])));
    let replaced = path.exists();
    if replaced && !overwrite {
        return Err(format!("{} exists; pass --overwrite to replace it.", path.display()).into());
    }
    let mut response = client
        .own(Method::GET, export["url"].as_str().unwrap_or_default())
        .send()
        .await?
        .error_for_status()?;
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let mut temp = tempfile::Builder::new()
        .prefix(".skin-studio-")
        .suffix(".osk")
        .tempfile_in(&dir)?;
    let mut bytes = 0u64;
    while let Some(chunk) = response.chunk().await? {
        temp.write_all(&chunk)?;
        bytes += chunk.len() as u64;
    }
    temp.as_file().sync_all()?;
    if overwrite {
        temp.persist(&path)?;
    } else {
        temp.persist_noclobber(&path)?;
    }
    Ok(json!({ "path": path.to_string_lossy(), "bytes": bytes, "replaced": replaced }))
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
            out,
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
                "overwrite": overwrite,
                "ini": snapshot["text"],
                "sources": [{"skin": key, "files": files}],
            });
            if stable {
                send_json(client.own(Method::POST, "v1/build").json(&plan)).await?
            } else {
                save_osk(&client, &plan, out, overwrite).await?
            }
        }
        Command::Build {
            plan,
            osk,
            overwrite,
        } => {
            let mut plan: Value = serde_json::from_slice(&std::fs::read(plan)?)?;
            if overwrite {
                plan["overwrite"] = json!(true);
            }
            match osk {
                Some(path) => save_osk(&client, &plan, Some(path), overwrite).await?,
                None => send_json(client.own(Method::POST, "v1/build").json(&plan)).await?,
            }
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
        } else if let Some(bytes) = value["bytes"].as_u64() {
            format!(
                "{} {} ({bytes} bytes)",
                if value["replaced"] == true {
                    "Replaced"
                } else {
                    "Saved"
                },
                text(&value["path"])
            )
        } else {
            format!(
                "{} {} ({} files)",
                if value["replaced"] == true {
                    "Replaced"
                } else {
                    "Created"
                },
                text(&value["path"]),
                value["files"]
            )
        }
    })?;
    Ok(())
}
