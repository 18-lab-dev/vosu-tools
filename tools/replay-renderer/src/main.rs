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

mod browser;
mod cdp;
mod library;
mod output;
mod overlays;
mod render;
mod skins;
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
    uploads: Arc<Mutex<BTreeMap<String, skins::Upload>>>,
    lazer_maps: Arc<Mutex<BTreeMap<String, library::MapFiles>>>,
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
        /// Skin folder under osu!/Skins, or `imported/<name>`; default: current skin
        #[arg(long)]
        skin: Option<String>,
        #[arg(long="set", value_parser=parse_setting)]
        settings: Vec<(String, f64)>,
        /// Defaults to the replay's name in the output folder setting (or Videos)
        #[arg(long)]
        out: Option<PathBuf>,
        /// Defaults to the tool's fps setting
        #[arg(long)]
        fps: Option<u32>,
        /// WIDTHxHEIGHT, e.g. 2560x1440 or 1080x1920; defaults to the tool's setting
        #[arg(long)]
        resolution: Option<String>,
        #[arg(long = "overlay")]
        overlays: Vec<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    Presets {
        #[command(subcommand)]
        command: Presets,
    },
    /// Import, list and delete `.osk` skins stored by this tool
    Skins {
        #[command(subcommand)]
        command: Skins,
    },
}
#[derive(Subcommand)]
enum Skins {
    List {
        #[arg(long)]
        json: bool,
    },
    Import {
        file: PathBuf,
        /// Defaults to the archive's file name without `.osk`
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Delete {
        name: String,
        #[arg(long)]
        json: bool,
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
#[derive(Deserialize)]
struct RenderSetting {
    key: String,
    min: f64,
    max: f64,
    step: f64,
}
static RENDER_SETTINGS: std::sync::LazyLock<Vec<RenderSetting>> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("../render-settings.json"))
        .expect("embedded render settings are valid")
});
fn parse_setting(input: &str) -> Result<(String, f64), String> {
    let (key, value) = input.split_once('=').ok_or("Expected KEY=NUMBER")?;
    let rule = RENDER_SETTINGS
        .iter()
        .find(|rule| rule.key == key)
        .ok_or_else(|| format!("Unknown render setting {key}; see render-settings.json"))?;
    let value: f64 = value
        .parse()
        .map_err(|_| "Expected numeric setting (toggles use 0 or 1)")?;
    if !value.is_finite()
        || value < rule.min
        || value > rule.max
        || (rule.step == 1.0 && value.fract() != 0.0)
    {
        return Err(format!(
            "{key} must be {}..{}{}",
            rule.min,
            rule.max,
            if rule.step == 1.0 { " (integer)" } else { "" }
        ));
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
    skins::reset_uploads(&env).await?;
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
        uploads: Arc::default(),
        lazer_maps: Arc::default(),
    };
    let router = Router::new()
        .route("/v1/context", get(context))
        .route("/v1/replays", get(library::list).post(upload))
        .route("/v1/replays/{id}", get(replay_file))
        .route("/v1/sizes", get(output::get_sizes).post(output::save_size))
        .route("/v1/sizes/last", post(output::set_last))
        .route("/v1/sizes/overlay", post(output::set_overlay_size))
        .route("/v1/overlays", get(output::installed_overlays))
        .route(
            "/v1/sizes/{name}",
            axum::routing::delete(output::delete_size),
        )
        .route("/v1/assets", get(asset))
        .route("/v1/presets", get(get_presets))
        .route(
            "/v1/presets/{player}",
            post(save_preset).delete(delete_preset),
        )
        .route("/v1/render", post(render::start))
        .route("/v1/skins/uploads", post(skins::start))
        .route("/v1/skins/uploads/{id}", post(skins::part))
        .route("/v1/skins/uploads/{id}/finish", post(skins::finish))
        .route("/v1/skins/{name}", axum::routing::delete(skins::delete))
        .route("/v1/jobs/{id}", get(job).delete(cancel))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(app);
    vosu_tool_sdk::serve(&env, router).await?;
    Ok(())
}
async fn cli(env: &ToolEnv, command: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let client = env.client();
    match command {
        Cli::Skins { command } => match command {
            Skins::List { json: as_json } => {
                let value: Value = client.own_json("v1/context").await?;
                if as_json {
                    println!(
                        "{}",
                        json!({"current":value["current_skin"],"installed":value["skins"],"imported":value["imported_skins"],"lazer":value["lazer_skins"],"builtin":["argon","argon-pro","triangles","legacy"]})
                    );
                } else {
                    let mut rows = vec![vec![
                        String::new(),
                        "current".to_owned(),
                        value["current_skin"]["name"]
                            .as_str()
                            .unwrap_or("unavailable")
                            .to_owned(),
                    ]];
                    for (source, key, prefix) in [
                        ("osu! Skins", "skins", ""),
                        ("imported", "imported_skins", skins::IMPORTED),
                    ] {
                        for name in value[key].as_array().into_iter().flatten() {
                            let name = name.as_str().unwrap_or_default();
                            rows.push(vec![
                                format!("{prefix}{name}"),
                                source.to_owned(),
                                name.to_owned(),
                            ]);
                        }
                    }
                    for skin in value["lazer_skins"].as_array().into_iter().flatten() {
                        rows.push(vec![
                            format!(
                                "{}{}",
                                skins::LAZER,
                                skin["id"].as_str().unwrap_or_default()
                            ),
                            "lazer".to_owned(),
                            skin["name"].as_str().unwrap_or_default().to_owned(),
                        ]);
                    }
                    for (id, name) in [
                        ("argon", "Argon"),
                        ("argon-pro", "Argon Pro"),
                        ("triangles", "Triangles"),
                        ("legacy", "Classic"),
                    ] {
                        rows.push(vec![
                            format!("{}{id}", skins::BUILTIN),
                            "built-in".to_owned(),
                            name.to_owned(),
                        ]);
                    }
                    print!(
                        "{}",
                        vosu_tool_sdk::cli::table(&["--skin VALUE", "SOURCE", "NAME"], &rows)
                    );
                }
            }
            Skins::Import {
                file,
                name,
                json: as_json,
            } => {
                let name = match name {
                    Some(name) => name,
                    None => file
                        .file_stem()
                        .ok_or("Skin archive needs a file name")?
                        .to_string_lossy()
                        .into_owned(),
                };
                let bytes = tokio::fs::read(&file).await?;
                let started: Value = vosu_tool_sdk::send_json(client.own(
                    Method::POST,
                    &format!(
                        "v1/skins/uploads?name={}&size={}",
                        encode(&name),
                        bytes.len()
                    ),
                ))
                .await?;
                let upload = started["upload"].as_str().ok_or("Missing upload id")?;
                let part = started["part_size"].as_u64().unwrap_or(1 << 20) as usize;
                for (index, chunk) in bytes.chunks(part).enumerate() {
                    let _: Value = vosu_tool_sdk::send_json(
                        client
                            .own(
                                Method::POST,
                                &format!("v1/skins/uploads/{upload}?offset={}", index * part),
                            )
                            .body(chunk.to_vec()),
                    )
                    .await?;
                }
                let result: Value = vosu_tool_sdk::send_json(
                    client.own(Method::POST, &format!("v1/skins/uploads/{upload}/finish")),
                )
                .await?;
                if as_json {
                    println!("{result}");
                } else {
                    println!(
                        "Imported {} files as --skin {}{}",
                        result["files"],
                        skins::IMPORTED,
                        result["name"].as_str().unwrap_or(&name)
                    );
                }
            }
            Skins::Delete {
                name,
                json: as_json,
            } => {
                let name = name.strip_prefix(skins::IMPORTED).unwrap_or(&name);
                let result: Value = vosu_tool_sdk::send_json(
                    client.own(Method::DELETE, &format!("v1/skins/{}", encode(name))),
                )
                .await?;
                if as_json {
                    println!("{result}");
                } else {
                    println!("Deleted imported skin {name}");
                }
            }
        },
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
            overlays,
            json: as_json,
        } => {
            let defaults: Value = client.own_json("v1/context").await?;
            let defaults = &defaults["defaults"];
            let out = match out {
                Some(out) if out.is_absolute() => out,
                Some(out) => std::env::current_dir()?.join(out),
                None => PathBuf::from(format!(
                    "{}.mp4",
                    file.file_stem()
                        .ok_or("Replay needs a file name")?
                        .to_string_lossy()
                )),
            };
            let bytes = tokio::fs::read(file).await?;
            let imported: Value =
                vosu_tool_sdk::send_json(client.own(Method::POST, "v1/replays").body(bytes))
                    .await?;
            let fps = fps.unwrap_or(defaults["fps"].as_u64().unwrap_or(60) as u32);
            let resolution = resolution.unwrap_or_else(|| {
                defaults["resolution"]
                    .as_str()
                    .unwrap_or("1920x1080")
                    .into()
            });
            let (width, height) = output::parse_size(&resolution).map_err(|(_, Json(body))| {
                body["error"]
                    .as_str()
                    .unwrap_or("Invalid resolution")
                    .to_owned()
            })?;
            let overlays=overlays.into_iter().map(|folder|json!({"folder":folder,"width":width.min(4096),"height":height.min(4096),"x":0.0,"y":0.0,"scale":1.0,"opacity":1.0})).collect::<Vec<_>>();
            let started:Value=vosu_tool_sdk::send_json(client.own(Method::POST,"v1/render").json(&json!({"replays":[{"id":imported["id"],"skin":skin,"settings":settings.into_iter().collect::<BTreeMap<_,_>>()}],"overlays":overlays,"out":out,"fps":fps,"resolution":resolution,"layout":"side-by-side"}))).await?;
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
    // lazer reports its hashed file store as songs_dir; it is not a Songs folder.
    let lazer = context["client"] == "lazer";
    context["lazer_files_dir"] = if lazer {
        context["songs_dir"].clone()
    } else {
        Value::Null
    };
    if lazer {
        context["songs_dir"] = Value::Null;
    }
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
    context["stable_songs_dir"] = context["songs_dir"].clone();
    context["default_settings"] = json!({"mania.scroll_speed":settings["mania.scroll_speed"].as_f64().or_else(||settings["mania.scroll_speed"].as_str().and_then(|s|s.parse::<f64>().ok())).unwrap_or(20.0)});
    context["defaults"] = output::defaults(&settings);
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
    value["imported_skins"] = json!(skins::imported_names(&app));
    // "loading" covers a library still reading lazer's database: the studio asks again.
    value["lazer_library"] = json!(match library::lazer(&app).await {
        library::Lazer::Ready { .. } => "ready",
        library::Lazer::NoData(_) => "loading",
        library::Lazer::Missing => "missing",
    });
    value["lazer_skins"] = json!(library::lazer_skins(&app).await);
    value["current_skin"] = skins::current(&app, &value).await.describe();
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
    let path = match query.get("source") {
        Some(source) => {
            return library::read(&app, source, &id, query.get("md5").map(String::as_str)).await;
        }
        None => {
            uuid::Uuid::parse_str(&id).map_err(error)?;
            app.env.cache_dir.join("replays").join(id)
        }
    };
    Ok(tokio::fs::read(path).await.map_err(error)?.into())
}
async fn asset(
    State(app): State<App>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Bytes, Error> {
    let kind = query.get("kind").map(String::as_str).unwrap_or("map");
    let path = if kind == "skin" {
        let file = query
            .get("path")
            .ok_or_else(|| error("Missing skin asset path"))?;
        let root = match query.get("skin").filter(|s| !s.is_empty()) {
            Some(name) if name.starts_with(skins::IMPORTED) => confined(
                &skins::imported_root(&app),
                skins::valid_name(&name[skins::IMPORTED.len()..])?,
            )?,
            Some(name) if name.starts_with(skins::LAZER) => {
                return library::lazer_skin_file(&app, &name[skins::LAZER.len()..], file).await;
            }
            Some(name) if name.starts_with(skins::BUILTIN) => {
                return Err(error("Built-in skins are drawn, not read from files"));
            }
            Some(name) => {
                let ctx = host_context(&app).await?;
                let osu = ctx["osu_dir"]
                    .as_str()
                    .ok_or_else(|| error("No stable installation selected"))?;
                confined(&FsPath::new(osu).join("Skins"), name)?
            }
            None => {
                let ctx = host_context(&app).await?;
                return skins::current_file(&app, &ctx, file).await;
            }
        };
        confined(&root, file)?
    } else {
        let map = library::find_map(
            &app,
            query.get("hash").ok_or_else(|| error("Missing map hash"))?,
        )
        .await?;
        if kind == "map" {
            map.osu().to_path_buf()
        } else {
            map.asset(
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
            uploads: Arc::default(),
            lazer_maps: Arc::default(),
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
