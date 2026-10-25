//! Output frame sizes, saved size presets, and where videos and FFmpeg live.
use super::*;

/// Longest side and pixel budget accepted for one output frame (8K UHD).
const MAX_SIDE: u32 = 7680;
const MAX_PIXELS: u64 = 7680 * 4320;
const MAX_SAVED: usize = 32;

/// Parses `WIDTHxHEIGHT` and checks the encoder limits: even sides of
/// 64–7680 px within the 7680×4320 pixel budget, landscape or portrait.
pub(super) fn parse_size(text: &str) -> Result<(u32, u32), Error> {
    let (width, height) = text
        .split_once(['x', 'X', '×'])
        .ok_or_else(|| error("Resolution must be WIDTHxHEIGHT"))?;
    let width: u32 = width
        .trim()
        .parse()
        .map_err(|_| error("Width must be a whole number"))?;
    let height: u32 = height
        .trim()
        .parse()
        .map_err(|_| error("Height must be a whole number"))?;
    check_size(width, height)?;
    Ok((width, height))
}

pub(super) fn check_size(width: u32, height: u32) -> Result<(), Error> {
    if !(64..=MAX_SIDE).contains(&width)
        || !(64..=MAX_SIDE).contains(&height)
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(error(
            "Each side must be 64–7680 px and the frame at most 7680×4320 pixels",
        ));
    }
    if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return Err(error("Video width and height must be even"));
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub(super) struct Sizes {
    #[serde(default)]
    saved: Vec<Saved>,
    /// Last size picked in the studio, `WIDTHxHEIGHT`.
    #[serde(default)]
    last: Option<String>,
    /// Page size last used per installed overlay id.
    #[serde(default)]
    overlays: BTreeMap<String, PageSize>,
    /// Layout chosen in the studio; absent means `auto`.
    #[serde(default)]
    layout: Option<String>,
    /// "Export for" chosen in the studio; absent: the tool settings.
    #[serde(default)]
    export: Option<ExportChoice>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct ExportChoice {
    export_for: String,
    discord_mb: u32,
}
/// Remembers the studio's "Export for" choice.
pub(super) async fn set_export(
    State(app): State<App>,
    Json(input): Json<ExportChoice>,
) -> Result<Json<Sizes>, Error> {
    crate::share::Target::parse(&input.export_for, input.discord_mb).map_err(error)?;
    let _guard = SIZES_LOCK.lock().await;
    let mut sizes = load(&app).await?;
    sizes.export = Some(input);
    store(&app, &sizes).await?;
    Ok(Json(sizes))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct PageSize {
    width: u32,
    height: u32,
}
const MAX_OVERLAYS: usize = 512;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct Saved {
    name: String,
    width: u32,
    height: u32,
}

static SIZES_LOCK: Mutex<()> = Mutex::const_new(());

async fn load(app: &App) -> Result<Sizes, Error> {
    match tokio::fs::read(app.env.data_dir.join("sizes.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(error),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Sizes::default()),
        Err(e) => Err(error(e)),
    }
}
async fn store(app: &App, sizes: &Sizes) -> Result<(), Error> {
    let path = app.env.data_dir.join("sizes.json");
    let temporary = path.with_extension("json.new");
    tokio::fs::write(&temporary, serde_json::to_vec_pretty(sizes).map_err(error)?)
        .await
        .map_err(error)?;
    tokio::fs::rename(temporary, path).await.map_err(error)
}

pub(super) async fn get_sizes(State(app): State<App>) -> Result<Json<Sizes>, Error> {
    Ok(Json(load(&app).await?))
}

#[derive(Deserialize)]
pub(super) struct SaveSize {
    name: String,
    width: u32,
    height: u32,
}
pub(super) async fn save_size(
    State(app): State<App>,
    Json(input): Json<SaveSize>,
) -> Result<Json<Sizes>, Error> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 48 || name.chars().any(char::is_control) {
        return Err(error("Preset names need 1–48 printable characters"));
    }
    check_size(input.width, input.height)?;
    let _guard = SIZES_LOCK.lock().await;
    let mut sizes = load(&app).await?;
    sizes.saved.retain(|s| s.name != name);
    if sizes.saved.len() >= MAX_SAVED {
        return Err(error("At most 32 saved sizes; delete one first"));
    }
    sizes.saved.push(Saved {
        name: name.to_owned(),
        width: input.width,
        height: input.height,
    });
    store(&app, &sizes).await?;
    Ok(Json(sizes))
}

pub(super) async fn delete_size(
    State(app): State<App>,
    Path(name): Path<String>,
) -> Result<Json<Sizes>, Error> {
    let _guard = SIZES_LOCK.lock().await;
    let mut sizes = load(&app).await?;
    let before = sizes.saved.len();
    sizes.saved.retain(|s| s.name != name);
    if sizes.saved.len() == before {
        return Err(error("No saved size with that name"));
    }
    store(&app, &sizes).await?;
    Ok(Json(sizes))
}

#[derive(Deserialize)]
pub(super) struct LastSize {
    width: u32,
    height: u32,
}
pub(super) async fn set_last(
    State(app): State<App>,
    Json(input): Json<LastSize>,
) -> Result<Json<Sizes>, Error> {
    check_size(input.width, input.height)?;
    let _guard = SIZES_LOCK.lock().await;
    let mut sizes = load(&app).await?;
    sizes.last = Some(format!("{}x{}", input.width, input.height));
    store(&app, &sizes).await?;
    Ok(Json(sizes))
}

/// Layouts the compositor understands; `auto` picks by output aspect.
pub(super) const LAYOUTS: [&str; 4] = ["auto", "side-by-side", "stacked", "grid"];
#[derive(Deserialize)]
pub(super) struct LayoutChoice {
    layout: String,
}
/// Remembers the layout picked in the studio (the default is `auto`).
pub(super) async fn set_layout(
    State(app): State<App>,
    Json(input): Json<LayoutChoice>,
) -> Result<Json<Sizes>, Error> {
    if !LAYOUTS.contains(&input.layout.as_str()) {
        return Err(error("Unknown layout"));
    }
    let _guard = SIZES_LOCK.lock().await;
    let mut sizes = load(&app).await?;
    sizes.layout = (input.layout != "auto").then_some(input.layout);
    store(&app, &sizes).await?;
    Ok(Json(sizes))
}

/// Overlay page size limits, as the render service enforces them.
const PAGE: std::ops::RangeInclusive<u32> = 16..=4096;

#[derive(Deserialize)]
pub(super) struct OverlaySize {
    id: String,
    width: u32,
    height: u32,
}
/// Remembers the page size last used for an installed overlay.
pub(super) async fn set_overlay_size(
    State(app): State<App>,
    Json(input): Json<OverlaySize>,
) -> Result<Json<Sizes>, Error> {
    if input.id.is_empty() || input.id.len() > 512 || input.id.chars().any(char::is_control) {
        return Err(error("Invalid overlay id"));
    }
    if !PAGE.contains(&input.width) || !PAGE.contains(&input.height) {
        return Err(error("Overlay pages must be 16–4096 px"));
    }
    let _guard = SIZES_LOCK.lock().await;
    let mut sizes = load(&app).await?;
    if !sizes.overlays.contains_key(&input.id) && sizes.overlays.len() >= MAX_OVERLAYS {
        return Err(error("Too many remembered overlay sizes"));
    }
    sizes.overlays.insert(
        input.id,
        PageSize {
            width: input.width,
            height: input.height,
        },
    );
    store(&app, &sizes).await?;
    Ok(Json(sizes))
}

/// One installed overlay with its page size: remembered, else from its
/// metadata `Resolution`, else none.
pub(super) fn overlay_entry(entry: &Value, remembered: Option<&PageSize>) -> Option<Value> {
    let id = entry["id"].as_str()?;
    let folder = entry["folder"].as_str()?;
    let metadata = (|| {
        let width = u32::try_from(entry["width"].as_u64()?).ok()?;
        let height = u32::try_from(entry["height"].as_u64()?).ok()?;
        (PAGE.contains(&width) && PAGE.contains(&height)).then_some((width, height))
    })();
    let (width, height) = remembered
        .map(|s| (Some(s.width), Some(s.height)))
        .or(metadata.map(|(w, h)| (Some(w), Some(h))))
        .unwrap_or((None, None));
    Some(json!({
        "id": id,
        "name": entry["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(id),
        "nickname": entry["nickname"].as_str().filter(|s| !s.is_empty()),
        "author": entry["author"],
        "folder": folder,
        "width": width,
        "height": height,
    }))
}

/// `GET /v1/overlays`: installed overlays from vosu (`/tools/_host/v1/overlays`).
/// `available` is false when this vosu has no such route; the studio then
/// offers only a custom folder.
pub(super) async fn installed_overlays(State(app): State<App>) -> Result<Json<Value>, Error> {
    let response = app
        .env
        .client()
        .request(Method::GET, "/tools/_host/v1/overlays")
        .send()
        .await
        .map_err(error)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Json(json!({"available": false, "overlays": []})));
    }
    if !response.status().is_success() {
        return Err(error(format!(
            "vosu answered {} for installed overlays",
            response.status()
        )));
    }
    let listing: Value = response.json().await.map_err(error)?;
    let sizes = load(&app).await?;
    let mut overlays = listing["overlays"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            overlay_entry(
                entry,
                entry["id"].as_str().and_then(|id| sizes.overlays.get(id)),
            )
        })
        .collect::<Vec<_>>();
    overlays.sort_by_key(|o| {
        o["nickname"]
            .as_str()
            .or(o["name"].as_str())
            .unwrap_or("")
            .to_lowercase()
    });
    Ok(Json(json!({"available": true, "overlays": overlays})))
}

