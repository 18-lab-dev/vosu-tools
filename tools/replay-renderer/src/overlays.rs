use super::*;
use axum::{
    body::Body,
    extract::{
        WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::{IntoResponse, Response},
};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::sync::watch;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Overlay {
    /// An overlay folder containing `index.html`, or one `.html`/`.htm` file
    /// whose folder is served alongside it.
    pub folder: PathBuf,
    /// Page served first, relative to the (resolved) folder.
    #[serde(skip, default = "index")]
    pub entry: String,
    pub width: u32,
    pub height: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    /// Tracks (by index) that show this overlay, each in its own cell at
    /// `x`/`y` from the cell's corner; absent: every track.
    #[serde(default)]
    pub tracks: Option<Vec<usize>>,
}
impl Overlay {
    pub fn shows(&self, track: usize) -> bool {
        self.tracks
            .as_ref()
            .is_none_or(|tracks| tracks.contains(&track))
    }
}
/// Overlay pages one render may run (overlays × tracks showing them).
const MAX_PAGES: usize = 32;
fn one() -> f64 {
    1.0
}
fn index() -> String {
    "index.html".to_owned()
}
#[derive(Serialize)]
pub struct Image {
    pub png: String,
    pub x: f64,
    pub y: f64,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub opacity: f64,
}
struct Native {
    bytes: Arc<[u8]>,
    files: crate::library::MapFiles,
    pp: rosu_pp::GradualPerformance,
    passed: u32,
    current_pp: f64,
    max_combo: u32,
    rating: Option<Value>,
    timelines: BTreeMap<String, Value>,
}
/// The mods an overlay's pp rating uses.
pub struct RatingMods {
    pub rate: f64,
    pub legacy: u32,
    pub acronyms: Option<String>,
    pub overrides: DifficultyOverrides,
}
impl RatingMods {
    /// The mods as rosu-pp takes them: lazer's acronyms, else the legacy bits.
    fn game_mods(&self) -> rosu_pp::model::mods::GameMods {
        match &self.acronyms {
            Some(acronyms) => {
                rosu_pp::model::mods::rosu_mods::GameModsIntermode::from_acronyms(acronyms).into()
            }
            None => self.legacy.into(),
        }
    }

    /// rosu-pp's difficulty for these mods: lazer's acronyms carry Classic (no
    /// slider head accuracy) and the rest of its mod list, the legacy bits are
    /// all osu!stable has; Difficulty Adjust values replace the map's.
    pub fn difficulty(&self, lazer: bool) -> rosu_pp::Difficulty {
        let mut difficulty = rosu_pp::Difficulty::new()
            .clock_rate(self.rate)
            .lazer(lazer)
            .mods(self.game_mods());
        let o = self.overrides;
        if let Some(ar) = o.ar {
            difficulty = difficulty.ar(ar, true);
        }
        if let Some(cs) = o.cs {
            difficulty = difficulty.cs(cs, true);
        }
        if let Some(od) = o.od {
            difficulty = difficulty.od(od, true);
        }
        if let Some(hp) = o.hp {
            difficulty = difficulty.hp(hp, true);
        }
        difficulty
    }
}
/// Difficulty Adjust values that replace the map's (never adjusted by other mods).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct DifficultyOverrides {
    pub ar: Option<f32>,
    pub cs: Option<f32>,
    pub od: Option<f32>,
    pub hp: Option<f32>,
}
pub struct Overlays {
    pub layers: Vec<Overlay>,
    source: watch::Sender<Value>,
    native: Mutex<Option<Native>>,
    driver: Mutex<Option<crate::cdp::Driver>>,
    debug: Mutex<Option<String>>,
    origin: Mutex<String>,
    sequence: AtomicU64,
}
impl Overlays {
    pub fn new(layers: Vec<Overlay>) -> Arc<Self> {
        let (source, _) = watch::channel(
            json!({"state":{"number":2,"name":"Playing"},"__render":{"sequence":0}}),
        );
        Arc::new(Self {
            layers,
            source,
            native: Mutex::new(None),
            driver: Mutex::new(None),
            debug: Mutex::new(None),
            origin: Mutex::new(String::new()),
            sequence: AtomicU64::new(0),
        })
    }
    pub fn validate(layers: &mut [Overlay], tracks: usize) -> Result<(), Error> {
        if layers.len() > 8 {
            return Err(error("At most eight overlays per render"));
        }
        let pages: usize = layers
            .iter()
            .map(|layer| (0..tracks).filter(|&t| layer.shows(t)).count())
            .sum();
        if pages > MAX_PAGES {
            return Err(error(format!(
                "At most {MAX_PAGES} overlay pages per render (overlays × players)"
            )));
        }
        if layers
            .iter()
            .any(|layer| layer.tracks.iter().flatten().any(|&t| t >= tracks))
        {
            return Err(error("Overlay names a track the render does not have"));
        }
        for layer in layers {
            if !(16..=4096).contains(&layer.width)
                || !(16..=4096).contains(&layer.height)
                || ![layer.x, layer.y, layer.scale, layer.opacity]
                    .iter()
                    .all(|v| v.is_finite())
                || !(0.05..=8.0).contains(&layer.scale)
                || !(0.0..=1.0).contains(&layer.opacity)
            {
                return Err(error("Invalid overlay viewport or transform"));
            }
            let path = layer.folder.canonicalize().map_err(error)?;
            let page = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
            if path.is_file() && page {
                layer.entry = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| error("Overlay page needs a UTF-8 name"))?
                    .to_owned();
                layer.folder = path
                    .parent()
                    .ok_or_else(|| error("Overlay page has no folder"))?
                    .to_owned();
            } else {
                layer.folder = path;
                layer.entry = index();
            }
            confined(&layer.folder, &layer.entry)?;
        }
        Ok(())
    }
    pub async fn origin(&self, origin: String) {
        *self.origin.lock().await = origin;
    }
    pub async fn debug(&self, url: String) {
        *self.debug.lock().await = Some(url);
    }
    pub async fn configure(
        &self,
        files: crate::library::MapFiles,
        bytes: Vec<u8>,
        mods: RatingMods,
        initial: Value,
    ) -> Result<(), Error> {
        let mut map = rosu_pp::Beatmap::from_bytes(&bytes).map_err(error)?;
        // osu! maps are rated converted to the replay's ruleset (key mods choose mania's layout).
        let mode = match initial["play"]["mode"]["number"].as_u64() {
            Some(1) => rosu_pp::model::mode::GameMode::Taiko,
            Some(2) => rosu_pp::model::mode::GameMode::Catch,
            Some(3) => rosu_pp::model::mode::GameMode::Mania,
            _ => rosu_pp::model::mode::GameMode::Osu,
        };
        map.convert_mut(mode, &mods.game_mods()).map_err(error)?;
        // osu!stable scores are rated as stable rates them; lazer's need its tick counts (see `frame`).
        let difficulty = mods.difficulty(initial["__render"]["client"] != "stable");
        *self.native.lock().await = Some(Native {
            bytes: bytes.into(),
            files,
            pp: rosu_pp::GradualPerformance::checked_new(difficulty, &map).map_err(error)?,
            passed: 0,
            current_pp: 0.0,
            max_combo: 0,
            rating: None,
            timelines: BTreeMap::new(),
        });
        self.source.send_replace(initial);
        Ok(())
    }
    pub async fn frame(&self, mut state: Value) -> Result<Vec<Image>, Error> {
        if self.layers.is_empty() {
            return Ok(Vec::new());
        }
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        state["__render"]["sequence"] = json!(sequence);
        let wall = state["__render"]["wallMs"]
            .as_f64()
            .ok_or_else(|| error("Frame has no render clock"))?;
        let epoch = state["__render"]["epochMs"].as_f64().unwrap_or(0.0);
        if state["__render"]["verified"] == true
            && (state["play"]["mode"]["number"] == 3 || state["play"]["combo"]["current"].is_u64())
        {
            let counts = &state["__render"]["counts"];
            let count =
                |key: &str| counts[key].as_u64().unwrap_or(0).min(u64::from(u32::MAX)) as u32;
            let mut score = rosu_pp::any::ScoreState::new();
            score.n_geki = count("geki");
            score.n_katu = count("katu");
            score.n300 = count("n300");
            score.n100 = count("n100");
            score.n50 = count("n50");
            score.misses = count("miss");
            if state["play"]["mode"]["number"] == 0 {
                // lazer's slider ticks/repeats and tails, as the simulation judged them.
                let statistics = &state["__render"]["statistics"];
                let stat = |key: &str| {
                    statistics[key]
                        .as_u64()
                        .unwrap_or(0)
                        .min(u64::from(u32::MAX)) as u32
                };
                score.osu_large_tick_hits = stat("large_tick_hit");
                score.osu_small_tick_hits = stat("small_tick_hit");
                score.slider_end_hits = stat("slider_tail_hit");
            }
            score.max_combo = state["play"]["combo"]["current"]
                .as_u64()
                .unwrap_or(0)
                .min(u64::from(u32::MAX)) as u32;
            let passed =
                score.n_geki + score.n_katu + score.n300 + score.n100 + score.n50 + score.misses;
            let mut native = self.native.lock().await;
            let native = native
                .as_mut()
                .ok_or_else(|| error("Overlay score map is not configured"))?;
            native.max_combo = native.max_combo.max(score.max_combo);
            score.max_combo = native.max_combo;
            if passed < native.passed {
                return Err(error("Overlay judgement clock moved backwards"));
            }
            if passed > native.passed {
                if let Some(pp) = native.pp.nth(score, (passed - native.passed - 1) as usize) {
                    native.current_pp = pp.pp();
                }
                native.passed = passed;
            }
            state["play"]["pp"]["current"] = json!(native.current_pp);
        }
        self.source.send_replace(state);
        let mut driver = self.driver.lock().await;
        if driver.is_none() {
            let url = tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    if let Some(url) = self.debug.lock().await.clone() {
                        break url;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| error("Overlay browser debugging endpoint unavailable"))?;
            let mut connected = crate::cdp::Driver::connect(&url).await.map_err(error)?;
            let origin = self.origin.lock().await.clone();
            for (index, layer) in self.layers.iter().enumerate() {
                let name = layer
                    .folder
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| error("Overlay folder needs a UTF-8 name"))?;
                connected
                    .add_page(
                        &format!("{origin}/overlays/{index}/{}", crate::encode(&layer.entry)),
                        layer.width,
                        layer.height,
                        name,
                        epoch,
                    )
                    .await
                    .map_err(error)?;
            }
            *driver = Some(connected);
        }
        let screenshots = driver
            .as_mut()
            .unwrap()
            .capture(sequence, wall)
            .await
            .map_err(error)?;
        Ok(screenshots
            .into_iter()
            .zip(&self.layers)
            .map(|(png, layer)| Image {
                png,
                x: layer.x,
                y: layer.y,
                width: layer.width,
                height: layer.height,
                scale: layer.scale,
                opacity: layer.opacity,
            })
            .collect())
    }
}
pub fn routes(state: Arc<Overlays>) -> Router {
    Router::new()
        .route("/json/v2", get(snapshot))
        .route("/websocket/v2", get(full))
        .route("/websocket/v2/precise", get(precise))
        .route("/websocket/v2/subscribe", get(subscribe))
        .route("/websocket/commands", get(commands))
        .route("/overlays/{id}/{*path}", get(file))
        .route("/files/beatmap/{kind}", get(beatmap_file))
        .route("/tools/mania-ratings/api/{*path}", get(ratings))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            same_origin,
        ))
        .with_state(state)
}
async fn same_origin(
    State(state): State<Arc<Overlays>>,
    request: axum::http::Request<Body>,
    next: axum::middleware::Next,
) -> Response {
    let origin = state.origin.lock().await;
    let foreign = request.headers().get("host").is_none_or(|value| {
        origin
            .split_once("://")
            .is_none_or(|(_, authority)| value.as_bytes() != authority.as_bytes())
    }) || request
        .headers()
        .get("origin")
        .is_some_and(|value| value.as_bytes() != origin.as_bytes())
        || request
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|value| value != "same-origin" && value != "none");
    drop(origin);
    if foreign {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}
