use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use clap::{Parser, Subcommand};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;
use vosu_tool_sdk::{ToolEnv, cli::Method};

mod render;
type Error = (StatusCode, Json<Value>);
fn error(message: impl ToString) -> Error {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":message.to_string()})),
    )
}
#[derive(Clone)]
struct App {
    env: ToolEnv,
    presets: Arc<Mutex<BTreeMap<String, Preset>>>,
    maps: Arc<Mutex<BTreeMap<String, PathBuf>>>,
    jobs: Arc<Mutex<BTreeMap<String, Value>>>,
    render_gate: Arc<tokio::sync::Semaphore>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Preset {
    #[serde(default)]
    skin: Option<String>,
    #[serde(default)]
    settings: BTreeMap<String, f64>,
}
#[derive(Parser)]
#[command(about = "Replay renderer — deterministic video studio")]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    Cli {
        #[command(subcommand)]
        command: Cli,
    },
}
#[derive(Subcommand)]
enum Cli {
    Render {
        file: PathBuf,
        #[arg(long)]
        skin: Option<String>,
        #[arg(long="set", value_parser=parse_setting)]
        settings: Vec<(String, f64)>,
        #[arg(long, default_value = "replay.mp4")]
        out: PathBuf,
        #[arg(long, default_value_t = 60)]
        fps: u32,
        #[arg(long, default_value = "1920x1080")]
        resolution: String,
        #[arg(long)]
        json: bool,
    },
    Presets {
        #[command(subcommand)]
        command: Presets,
    },
}
#[derive(Subcommand)]
enum Presets {
    List {
        #[arg(long)]
        json: bool,
    },
    Set {
        player: String,
        #[arg(long)]
        skin: Option<String>,
        #[arg(long="set", value_parser=parse_setting)]
        settings: Vec<(String, f64)>,
        #[arg(long)]
        json: bool,
    },
    Delete {
        player: String,
        #[arg(long)]
        json: bool,
    },
}
fn parse_setting(input: &str) -> Result<(String, f64), String> {
    let (key, value) = input.split_once('=').ok_or("Expected KEY=NUMBER")?;
    if key != "mania.scroll_speed" {
        return Err("Supported setting: mania.scroll_speed".into());
    }
    let value: f64 = value.parse().map_err(|_| "Expected numeric setting")?;
    if !value.is_finite() || !(1.0..=100.0).contains(&value) {
        return Err("Scroll speed must be 1..100".into());
    }
    Ok((key.to_owned(), value))
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match execute().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            if error
                .downcast_ref::<vosu_tool_sdk::cli::CliError>()
                .is_some_and(|e| matches!(e, vosu_tool_sdk::cli::CliError::Cancelled))
            {
                std::process::ExitCode::from(130)
            } else {
                std::process::ExitCode::FAILURE
            }
        }
    }
}
async fn execute() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let env = ToolEnv::from_env()?;
    if let Some(Command::Cli { command }) = args.command {
        return cli(&env, command).await;
    }
    tokio::fs::create_dir_all(&env.data_dir).await?;
    tokio::fs::create_dir_all(env.cache_dir.join("replays")).await?;
    let presets = match tokio::fs::read(env.data_dir.join("presets.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.into()),
    };
    let app = App {
        env: env.clone(),
        presets: Arc::new(Mutex::new(presets)),
        maps: Arc::default(),
        jobs: Arc::default(),
        render_gate: Arc::new(tokio::sync::Semaphore::new(1)),
    };
    let router = Router::new()
        .route("/v1/context", get(context))
        .route("/v1/replays", get(replays).post(upload))
        .route("/v1/replays/{id}", get(replay_file))
        .route("/v1/assets", get(asset))
        .route("/v1/presets", get(get_presets))
        .route(
            "/v1/presets/{player}",
            post(save_preset).delete(delete_preset),
        )
        .route("/v1/render", post(render::start))
        .route("/v1/jobs/{id}", get(job).delete(cancel))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(app);
    vosu_tool_sdk::serve(&env, router).await?;
    Ok(())
}
async fn cli(env: &ToolEnv, command: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let client = env.client();
    match command {
        Cli::Presets { command } => match command {
            Presets::List { json: as_json } => {
                let value: Value = client.own_json("v1/presets").await?;
                if as_json {
                    println!("{value}");
                } else if let Some(values) = value.as_object() {
                    let rows = values
                        .iter()
                        .map(|(player, preset)| {
                            vec![
                                player.clone(),
                                preset["skin"].as_str().unwrap_or("Current skin").to_owned(),
                                preset["settings"].to_string(),
                            ]
                        })
                        .collect::<Vec<_>>();
                    print!(
                        "{}",
                        vosu_tool_sdk::cli::table(&["PLAYER", "SKIN", "SETTINGS"], &rows)
                    );
                }
            }
            Presets::Set {
                player,
                skin,
                settings,
                json: as_json,
            } => {
                let url = format!("v1/presets/{}", encode(&player));
                let result: Value =
                    vosu_tool_sdk::send_json(client.own(Method::POST, &url).json(&Preset {
                        skin,
                        settings: settings.into_iter().collect(),
                    }))
                    .await?;
                if as_json {
                    println!("{result}");
                } else {
                    println!("Preset saved for {player}");
                }
            }
            Presets::Delete {
                player,
                json: as_json,
            } => {
                let result: Value = vosu_tool_sdk::send_json(
                    client.own(Method::DELETE, &format!("v1/presets/{}", encode(&player))),
                )
                .await?;
                if as_json {
                    println!("{result}");
                } else {
                    println!("Preset deleted for {player}");
                }
            }
        },
        Cli::Render {
            file,
            skin,
            settings,
            out,
            fps,
            resolution,
            json: as_json,
        } => {
            let bytes = tokio::fs::read(file).await?;
            let imported: Value =
                vosu_tool_sdk::send_json(client.own(Method::POST, "v1/replays").body(bytes))
                    .await?;
            let out = if out.is_absolute() {
                out
            } else {
                std::env::current_dir()?.join(out)
            };
            let started:Value=vosu_tool_sdk::send_json(client.own(Method::POST,"v1/render").json(&json!({"replays":[{"id":imported["id"],"skin":skin,"settings":settings.into_iter().collect::<BTreeMap<_,_>>()}],"out":out,"fps":fps,"resolution":resolution,"layout":"side-by-side"}))).await?;
            let id = started["job"].as_str().ok_or("Missing job id")?;
            let result = client
                .wait_job("replay-renderer", id, |state| {
                    if !as_json {
                        eprintln!("{}", state["message"].as_str().unwrap_or("Rendering"));
                    }
                })
                .await?;
            if as_json {
                println!("{result}");
            } else {
                println!(
                    "{}",
                    result["result"]["out"]
                        .as_str()
                        .unwrap_or("Render complete")
                );
            }
        }
    }
    Ok(())
}
fn encode(input: &str) -> String {
    input
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
async fn host_context(app: &App) -> Result<Value, Error> {
    let client = app.env.client();
    let mut context: Value = client.host("context").await.map_err(error)?;
    let settings: Value = client.settings().await.map_err(error)?;
    if let Some(osu) = settings["osu_dir"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        let root = FsPath::new(osu).canonicalize().map_err(error)?;
        context["osu_dir"] = json!(root);
        context["songs_dir"] = json!(root.join("Songs"));
        context["skin"] = Value::Null;
    }
    if let Some(songs) = settings["songs_dir"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        context["songs_dir"] = json!(FsPath::new(songs).canonicalize().map_err(error)?);
    }
    if context["skin"]["folder"].is_null()
        && let (Some(osu), Some(skin)) = (
            context["osu_dir"].as_str(),
            settings["skin"].as_str().filter(|s| !s.is_empty()),
        )
    {
        let folder = confined(&FsPath::new(osu).join("Skins"), skin)?;
        context["skin"] = json!({"name":skin,"folder":folder});
    }
    context["default_settings"] = json!({"mania.scroll_speed":settings["mania.scroll_speed"].as_f64().or_else(||settings["mania.scroll_speed"].as_str().and_then(|s|s.parse::<f64>().ok())).unwrap_or(20.0)});
    Ok(context)
}
async fn context(State(app): State<App>) -> Result<Json<Value>, Error> {
    let mut value = host_context(&app).await?;
    let mut skins = Vec::new();
    if let Some(osu) = value["osu_dir"].as_str()
        && let Ok(entries) = std::fs::read_dir(FsPath::new(osu).join("Skins"))
    {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                skins.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    skins.sort();
    value["skins"] = json!(skins);
    Ok(Json(value))
}
async fn get_presets(State(app): State<App>) -> Json<Value> {
    Json(json!(*app.presets.lock().await))
}
async fn persist(app: &App, presets: &BTreeMap<String, Preset>) -> Result<(), Error> {
    let path = app.env.data_dir.join("presets.json");
    let temporary = path.with_extension("json.new");
    tokio::fs::write(
        &temporary,
        serde_json::to_vec_pretty(presets).map_err(error)?,
    )
    .await
    .map_err(error)?;
    tokio::fs::rename(temporary, path).await.map_err(error)
}
async fn save_preset(
    State(app): State<App>,
    Path(player): Path<String>,
    Json(preset): Json<Preset>,
) -> Result<Json<Value>, Error> {
    if player.trim().is_empty() || player.len() > 256 {
        return Err(error("Invalid player name"));
    }
    for (key, value) in &preset.settings {
        parse_setting(&format!("{key}={value}")).map_err(error)?;
    }
    let mut presets = app.presets.lock().await;
    let mut next = presets.clone();
    next.insert(player, preset);
    persist(&app, &next).await?;
    *presets = next;
    Ok(Json(json!({"saved":true})))
}
async fn delete_preset(
    State(app): State<App>,
    Path(player): Path<String>,
) -> Result<Json<Value>, Error> {
    let mut presets = app.presets.lock().await;
    let mut next = presets.clone();
    next.remove(&player);
    persist(&app, &next).await?;
    *presets = next;
    Ok(Json(json!({"deleted":true})))
}
async fn upload(State(app): State<App>, body: Bytes) -> Result<Json<Value>, Error> {
    if body.len() < 32 || body[0] > 3 {
        return Err(error("Invalid .osr replay"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    tokio::fs::write(app.env.cache_dir.join("replays").join(&id), body)
        .await
        .map_err(error)?;
    Ok(Json(json!({"id":id})))
}
async fn replays(State(app): State<App>) -> Result<Json<Value>, Error> {
    let ctx = host_context(&app).await?;
    let osu = ctx["osu_dir"]
        .as_str()
        .ok_or_else(|| error("Select a stable installation in vosu"))?;
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(FsPath::new(osu).join("Replays")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "osr") {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names.sort();
    Ok(Json(json!(names)))
}
fn confined(root: &FsPath, relative: &str) -> Result<PathBuf, Error> {
    let relative = FsPath::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(error("Invalid relative asset path"));
    }
    let root = root.canonicalize().map_err(error)?;
    let path = root.join(relative).canonicalize().map_err(error)?;
    if !path.starts_with(&root) {
        return Err(error("Asset escapes its root"));
    }
    Ok(path)
}
async fn replay_file(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Bytes, Error> {
    let path = if query.contains_key("installed") {
        let ctx = host_context(&app).await?;
        let osu = ctx["osu_dir"]
            .as_str()
            .ok_or_else(|| error("No stable installation selected"))?;
        confined(&FsPath::new(osu).join("Replays"), &id)?
    } else {
        uuid::Uuid::parse_str(&id).map_err(error)?;
        app.env.cache_dir.join("replays").join(id)
    };
    Ok(tokio::fs::read(path).await.map_err(error)?.into())
}
async fn map_path(app: &App, hash: &str) -> Result<PathBuf, Error> {
    if hash.len() != 32 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(error("Invalid beatmap checksum"));
    }
    let mut maps = app.maps.lock().await;
    let ctx = host_context(app).await?;
    let songs = ctx["songs_dir"]
        .as_str()
        .ok_or_else(|| error("Select a stable installation in vosu"))?
        .to_owned();
    let cache = app
        .env
        .cache_dir
        .join(format!("maps-{:x}.json", Md5::digest(songs.as_bytes())));
    if maps.is_empty()
        && let Ok(bytes) = tokio::fs::read(&cache).await
        && let Ok(cached) = serde_json::from_slice::<BTreeMap<String, PathBuf>>(&bytes)
    {
        maps.extend(cached);
    }
    if let Some(path) = maps.get(hash).filter(|p| p.starts_with(&songs))
        && let Ok(bytes) = tokio::fs::read(path).await
        && format!("{:x}", Md5::digest(bytes)) == hash
    {
        return Ok(path.clone());
    }
    let found = tokio::task::spawn_blocking(move || {
        let mut result = BTreeMap::new();
        for entry in walkdir::WalkDir::new(songs)
            .max_depth(3)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file()
                && entry.path().extension().is_some_and(|s| s == "osu")
                && let Ok(bytes) = std::fs::read(entry.path())
            {
                result.insert(format!("{:x}", Md5::digest(bytes)), entry.into_path());
            }
        }
        result
    })
    .await
    .map_err(error)?;
    *maps = found;
    let temporary = cache.with_extension("json.new");
    tokio::fs::write(&temporary, serde_json::to_vec(&*maps).map_err(error)?)
        .await
        .map_err(error)?;
    tokio::fs::rename(temporary, cache).await.map_err(error)?;
    maps.get(hash)
        .cloned()
        .ok_or_else(|| error("Replay beatmap is not installed (checksum must match)"))
}
async fn asset(
    State(app): State<App>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Bytes, Error> {
    let kind = query.get("kind").map(String::as_str).unwrap_or("map");
    let path = if kind == "skin" {
        let ctx = host_context(&app).await?;
        let root = if let Some(name) = query.get("skin").filter(|s| !s.is_empty()) {
            let osu = ctx["osu_dir"]
                .as_str()
                .ok_or_else(|| error("No stable installation selected"))?;
            confined(&FsPath::new(osu).join("Skins"), name)?
        } else {
            PathBuf::from(
                ctx["skin"]["folder"]
                    .as_str()
                    .ok_or_else(|| error("Current skin folder is unavailable"))?,
            )
        };
        confined(
            &root,
            query
                .get("path")
                .ok_or_else(|| error("Missing skin asset path"))?,
        )?
    } else {
        let map = map_path(
            &app,
            query.get("hash").ok_or_else(|| error("Missing map hash"))?,
        )
        .await?;
        if kind == "map" {
            map
        } else {
            confined(
                map.parent().ok_or_else(|| error("Map has no folder"))?,
                query
                    .get("path")
                    .ok_or_else(|| error("Missing asset path"))?,
            )?
        }
    };
    Ok(tokio::fs::read(path).await.map_err(error)?.into())
}
async fn job(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    app.jobs
        .lock()
        .await
        .get(&id)
        .cloned()
        .map(Json)
        .ok_or_else(|| error("Unknown job"))
}
async fn cancel(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    let mut jobs = app.jobs.lock().await;
    let job = jobs.get_mut(&id).ok_or_else(|| error("Unknown job"))?;
    if job["state"] == "queued" || job["state"] == "running" {
        job["state"] = json!("cancelled");
    }
    Ok(Json(job.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_app(root: PathBuf) -> App {
        App {
            env: ToolEnv {
                id: "replay-renderer".into(),
                token: "test-only".into(),
                vosu_url: "http://127.0.0.1:1".into(),
                data_dir: root.clone(),
                cache_dir: root,
                interface: vosu_tool_sdk::Interface::Service,
            },
            presets: Arc::default(),
            maps: Arc::default(),
            jobs: Arc::default(),
            render_gate: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
    #[tokio::test]
    async fn player_presets_survive_reload_and_delete() {
        let root = std::env::temp_dir().join(format!("vosu-replay-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let app = test_app(root.clone());
        let preset = Preset {
            skin: Some("example".into()),
            settings: BTreeMap::from([("mania.scroll_speed".into(), 27.0)]),
        };
        let _ = save_preset(
            State(app.clone()),
            Path("Player / Unicode 演奏".into()),
            Json(preset),
        )
        .await
        .unwrap();
        let stored: BTreeMap<String, Preset> =
            serde_json::from_slice(&tokio::fs::read(root.join("presets.json")).await.unwrap())
                .unwrap();
        assert_eq!(
            stored["Player / Unicode 演奏"].settings["mania.scroll_speed"],
            27.0
        );
        let _ = delete_preset(State(app), Path("Player / Unicode 演奏".into()))
            .await
            .unwrap();
        let stored: BTreeMap<String, Preset> =
            serde_json::from_slice(&tokio::fs::read(root.join("presets.json")).await.unwrap())
                .unwrap();
        assert!(stored.is_empty());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
    #[test]
    fn paths_cannot_escape_asset_roots() {
        let root = std::env::temp_dir();
        assert!(confined(&root, "../etc/passwd").is_err());
        assert!(confined(&root, "/etc/passwd").is_err());
    }
    #[test]
    fn setting_validation_rejects_unknown_and_nonfinite_values() {
        assert!(parse_setting("mania.scroll_speed=27").is_ok());
        assert!(parse_setting("mania.scroll_speed=NaN").is_err());
        assert!(parse_setting("mania.scroll_speed=0").is_err());
        assert!(parse_setting("unknown=10").is_err());
    }
}