fn setting<'a>(settings: &'a Value, key: &str) -> Option<&'a str> {
    settings[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Where videos go: the `output_dir` setting, else the user's Videos folder.
pub(super) fn output_dir(settings: &Value) -> Option<PathBuf> {
    if let Some(dir) = setting(settings, "output_dir") {
        return Some(PathBuf::from(dir));
    }
    if cfg!(windows) {
        return std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("Videos"));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let videos = std::fs::read_to_string(config.join("user-dirs.dirs"))
        .ok()
        .and_then(|dirs| {
            dirs.lines().find_map(|line| {
                let value = line
                    .trim()
                    .strip_prefix("XDG_VIDEOS_DIR=")?
                    .trim_matches('"');
                Some(match value.strip_prefix("$HOME") {
                    Some(rest) => home.join(rest.trim_start_matches('/')),
                    None => PathBuf::from(value),
                })
            })
        });
    Some(videos.unwrap_or_else(|| home.join("Videos")))
}

/// An absolute `.mp4` path stays as is; a bare file name goes into the output folder.
pub(super) fn resolve_out(out: &FsPath, settings: &Value) -> Result<PathBuf, Error> {
    if out
        .extension()
        .is_none_or(|e| !e.eq_ignore_ascii_case("mp4"))
    {
        return Err(error("Output must be an .mp4 file"));
    }
    if out.is_absolute() {
        return Ok(out.to_path_buf());
    }
    let mut parts = out.components();
    if !matches!(
        (parts.next(), parts.next()),
        (Some(std::path::Component::Normal(_)), None)
    ) {
        return Err(error("Give an absolute path or a plain file name"));
    }
    let dir = output_dir(settings)
        .ok_or_else(|| error("No output folder; set one in the tool's settings"))?;
    if !dir.is_absolute() {
        return Err(error("The output folder setting must be an absolute path"));
    }
    Ok(dir.join(out))
}

/// FFmpeg executable: the `ffmpeg_path` setting, `VOSU_RENDER_FFMPEG`, then `ffmpeg` on PATH.
pub(super) fn ffmpeg(settings: &Value) -> String {
    setting(settings, "ffmpeg_path")
        .map(str::to_owned)
        .or_else(|| std::env::var("VOSU_RENDER_FFMPEG").ok())
        .unwrap_or_else(|| "ffmpeg".into())
}

/// Studio defaults editable from the dashboard (settings.json).
pub(super) fn defaults(settings: &Value) -> Value {
    let number = |key: &str| {
        settings[key]
            .as_f64()
            .or_else(|| settings[key].as_str().and_then(|s| s.trim().parse().ok()))
    };
    let fps = number("fps")
        .filter(|f| (1.0..=240.0).contains(f))
        .map_or(60, |f| f.round() as u32);
    let resolution = setting(settings, "resolution")
        .and_then(|r| parse_size(r).ok())
        .map_or_else(|| "1920x1080".to_owned(), |(w, h)| format!("{w}x{h}"));
    let ms = |key: &str, default: u32| {
        number(key)
            .filter(|v| (0.0..=f64::from(MAX_OUTRO_MS)).contains(v))
            .map_or(default, |v| v.round() as u32)
    };
    let outro = ms("outro_ms", 1250);
    json!({
        "fps": fps,
        "resolution": resolution,
        "encoder": setting(settings, "encoder").filter(|value| matches!(*value, "auto" | "hardware" | "software")).unwrap_or("auto"),
        "output_dir": output_dir(settings),
        "outro_ms": outro,
        "fade_ms": ms("fade_ms", 250).min(outro),
        "export_for": setting(settings, "export_for")
            .filter(|value| crate::share::TARGETS.contains(value))
            .unwrap_or("standard"),
        "discord_mb": number("discord_mb")
            .map(|v| v.round() as u32)
            .filter(|v| crate::share::DISCORD_MB.contains(v))
            .unwrap_or(crate::share::DISCORD_MB[0]),
    })
}
/// Longest outro (and fade) a render accepts, milliseconds.
pub(super) const MAX_OUTRO_MS: u32 = 60_000;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sizes_cover_wide_tall_and_reject_bad_input() {
        for ok in [
            "1920x1080",
            "1080x1920",
            "5120x1440",
            "3440X1440",
            "1440×1080",
            "7680x4320",
            "4320x7680",
        ] {
            assert!(parse_size(ok).is_ok(), "{ok}");
        }
        for bad in [
            "1921x1080",
            "62x64",
            "7682x100",
            "7680x7680",
            "abc",
            "1920",
            "-2x4",
        ] {
            assert!(parse_size(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn output_names_resolve_into_the_output_folder() {
        let directory = std::env::temp_dir().join("vosu-render-output");
        let absolute = std::env::temp_dir().join("vosu-absolute-output/x.mp4");
        let settings = json!({"output_dir": directory});
        assert_eq!(
            resolve_out(FsPath::new("take 1.mp4"), &settings).unwrap(),
            directory.join("take 1.mp4")
        );
        assert_eq!(resolve_out(&absolute, &settings).unwrap(), absolute);
        assert!(resolve_out(FsPath::new("../x.mp4"), &settings).is_err());
        assert!(resolve_out(FsPath::new("sub/x.mp4"), &settings).is_err());
        assert!(resolve_out(FsPath::new("x.webm"), &settings).is_err());
        assert!(resolve_out(FsPath::new("x.mp4"), &json!({"output_dir":"relative"})).is_err());
    }
    #[test]
    fn defaults_fall_back_when_settings_are_invalid() {
        let value = defaults(&json!({"fps": 500, "resolution": "123x45", "output_dir": "/v"}));
        assert_eq!(value["fps"], 60);
        assert_eq!(value["resolution"], "1920x1080");
        assert_eq!(value["output_dir"], "/v");
        assert_eq!(value["export_for"], "standard");
        assert_eq!(value["discord_mb"], 20);
        let value = defaults(&json!({"export_for": "x", "discord_mb": "50"}));
        assert_eq!(
            (value["export_for"].as_str(), value["discord_mb"].as_u64()),
            (Some("x"), Some(50))
        );
        assert_eq!(
            defaults(&json!({"export_for": "tiktok", "discord_mb": 10}))["discord_mb"],
            20
        );
        let value = defaults(
            &json!({"fps": "30", "resolution": "2560x1440", "ffmpeg_path": "/opt/ffmpeg"}),
        );
        assert_eq!(value["fps"], 30);
        assert_eq!(value["resolution"], "2560x1440");
        assert_eq!(
            ffmpeg(&json!({"ffmpeg_path": " /opt/ffmpeg "})),
            "/opt/ffmpeg"
        );
    }
}