async fn snapshot(State(state): State<Arc<Overlays>>) -> Json<Value> {
    Json(state.source.borrow().clone())
}
async fn full(State(state): State<Arc<Overlays>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .on_upgrade(move |socket| stream(socket, state, false))
        .into_response()
}
async fn precise(State(state): State<Arc<Overlays>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .on_upgrade(move |socket| stream(socket, state, false))
        .into_response()
}
async fn subscribe(State(state): State<Arc<Overlays>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .on_upgrade(move |socket| stream(socket, state, true))
        .into_response()
}
async fn stream(mut socket: WebSocket, state: Arc<Overlays>, selected: bool) {
    let mut receiver = state.source.subscribe();
    let mut fields: Vec<String> = Vec::new();
    loop {
        let snapshot = receiver.borrow_and_update().clone();
        let sequence = snapshot["__render"]["sequence"].as_u64().unwrap_or(0);
        let frame = if selected {
            json!([
                0,
                sequence,
                fields
                    .iter()
                    .enumerate()
                    .map(|(index, path)| (
                        index,
                        snapshot.pointer(path).cloned().unwrap_or(Value::Null)
                    ))
                    .collect::<Vec<_>>(),
                []
            ])
        } else {
            snapshot
        };
        if (!selected || !fields.is_empty())
            && socket
                .send(Message::Text(frame.to_string().into()))
                .await
                .is_err()
        {
            return;
        }
        tokio::select! {change=receiver.changed()=>{if change.is_err(){return;}},message=socket.recv()=>match message{Some(Ok(Message::Text(text)))=>{if selected{match serde_json::from_str::<Vec<String>>(&text){Ok(next)if next.len()<=256&&next.iter().all(|s|s.starts_with('/'))=>fields=next,_=>{let _=socket.send(Message::Text(json!([2,sequence,"Expected at most 256 JSON pointers"]).to_string().into())).await;}}}},Some(Ok(Message::Close(_)))|None|Some(Err(_))=>return,_=>{}}}
    }
}
async fn commands(State(state): State<Arc<Overlays>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .on_upgrade(move |mut socket| async move {
            while let Some(Ok(Message::Text(text))) = socket.recv().await {
                let Some(name) = text.strip_prefix("getSettings:") else {
                    continue;
                };
                let layer = state.layers.iter().find(|layer| {
                    layer.folder.file_name().is_some_and(|n| {
                        encode(&n.to_string_lossy()) == name || n.to_string_lossy() == name
                    })
                });
                let mut values = BTreeMap::new();
                if let Some(layer) = layer {
                    if let Ok(bytes) = tokio::fs::read(layer.folder.join("settings.json")).await
                        && let Ok(Value::Array(settings)) = serde_json::from_slice::<Value>(&bytes)
                    {
                        for setting in settings {
                            if let Some(key) = setting["uniqueID"].as_str() {
                                values.insert(key.to_owned(), default_setting_value(&setting));
                            }
                        }
                    }
                    values.extend(layer.settings.clone());
                }
                if socket
                    .send(Message::Text(
                        json!({"command":"getSettings","message":values})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        })
        .into_response()
}
async fn file(
    State(state): State<Arc<Overlays>>,
    Path((id, path)): Path<(usize, String)>,
) -> Result<Response, Error> {
    let layer = state
        .layers
        .get(id)
        .ok_or_else(|| error("Unknown overlay"))?;
    let file = confined(&layer.folder, &path)?;
    let mime = match file.extension().and_then(|s| s.to_str()) {
        Some("html") => "text/html",
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        _ => "application/octet-stream",
    };
    Response::builder()
        .header("content-type", mime)
        .header("cache-control", "no-store")
        .body(Body::from(tokio::fs::read(file).await.map_err(error)?))
        .map_err(error)
}
async fn beatmap_file(
    State(state): State<Arc<Overlays>>,
    Path(kind): Path<String>,
) -> Result<Response, Error> {
    let native = state.native.lock().await;
    let native = native.as_ref().ok_or_else(|| error("No replay map"))?;
    if kind == "file" {
        return Response::builder()
            .header("content-type", "text/plain")
            .body(Body::from(native.bytes.to_vec()))
            .map_err(error);
    }
    let filename = state.source.borrow()["__render"]["files"][&kind]
        .as_str()
        .ok_or_else(|| error("Replay map asset is unavailable"))?
        .to_owned();
    let file = native.files.asset(&filename)?;
    Response::builder()
        .body(Body::from(tokio::fs::read(file).await.map_err(error)?))
        .map_err(error)
}
fn default_setting_value(setting: &Value) -> Value {
    let value = &setting["value"];
    match (setting["type"].as_str(), value.as_str()) {
        (Some("checkbox"), Some(text)) => text
            .parse::<bool>()
            .map(Value::Bool)
            .unwrap_or_else(|_| value.clone()),
        (Some("number"), Some(text)) => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| value.clone()),
        _ => value.clone(),
    }
}
async fn ratings(
    State(state): State<Arc<Overlays>>,
    Path(path): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, Error> {
    let configured_rate = state.source.borrow()["play"]["mods"]["rate"]
        .as_f64()
        .unwrap_or(1.0) as f32;
    let rate = query
        .get("rate")
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(configured_rate);
    if (rate - configured_rate).abs() > 0.000001 {
        return Err(error("Replay ratings use the render's fixed playback rate"));
    }
    let params = vosu_mania_ratings::Params::new(rate, None).map_err(error)?;
    let mut native = state.native.lock().await;
    let native = native.as_mut().ok_or_else(|| error("No replay map"))?;
    if path == "v1/beatmap/current" {
        if native.rating.is_none() {
            native.rating = Some(
                serde_json::to_value(
                    vosu_mania_ratings::calculate(&native.bytes, params).map_err(error)?,
                )
                .map_err(error)?,
            );
        }
        return Ok(Json(native.rating.clone().unwrap()));
    }
    let hash = state.source.borrow()["beatmap"]["checksum"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    if path != format!("v1/beatmap/{hash}/timeline") {
        return Err(error("Unsupported replay ratings route"));
    }
    let system = query.get("system").map(String::as_str).unwrap_or("etterna");
    let window = query
        .get("window")
        .and_then(|s| s.parse().ok())
        .unwrap_or(12.0);
    let hop = query.get("hop").and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let key = format!("{rate}:{system}:{window}:{hop}");
    if !native.timelines.contains_key(&key) {
        let timeline =
            vosu_mania_ratings::analysis::timeline(&native.bytes, params, system, window, hop)
                .map_err(error)?;
        native.timelines.insert(key.clone(), timeline);
    }
    Ok(Json(native.timelines[&key].clone()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_schema_defaults_preserve_boolean_and_number_types() {
        assert_eq!(
            default_setting_value(&json!({"type":"checkbox","value":"false"})),
            json!(false)
        );
        assert_eq!(
            default_setting_value(&json!({"type":"number","value":"40"})),
            json!(40.0)
        );
        assert_eq!(
            default_setting_value(&json!({"type":"text","value":"false"})),
            json!("false")
        );
    }
    #[tokio::test]
    async fn private_origin_rejects_cross_site_requests() {
        let state = Overlays::new(Vec::new());
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        state.origin(origin.clone()).await;
        let task = tokio::spawn(async move {
            axum::serve(listener, routes(state)).await.unwrap();
        });
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .get(format!("{origin}/json/v2"))
                .header("origin", "https://foreign.invalid")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{origin}/json/v2"))
                .header("sec-fetch-site", "cross-site")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{origin}/json/v2"))
                .header("host", "foreign.invalid")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{origin}/json/v2"))
                .header("origin", &origin)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        task.abort();
    }
    #[test]
    fn invalid_overlay_transforms_are_rejected() {
        let mut layers = [Overlay {
            folder: PathBuf::new(),
            entry: index(),
            width: 100,
            height: 100,
            x: 0.0,
            y: 0.0,
            scale: 0.0,
            opacity: 1.0,
            settings: BTreeMap::new(),
            tracks: None,
        }];
        assert!(Overlays::validate(&mut layers, 1).is_err());
    }
    #[test]
    fn single_html_files_and_folders_resolve_their_entry_page() {
        let root = std::env::temp_dir().join(format!("rr-overlay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::write(root.join("folder/index.html"), "<p>folder</p>").unwrap();
        std::fs::write(root.join("My Counter.HTML"), "<p>file</p>").unwrap();
        std::fs::write(root.join("notes.txt"), "no").unwrap();
        let layer = |folder: PathBuf| Overlay {
            folder,
            entry: index(),
            width: 100,
            height: 100,
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            opacity: 1.0,
            settings: BTreeMap::new(),
            tracks: None,
        };
        let mut layers = [
            layer(root.join("folder")),
            layer(root.join("My Counter.HTML")),
        ];
        Overlays::validate(&mut layers, 1).unwrap();
        let canonical = root.canonicalize().unwrap();
        assert_eq!(layers[0].folder, canonical.join("folder"));
        assert_eq!(layers[0].entry, "index.html");
        assert_eq!(layers[1].folder, canonical);
        assert_eq!(layers[1].entry, "My Counter.HTML");
        // A non-page file, and a folder without index.html, are rejected.
        assert!(Overlays::validate(&mut [layer(root.join("notes.txt"))], 1).is_err());
        assert!(Overlays::validate(&mut [layer(root.clone())], 1).is_err());
        // Track selection: absent shows on every track; indices must exist; pages are capped.
        let mut picked = layer(root.join("folder"));
        picked.tracks = Some(vec![1]);
        assert!(!picked.shows(0) && picked.shows(1));
        assert!(Overlays::validate(&mut [picked.clone()], 2).is_ok());
        assert!(Overlays::validate(&mut [picked], 1).is_err());
        let mut many: Vec<_> = (0..3).map(|_| layer(root.join("folder"))).collect();
        assert!(Overlays::validate(&mut many, 10).is_ok());
        let mut too_many: Vec<_> = (0..3).map(|_| layer(root.join("folder"))).collect();
        assert!(Overlays::validate(&mut too_many, 11).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rating_uses_lazer_mods_and_difficulty_adjust() {
        let mods = RatingMods {
            rate: 1.25,
            legacy: 64,
            acronyms: Some("DTCL".into()),
            overrides: DifficultyOverrides {
                od: Some(9.5),
                ..Default::default()
            },
        };
        let inspected = mods.difficulty(true).inspect();
        assert_eq!(inspected.clock_rate, Some(1.25));
        assert_eq!(inspected.lazer, Some(true));
        let listed = format!("{:?}", inspected.mods);
        assert!(
            listed.contains("Classic") && listed.contains("DoubleTime"),
            "{listed}"
        );
        assert!(format!("{:?}", inspected.od).contains("9.5"));
        // osu!stable replays keep their legacy bits.
        let stable = RatingMods {
            acronyms: None,
            ..mods
        };
        assert!(!format!("{:?}", stable.difficulty(false).inspect().mods).contains("Classic"));
    }
}
