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
mod budget;
mod cdp;
mod encoder;
mod gpu;
mod library;
mod output;
mod overlays;
mod preview;
mod render;
mod share;
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
    /// The studio's live overlay preview, if one runs.
    preview: Arc<Mutex<Option<preview::Preview>>>,
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
    /// Render one or more replays (up to 16) to MP4
    Render {
        #[arg(required = true, num_args = 1..=16)]
        files: Vec<PathBuf>,
        /// How several replays share the frame; `overlap` draws osu! replays of
        /// one map on a single playfield
        #[arg(long, default_value = "auto", value_parser = ["auto", "side-by-side", "stacked", "grid", "overlap"])]
        layout: String,
        /// Overlap: the player (1 = the first file) whose state overlays follow
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..=8))]
        focus: u32,
        /// Overlap: judgements drawn, each in its player's colour
        #[arg(long, default_value = "misses", value_parser = ["misses", "all", "none"])]
        judgements: String,
        /// Overlap: no name tags beside the cursors
        #[arg(long)]
        no_names: bool,
        /// Overlap: draw the focus player's health bar
        #[arg(long)]
        health: bool,
        /// Skin folder under osu!/Skins, or `imported/<name>`; default: current skin
        #[arg(long)]
        skin: Option<String>,
        #[arg(long="set", value_parser=parse_setting)]
        settings: Vec<(String, f64)>,
        #[arg(long, value_parser = clap::value_parser!(u8).range(0..=100))]
        volume_master: Option<u8>,
        #[arg(long, value_parser = clap::value_parser!(u8).range(0..=100))]
        volume_music: Option<u8>,
        #[arg(long, value_parser = clap::value_parser!(u8).range(0..=100))]
        volume_hitsounds: Option<u8>,
        #[arg(long)]
        no_hitsounds: bool,
        #[arg(long)]
        no_fallback_samples: bool,
        /// Defaults to the replay's name in the output folder setting (or Videos)
        #[arg(long)]
        out: Option<PathBuf>,
        /// Defaults to the tool's fps setting
        #[arg(long)]
        fps: Option<u32>,
        /// WIDTHxHEIGHT, e.g. 2560x1440 or 1080x1920; defaults to the tool's setting
        #[arg(long)]
        resolution: Option<String>,
        /// Overlay folder (with index.html) or single .html page; repeatable
        #[arg(long = "overlay")]
        overlays: Vec<PathBuf>,
        /// Where the MP4 is going: x, discord or youtube (sized, rated and
        /// encoded for its upload limits); defaults to the tool's setting
        #[arg(long = "for", value_parser = ["standard", "x", "discord", "youtube"])]
        export_for: Option<String>,
        /// Discord's size limit in MB: 20 (free), 50 (Nitro Basic) or 1000 (Nitro)
        #[arg(long, value_parser = ["20", "50", "1000"])]
        discord_mb: Option<String>,
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
/// Presets saved by older versions may name settings that no longer exist
/// (the player header, judgement counter and key overlay) or hold values outside
/// a setting's current range; both are dropped, so the tool default applies.
fn migrate_presets(mut presets: BTreeMap<String, Preset>) -> BTreeMap<String, Preset> {
    for preset in presets.values_mut() {
        preset
            .settings
            .retain(|key, value| parse_setting(&format!("{key}={value}")).is_ok());
    }
    presets
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
        Ok(bytes) => migrate_presets(serde_json::from_slice(&bytes)?),
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
        preview: Arc::default(),
    };
    let router = Router::new()
        .route("/v1/context", get(context))
        .route("/v1/replays", get(library::list).post(upload))
        .route("/v1/replays/{id}", get(replay_file))
        .route("/v1/sizes", get(output::get_sizes).post(output::save_size))
        .route("/v1/sizes/last", post(output::set_last))
        .route("/v1/sizes/layout", post(output::set_layout))
        .route("/v1/sizes/export", post(output::set_export))
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
        .route("/v1/preview", post(preview::start))
        .route("/v1/preview/{id}/state", post(preview::state))
        .route("/v1/preview/{id}", axum::routing::delete(preview::stop))
        .route("/v1/render/plan", get(share::plan))
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
            files,
            layout,
            focus,
            judgements,
            no_names,
            health,
            skin,
            mut settings,
            volume_master,
            volume_music,
            volume_hitsounds,
            no_hitsounds,
            no_fallback_samples,
            out,
            fps,
            resolution,
            overlays,
            export_for,
            discord_mb,
            json: as_json,
        } => {
            for (key, volume) in [
                ("audio.master", volume_master),
                ("audio.music", volume_music),
                ("audio.hitsounds", volume_hitsounds),
            ] {
                if let Some(value) = volume {
                    settings.push((key.to_owned(), f64::from(value)));
                }
            }
            if no_hitsounds {
                settings.push(("audio.mute".to_owned(), 1.0));
            }
            if no_fallback_samples {
                settings.push(("audio.fallback".to_owned(), 0.0));
            }
            let defaults: Value = client.own_json("v1/context").await?;
            let defaults = &defaults["defaults"];
            let out = match out {
                Some(out) if out.is_absolute() => out,
                Some(out) => std::env::current_dir()?.join(out),
                None => PathBuf::from(format!(
                    "{}.mp4",
                    files[0]
                        .file_stem()
                        .ok_or("Replay needs a file name")?
                        .to_string_lossy()
                )),
            };
            let settings = settings.into_iter().collect::<BTreeMap<_, _>>();
            let mut replays = Vec::with_capacity(files.len());
            for (index, file) in files.iter().enumerate() {
                let bytes = tokio::fs::read(file).await?;
                let imported: Value =
                    vosu_tool_sdk::send_json(client.own(Method::POST, "v1/replays").body(bytes))
                        .await?;
                let mut settings = settings.clone();
                // Overlap hears the focus player's hitsounds only, unless `--set audio.mute=…` or `--no-hitsounds`.
                if layout == "overlap" && !settings.contains_key("audio.mute") {
                    let muted = index + 1 != focus as usize;
                    settings.insert("audio.mute".into(), f64::from(u8::from(muted)));
                }
                replays.push(json!({"id": imported["id"], "skin": skin, "settings": settings}));
            }
            let overlap = json!({
                "focus": focus - 1,
                "judgements": judgements,
                "names": !no_names,
                "health": health,
            });
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
            let started:Value=vosu_tool_sdk::send_json(client.own(Method::POST,"v1/render").json(&json!({"replays":replays,"overlays":overlays,"out":out,"fps":fps,"resolution":resolution,"layout":layout,"overlap":overlap,"export_for":export_for,"discord_mb":discord_mb.map(|mb| mb.parse::<u32>().unwrap_or(20))}))).await?;
            let id = started["job"].as_str().ok_or("Missing job id")?;
            let mut warned = String::new();
            // The worker count and why, printed once as soon as it is known.
            if !as_json && let Some(workers) = started["workers"].as_str() {
                eprintln!("{workers}");
            }
            let result = client
                .wait_job("replay-renderer", id, |state| {
                    if as_json {
                        return;
                    }
                    if let Some(warning) = state["warning"].as_str().filter(|w| *w != warned) {
                        eprintln!("warning: {warning}");
                        warned = warning.to_owned();
                    }
                    eprintln!("{}", state["message"].as_str().unwrap_or("Rendering"));
                })
                .await?;
            // A warning first raised by the last frames reaches only the result.
            if let Some(warning) = result["result"]["warning"]
                .as_str()
                .filter(|w| !as_json && *w != warned)
            {
                eprintln!("warning: {warning}");
            }
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
    context["default_settings"] = json!(
        RENDER_SETTINGS
            .iter()
            .filter_map(|rule| {
                let value = settings[&rule.key].as_f64().or_else(|| {
                    settings[&rule.key]
                        .as_str()
                        .and_then(|s| s.parse::<f64>().ok())
                })?;
                (value.is_finite() && (rule.min..=rule.max).contains(&value))
                    .then(|| (rule.key.clone(), value))
            })
            .collect::<BTreeMap<_, _>>()
    );
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
    // A custom browser may be full Chrome, whose captures leave out WebGPU
    // canvases: the studio warns about overlays that draw with WebGPU.
    value["custom_browser"] =
        json!(std::env::var_os("VOSU_RENDER_CHROMIUM").is_some_and(|path| !path.is_empty()));
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
/// A file inside a skin folder, matched as the clients match skin files:
/// ignoring case. osu! skins mix `Skin.ini`, `Mania-Key1.png`, …, while the
/// renderer asks in lower case; on case-sensitive file systems an exact-only
/// lookup would silently drop the skin's configuration and images.
fn skin_file(root: &FsPath, relative: &str) -> Result<PathBuf, Error> {
    if let Ok(path) = confined(root, relative) {
        return Ok(path);
    }
    let root = root.canonicalize().map_err(error)?;
    let mut current = root.clone();
    for part in FsPath::new(relative).components() {
        let std::path::Component::Normal(name) = part else {
            return Err(error("Invalid relative asset path"));
        };
        let wanted = name.to_string_lossy().to_lowercase();
        current = std::fs::read_dir(&current)
            .map_err(error)?
            .flatten()
            .find(|entry| entry.file_name().to_string_lossy().to_lowercase() == wanted)
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({"error":format!("{relative} is not in this asset folder")})),
                )
            })?
            .path();
    }
    let path = current.canonicalize().map_err(error)?;
    if !path.starts_with(&root) {
        return Err(error("Asset escapes its root"));
    }
    Ok(path)
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
    if kind == "skin" {
        let file = query
            .get("path")
            .ok_or_else(|| error("Missing skin asset path"))?;
        return skin_asset(&app, query.get("skin").map(String::as_str), file).await;
    }
    let map = library::find_map(
        &app,
        query.get("hash").ok_or_else(|| error("Missing map hash"))?,
    )
    .await?;
    let path = if kind == "map" {
        map.osu().to_path_buf()
    } else {
        map.asset(
            query
                .get("path")
                .ok_or_else(|| error("Missing asset path"))?,
        )?
    };
    if kind == "music" {
        let rate = query
            .get("rate")
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(1.0);
        if !(0.5..=2.0).contains(&rate) {
            return Err(error("Invalid audio rate"));
        }
        let pitch = query.get("pitch").is_some_and(|s| s == "1");
        let filter = if pitch {
            format!(
                "aresample=48000,asetrate={},aresample=48000",
                (48000.0 * rate).round()
            )
        } else {
            format!("atempo={rate},aresample=48000")
        };
        let settings: Value = app.env.client().settings().await.map_err(error)?;
        let result = tokio::process::Command::new(output::ffmpeg(&settings))
            .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args([
                "-vn",
                "-af",
                &filter,
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "pipe:1",
            ])
            .kill_on_drop(true)
            .output()
            .await
            .map_err(error)?;
        if !result.status.success() {
            return Err(error(String::from_utf8_lossy(&result.stderr)));
        }
        return Ok(result.stdout.into());
    }
    Ok(tokio::fs::read(path).await.map_err(error)?.into())
}
/// One file of a preset's skin (`""` or `None` the client's current skin).
async fn skin_asset(app: &App, skin: Option<&str>, file: &str) -> Result<Bytes, Error> {
    let root = match skin.filter(|s| !s.is_empty()) {
        Some(name) if name.starts_with(skins::IMPORTED) => confined(
            &skins::imported_root(app),
            skins::valid_name(&name[skins::IMPORTED.len()..])?,
        )?,
        Some(name) if name.starts_with(skins::LAZER) => {
            return library::lazer_skin_file(app, &name[skins::LAZER.len()..], file).await;
        }
        Some(name) if name.starts_with(skins::BUILTIN) => {
            return Err(error("Built-in skins are drawn, not read from files"));
        }
        Some(name) => {
            let ctx = host_context(app).await?;
            let osu = ctx["osu_dir"]
                .as_str()
                .ok_or_else(|| error("No stable installation selected"))?;
            confined(&FsPath::new(osu).join("Skins"), name)?
        }
        None => {
            let ctx = host_context(app).await?;
            return skins::current_file(app, &ctx, file).await;
        }
    };
    Ok(tokio::fs::read(skin_file(&root, file)?)
        .await
        .map_err(error)?
        .into())
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
            preview: Arc::default(),
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
    fn skin_files_match_ignoring_case_and_stay_inside_the_skin() {
        let root = std::env::temp_dir().join(format!("rr-skin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("Skin/Mania")).unwrap();
        std::fs::write(root.join("Skin/Skin.ini"), "[General]").unwrap();
        std::fs::write(root.join("Skin/Mania/Key1@2x.PNG"), "k").unwrap();
        std::fs::write(root.join("outside.ini"), "no").unwrap();
        let skin = root.join("Skin");
        let canonical = skin.canonicalize().unwrap();
        assert_eq!(
            skin_file(&skin, "skin.ini").unwrap(),
            canonical.join("Skin.ini")
        );
        assert_eq!(
            skin_file(&skin, "mania/key1@2x.png").unwrap(),
            canonical.join("Mania/Key1@2x.PNG")
        );
        assert!(skin_file(&skin, "missing.png").is_err());
        assert!(skin_file(&skin, "../outside.ini").is_err());
        assert!(skin_file(&skin, "../OUTSIDE.INI").is_err());
        std::fs::remove_dir_all(root).unwrap();
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
    #[test]
    fn presets_from_older_versions_drop_removed_settings() {
        let presets: BTreeMap<String, Preset> = serde_json::from_value(json!({
            "sxlvia": {"skin": "imported/Arturia", "settings": {
                "mania.scroll_speed": 27, "hud.player": 0, "hud.judgements": 1,
                "key_overlay": 0, "hud.combo": 0, "playfield.x": 9, "playfield.scale": 1.5
            }}
        }))
        .unwrap();
        let migrated = migrate_presets(presets);
        let preset = &migrated["sxlvia"];
        assert_eq!(preset.skin.as_deref(), Some("imported/Arturia"));
        assert_eq!(
            preset.settings,
            BTreeMap::from([
                ("hud.combo".to_owned(), 0.0),
                ("mania.scroll_speed".to_owned(), 27.0),
                ("playfield.scale".to_owned(), 1.5),
            ])
        );
        assert!(parse_setting("hud.score.dx=20.5").is_ok());
        assert!(parse_setting("hud.score.x=0.5").is_err());
        assert!(parse_setting("key_overlay=1").is_err());
    }
}
