use clap::{Parser, Subcommand};
use notify::{RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use vosu_lazer_library::{Index, Library, Shared, Status};
use vosu_tool_sdk::{
    ToolEnv,
    cli::{print_result, table},
};
#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    /// Query the running library service through vosu.
    Cli {
        #[arg(long, global = true)]
        json: bool,
        #[command(subcommand)]
        query: Option<Query>,
    },
}
#[derive(Subcommand)]
enum Query {
    Status,
    Beatmap { md5: String },
    OnlineIds,
    Skins,
    SkinFiles { id: String },
    Scores { md5: String },
}
fn encoded(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let env = ToolEnv::from_env()?;
    if let Some(Command::Cli { json, query }) = args.command {
        let route = match query.unwrap_or(Query::Status) {
            Query::Status => "/v1/status".into(),
            Query::Beatmap { md5 } => format!("/v1/beatmaps/by-md5/{}", encoded(&md5)),
            Query::OnlineIds => "/v1/beatmapsets/online-ids".into(),
            Query::Skins => "/v1/skins".into(),
            Query::SkinFiles { id } => format!("/v1/skins/{}/files", encoded(&id)),
            Query::Scores { md5 } => format!("/v1/scores/by-beatmap/{}", encoded(&md5)),
        };
        let value: Value = env.client().own_json(&route).await?;
        print_result(&value, json, || {
            if let Some(skins) = value["skins"].as_array() {
                table(
                    &["ID", "NAME", "CREATOR", "FILES"],
                    &skins
                        .iter()
                        .map(|v| {
                            vec![
                                v["id"].as_str().unwrap_or_default().into(),
                                v["name"].as_str().unwrap_or_default().into(),
                                v["creator"].as_str().unwrap_or_default().into(),
                                v["files"].to_string(),
                            ]
                        })
                        .collect::<Vec<_>>(),
                )
            } else {
                serde_json::to_string_pretty(&value).unwrap_or_default()
            }
        })?;
        return Ok(());
    }
    let state: Shared = Arc::new(RwLock::new(Library::default()));
    let client = env.client();
    let service_state = state.clone();
    tokio::spawn(async move {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event
                    && !matches!(event.kind, notify::EventKind::Access(_))
                    && event.paths.iter().any(|p| {
                        p.file_name()
                            .is_some_and(|n| n == "client.realm" || n == "storage.ini")
                    })
                {
                    let _ = tx.try_send(());
                }
            })
            .ok();
        let mut selected = None::<PathBuf>;
        let mut last_signature = None;
        let mut pending = None::<Instant>;
        let mut next_context = Instant::now();
        let mut next_retry = Instant::now();
        loop {
            if Instant::now() >= next_context {
                next_context = Instant::now() + Duration::from_secs(2);
                let context = client.context().await.ok();
                let settings = client.settings::<Value>().await.unwrap_or(Value::Null);
                let from_context = context
                    .as_ref()
                    .filter(|c| c.client.as_deref() == Some("lazer"))
                    .and_then(|c| c.songs_dir.as_deref())
                    .and_then(|p| p.parent());
                let configured = settings["lazer_data_dir"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from);
                #[cfg(target_os = "windows")]
                let default =
                    PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("osu");
                #[cfg(not(target_os = "windows"))]
                let default = std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                            .join(".local/share")
                    })
                    .join("osu");
                let dir = realm_reader::data_dir(from_context, configured.as_deref(), &default);
                if selected.as_ref() != Some(&dir) {
                    if let (Some(w), Some(old)) = (watcher.as_mut(), selected.as_ref()) {
                        let _ = w.unwatch(old);
                    }
                    if let Some(w) = watcher.as_mut() {
                        let _ = w.watch(&dir, RecursiveMode::NonRecursive);
                    }
                    selected = Some(dir);
                    last_signature = None;
                    pending = Some(Instant::now() - Duration::from_secs(1));
                    let mut s = service_state.write().unwrap();
                    s.index = None;
                    s.status = Status {
                        data_dir: selected.clone(),
                        ..Status::default()
                    };
                }
            }
            while rx.try_recv().is_ok() {
                pending = Some(Instant::now());
            }
            // Header polling also catches mmap commits without inotify/mtime changes.
            if let Some(dir) = selected.as_ref() {
                let signature = realm_reader::revision(&dir.join("client.realm")).ok();
                if signature != last_signature {
                    last_signature = signature;
                    pending = Some(Instant::now());
                }
            }
            if pending.is_some_and(|t| t.elapsed() >= Duration::from_millis(350))
                || (Instant::now() >= next_retry && service_state.read().unwrap().index.is_none())
            {
                pending = None;
                next_retry = Instant::now() + Duration::from_secs(30);
                if let Some(dir) = selected.clone() {
                    let result = tokio::task::spawn_blocking(move || Index::load(&dir)).await;
                    let mut s = service_state.write().unwrap();
                    match result {
                        Ok(Ok(index)) => {
                            s.status.available = true;
                            s.status.realm_schema = Some(index.schema);
                            s.status.missing_properties = index.missing_properties.clone();
                            s.status.refreshed_at = Some(chrono::Utc::now().to_rfc3339());
                            s.status.error = None;
                            s.index = Some(Arc::new(index));
                        }
                        Ok(Err(error)) => {
                            s.status.available = false;
                            s.status.realm_schema = error.schema;
                            s.status.missing_properties = error.missing_properties;
                            s.status.error = Some(error.message);
                            s.index = None;
                        }
                        Err(error) => {
                            s.status.available = false;
                            s.status.realm_schema = None;
                            s.status.missing_properties.clear();
                            s.status.error = Some(error.to_string());
                            s.index = None;
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    vosu_tool_sdk::serve(&env, vosu_lazer_library::router(state)).await?;
    Ok(())
}
