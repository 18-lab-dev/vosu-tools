use super::*;
use serde_json::Map;
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::sync::watch;

mod documents;
mod server;
pub use server::{SYNC_PREFIX, routes};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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
    /// vosu's id for an installed overlay (its folder relative to the
    /// overlays folder), set by `resolve`; `None` for other folders.
    #[serde(skip)]
    pub id: Option<String>,
    /// How errors name it: the dashboard nickname, metadata `Name` or folder.
    #[serde(skip)]
    pub name: String,
    /// Effective settings `getSettings` answers (set by `resolve`).
    #[serde(skip)]
    pub values: Map<String, Value>,
}
impl Overlay {
    pub fn shows(&self, track: usize) -> bool {
        self.tracks
            .as_ref()
            .is_none_or(|tracks| tracks.contains(&track))
    }
    /// vosu's `COUNTER_PATH`: the overlay id, else the folder name. Pages are
    /// served under it, as vosu serves them.
    pub fn counter_path(&self) -> String {
        self.id.clone().unwrap_or_else(|| {
            self.folder
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
    }
    /// The page's URL path from the server root.
    fn page_path(&self) -> String {
        let id = self.counter_path();
        let segments: Vec<String> = id.split('/').map(crate::encode).collect();
        format!("/{}/{}", segments.join("/"), crate::encode(&self.entry))
    }
}

/// Overlay servers answer many small WebSocket frames: no Nagle delay.
pub fn nodelay(
    listener: tokio::net::TcpListener,
) -> impl axum::serve::Listener<Addr = std::net::SocketAddr> {
    use axum::serve::ListenerExt;
    listener.tap_io(|stream| {
        let _ = stream.set_nodelay(true);
    })
}

/// Where a track's overlays read `/files/skin/`: the skin it renders with.
#[derive(Clone)]
pub struct SkinSource {
    pub app: App,
    /// The preset's skin value (`""` current, `builtin/…`, `imported/…`, …).
    pub name: String,
}

/// Fills in each layer's vosu identity and the settings its pages read:
/// installed overlays (matched by folder in vosu's listing) get vosu's own
/// effective values for the active profile, read once through vosu's
/// `/websocket/commands` exactly as the overlay would; other folders get
/// their `settings.json` defaults. The render's own per-layer `settings`
/// apply on top. Nothing is written.
pub async fn resolve(app: &App, layers: &mut [Overlay]) {
    let listing = installed(app).await;
    for layer in layers {
        let installed = listing
            .iter()
            .find(|(folder, ..)| *folder == layer.folder && layer.entry == "index.html");
        layer.id = installed.map(|(_, id, _)| id.clone());
        layer.name = installed
            .map(|(.., name)| name.clone())
            .or_else(|| metadata_name(&layer.folder))
            .unwrap_or_else(|| layer.counter_path());
        let mut values = match &layer.id {
            Some(id) => vosu_settings(&app.env.vosu_url, id).await.ok(),
            None => None,
        }
        .unwrap_or_else(|| default_settings(&layer.folder));
        values.extend(layer.settings.clone());
        layer.values = values;
    }
}

/// vosu's installed overlays: canonical folder, id and display name.
async fn installed(app: &App) -> Vec<(PathBuf, String, String)> {
    let request = app
        .env
        .client()
        .request(Method::GET, "/tools/_host/v1/overlays");
    let Ok(response) = request.send().await else {
        return Vec::new();
    };
    let Ok(listing) = response.json::<Value>().await else {
        return Vec::new();
    };
    listing["overlays"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let folder = PathBuf::from(entry["folder"].as_str()?)
                .canonicalize()
                .ok()?;
            let id = entry["id"].as_str()?.to_owned();
            let name = entry["nickname"]
                .as_str()
                .filter(|n| !n.is_empty())
                .or(entry["name"].as_str())
                .unwrap_or(&id)
                .to_owned();
            Some((folder, id, name))
        })
        .collect()
}

fn metadata_name(folder: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(folder.join("metadata.txt")).ok()?;
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim().eq_ignore_ascii_case("name") && !value.trim().is_empty())
            .then(|| value.trim().to_owned())
    })
}

/// One `getSettings` on vosu's public command socket, as the overlay sends it.
async fn vosu_settings(vosu_url: &str, id: &str) -> Result<Map<String, Value>, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let base = vosu_url
        .strip_prefix("http://")
        .map(|rest| format!("ws://{rest}"))
        .or_else(|| {
            vosu_url
                .strip_prefix("https://")
                .map(|rest| format!("wss://{rest}"))
        })
        .ok_or("vosu URL is not HTTP")?;
    let encoded = encode(id);
    let exchange = async {
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("{base}/websocket/commands?l={encoded}"))
                .await
                .map_err(|e| e.to_string())?;
        socket
            .send(Message::Text(format!("getSettings:{encoded}").into()))
            .await
            .map_err(|e| e.to_string())?;
        while let Some(message) = socket.next().await {
            let Message::Text(text) = message.map_err(|e| e.to_string())? else {
                continue;
            };
            let reply: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if reply["command"] != "getSettings" {
                continue;
            }
            let _ = socket.close(None).await;
            return match reply["message"].clone() {
                Value::Object(values) if !values.contains_key("error") => Ok(values),
                other => Err(format!("vosu has no settings for {id}: {other}")),
            };
        }
        Err("vosu closed the command socket".to_owned())
    };
    tokio::time::timeout(Duration::from_secs(5), exchange)
        .await
        .map_err(|_| "vosu did not answer getSettings".to_owned())?
}

/// `settings.json` defaults as vosu coerces them; headers carry no value.
fn default_settings(folder: &std::path::Path) -> Map<String, Value> {
    let mut values = Map::new();
    if let Ok(bytes) = std::fs::read(folder.join("settings.json"))
        && let Ok(Value::Array(settings)) = serde_json::from_slice::<Value>(&bytes)
    {
        for setting in settings {
            if let Some(key) = setting["uniqueID"].as_str()
                && setting["type"] != "header"
            {
                values.insert(key.to_owned(), default_setting_value(&setting));
            }
        }
    }
    values
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
    /// The rated map and difficulty, to restart the gradual rating when a
    /// preview seeks backwards.
    map: rosu_pp::Beatmap,
    difficulty: rosu_pp::Difficulty,
    pp: rosu_pp::GradualPerformance,
    passed: u32,
    current_pp: f64,
    max_combo: u32,
    /// Map facts the studio does not send: rated stars and max combo, object
    /// counts, the map's folder and file names.
    facts: Value,
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
    /// Offline render (virtual clock, sync markers) rather than a live preview.
    offline: bool,
    source: watch::Sender<Arc<documents::Documents>>,
    native: Mutex<Option<Native>>,
    skin: Mutex<Option<SkinSource>>,
    driver: Mutex<Option<crate::cdp::Driver>>,
    debug: Mutex<Option<String>>,
    origin: Mutex<String>,
    sequence: AtomicU64,
}
impl Overlays {
    /// A track's overlay runtime; `offline` for an export, else a live preview.
    pub fn new(layers: Vec<Overlay>, offline: bool) -> Arc<Self> {
        let (source, _) = watch::channel(Arc::new(documents::Documents::new(&json!({}), 0)));
        Arc::new(Self {
            layers,
            offline,
            source,
            native: Mutex::new(None),
            skin: Mutex::new(None),
            driver: Mutex::new(None),
            debug: Mutex::new(None),
            origin: Mutex::new(String::new()),
            sequence: AtomicU64::new(0),
        })
    }
    fn documents(&self) -> Arc<documents::Documents> {
        self.source.borrow().clone()
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
            if layer.name.is_empty() {
                layer.name = layer.counter_path();
            }
        }
        Ok(())
    }
    pub async fn origin(&self, origin: String) {
        *self.origin.lock().await = origin;
    }
    /// The page URLs of this runtime's layers, in layer order.
    pub async fn pages(&self) -> Vec<String> {
        let origin = self.origin.lock().await.clone();
        self.layers
            .iter()
            .map(|layer| format!("{origin}{}", layer.page_path()))
            .collect()
    }
    pub async fn debug(&self, url: String) {
        *self.debug.lock().await = Some(url);
    }
    /// Overlays that draw with WebGPU in a browser that leaves WebGPU canvases
    /// out of its captures (full Chrome): their exported pictures miss them.
    pub async fn blank_webgpu(&self) -> Vec<String> {
        self.driver
            .lock()
            .await
            .as_ref()
            .map(crate::cdp::Driver::blank_webgpu)
            .unwrap_or_default()
    }
    pub async fn configure(
        &self,
        files: crate::library::MapFiles,
        bytes: Vec<u8>,
        mods: RatingMods,
        initial: Value,
        skin: Option<SkinSource>,
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
        // osu!stable scores are rated as stable rates them; lazer's need its tick counts (see `publish`).
        let difficulty = mods.difficulty(initial["client"] != "stable");
        let attributes = difficulty.calculate(&map);
        let facts = map_facts(&map, &files, attributes.stars(), attributes.max_combo());
        *self.native.lock().await = Some(Native {
            bytes: bytes.into(),
            files,
            pp: rosu_pp::GradualPerformance::checked_new(difficulty.clone(), &map)
                .map_err(error)?,
            map,
            difficulty,
            passed: 0,
            current_pp: 0.0,
            max_combo: 0,
            facts,
            rating: None,
            timelines: BTreeMap::new(),
        });
        *self.skin.lock().await = skin;
        self.publish(initial).await?;
        Ok(())
    }
    /// Makes `state` (a partial v2 document plus `__render`) the current state
    /// point of every route and socket; returns its sequence.
    pub async fn publish(&self, mut state: Value) -> Result<u64, Error> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let mut native = self.native.lock().await;
        let native = native
            .as_mut()
            .ok_or_else(|| error("Overlay score map is not configured"))?;
        if let Some(counts) = state["__render"]["counts"].as_object() {
            let count = |key: &str| {
                counts
                    .get(key)
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(u64::from(u32::MAX)) as u32
            };
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
            let combo = state["play"]["combo"]["current"]
                .as_u64()
                .unwrap_or(0)
                .min(u64::from(u32::MAX)) as u32;
            let passed =
                score.n_geki + score.n_katu + score.n300 + score.n100 + score.n50 + score.misses;
            if passed < native.passed {
                // A preview seeked backwards: rate again from the start.
                native.pp = rosu_pp::GradualPerformance::checked_new(
                    native.difficulty.clone(),
                    &native.map,
                )
                .map_err(error)?;
                native.passed = 0;
                native.current_pp = 0.0;
                native.max_combo = 0;
            }
            native.max_combo = native.max_combo.max(combo);
            score.max_combo = native.max_combo;
            if passed > native.passed {
                if let Some(pp) = native.pp.nth(score, (passed - native.passed - 1) as usize) {
                    native.current_pp = pp.pp();
                }
                native.passed = passed;
            }
            state["play"]["pp"]["current"] = json!((native.current_pp * 100.0).round() / 100.0);
        }
        let mut facts = native.facts.clone();
        let folder = facts["folders"]["beatmap"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let join = |name: &Value| match name.as_str() {
            Some(name) if !name.is_empty() && !folder.is_empty() => {
                json!(format!("{folder}/{name}"))
            }
            Some(name) if !name.is_empty() => json!(name),
            _ => json!("."),
        };
        facts["directPath"]["beatmapBackground"] = join(&state["files"]["background"]);
        facts["directPath"]["beatmapAudio"] = join(&state["files"]["audio"]);
        if let (Value::Object(target), Value::Object(facts)) = (&mut state, facts) {
            for (key, value) in facts {
                match (target.get_mut(&key), value) {
                    (Some(Value::Object(existing)), Value::Object(fields)) => {
                        for (key, value) in fields {
                            match (existing.get_mut(&key), value) {
                                (Some(Value::Object(inner)), Value::Object(more)) => {
                                    inner.extend(more)
                                }
                                (_, value) => {
                                    existing.insert(key, value);
                                }
                            }
                        }
                    }
                    (_, value) => {
                        target.insert(key, value);
                    }
                }
            }
        }
        self.source
            .send_replace(Arc::new(documents::Documents::new(&state, sequence)));
        Ok(sequence)
    }
    /// One export frame: publishes `state`, lets every page catch up on the
    /// virtual clock, and captures them.
    pub async fn frame(&self, state: Value) -> Result<Vec<Image>, Error> {
        if self.layers.is_empty() {
            return Ok(Vec::new());
        }
        let wall = state["__render"]["wallMs"]
            .as_f64()
            .ok_or_else(|| error("Frame has no render clock"))?;
        let capture = state["__render"]["capture"] != false;
        let epoch = state["__render"]["epochMs"].as_f64().unwrap_or(0.0);
        let sequence = self.publish(state).await?;
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
            for (layer, page) in self.layers.iter().zip(self.pages().await) {
                connected
                    .add_page(
                        &page,
                        layer.width,
                        layer.height,
                        &layer.name,
                        epoch,
                        sequence,
                    )
                    .await
                    .map_err(error)?;
            }
            *driver = Some(connected);
        }
        let screenshots = driver
            .as_mut()
            .unwrap()
            .capture(sequence, wall, capture)
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
    /// Evaluates `expression` on every page (tests read what pages saw).
    #[cfg(test)]
    pub async fn evaluate(&self, expression: &str) -> Vec<Value> {
        let mut driver = self.driver.lock().await;
        driver.as_mut().unwrap().evaluate(expression).await.unwrap()
    }
}

/// What vosu reports about the map itself, from the rated (converted) map.
fn map_facts(
    map: &rosu_pp::Beatmap,
    files: &crate::library::MapFiles,
    stars: f64,
    max_combo: u32,
) -> Value {
    use rosu_pp::model::hit_object::HitObjectKind;
    let (mut circles, mut sliders, mut spinners, mut holds) = (0, 0, 0, 0);
    for object in &map.hit_objects {
        match object.kind {
            HitObjectKind::Circle => circles += 1,
            HitObjectKind::Slider(_) => sliders += 1,
            HitObjectKind::Spinner(_) => spinners += 1,
            HitObjectKind::Hold(_) => holds += 1,
        }
    }
    let (folder, file) = files.names();
    let stars = (stars * 100.0).round() / 100.0;
    json!({
        "beatmap": {"stats": {
            "stars": {"live": stars, "total": stars},
            "maxCombo": max_combo,
            "objects": {"circles": circles, "sliders": sliders, "spinners": spinners, "holds": holds,
                "total": circles + sliders + spinners + holds},
        }},
        "folders": {"beatmap": folder},
        "files": {"beatmap": file},
        "directPath": {
            "beatmapFile": if folder.is_empty() { file.clone() } else { format!("{folder}/{file}") },
            "beatmapFolder": folder,
        },
    })
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
pub(super) async fn ratings(
    State(state): State<Arc<Overlays>>,
    Path(path): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, Error> {
    let configured_rate = state.documents().v2["play"]["mods"]["rate"]
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
    let hash = state.documents().v2["beatmap"]["checksum"]
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
        let state = Overlays::new(Vec::new(), true);
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

    const STAND_IN_MAP: &str = "osu file format v14\n\n[General]\nAudioFilename: audio.mp3\nMode: 3\n\n[Metadata]\nTitle:Stand-in\nArtist:Test\nCreator:t\nVersion:4K\nBeatmapID:0\nBeatmapSetID:-1\n\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:8\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n192,192,1500,1,0,0:0:0:0:\n320,192,2000,128,0,2500:0:0:0:0:\n";

    /// A stand-in overlay folder (with settings defaults) and a configured
    /// runtime serving it on a loopback port.
    async fn stand_in(
        page: &str,
        offline: bool,
    ) -> (Arc<Overlays>, String, PathBuf, tokio::task::JoinHandle<()>) {
        let root = std::env::temp_dir().join(format!("rr-protocol-{}", uuid::Uuid::new_v4()));
        let folder = root.join("stand-in");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("index.html"), page).unwrap();
        std::fs::write(
            folder.join("settings.json"),
            r##"[{"uniqueID":"title","type":"header","value":""},{"uniqueID":"color","type":"color","value":"#ff0000"},{"uniqueID":"size","type":"number","value":"40"},{"uniqueID":"show","type":"checkbox","value":"true"}]"##,
        )
        .unwrap();
        let songs = root.join("Songs/1 Test - Stand-in");
        std::fs::create_dir_all(&songs).unwrap();
        std::fs::write(songs.join("map.osu"), STAND_IN_MAP).unwrap();
        std::fs::write(songs.join("bg.png"), b"png").unwrap();
        let mut layers = vec![Overlay {
            folder: folder.clone(),
            width: 200,
            height: 100,
            scale: 1.0,
            opacity: 1.0,
            settings: BTreeMap::from([("size".to_owned(), json!(48))]),
            ..Default::default()
        }];
        Overlays::validate(&mut layers, 1).unwrap();
        // What `resolve` gives a folder vosu does not list.
        layers[0].values = default_settings(&layers[0].folder);
        let own = layers[0].settings.clone();
        layers[0].values.extend(own);
        let state = Overlays::new(layers, offline);
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        state.origin(origin.clone()).await;
        let served = state.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, routes(served)).await.unwrap();
        });
        state
            .configure(
                crate::library::MapFiles::Stable(songs.join("map.osu")),
                STAND_IN_MAP.as_bytes().to_vec(),
                RatingMods {
                    rate: 1.0,
                    legacy: 0,
                    acronyms: None,
                    overrides: DifficultyOverrides::default(),
                },
                json!({"client": "stable", "play": {"mode": {"number": 3, "name": "mania"}},
                    "files": {"background": "bg.png", "audio": "audio.mp3"}, "__render": {}}),
                None,
            )
            .await
            .unwrap();
        (state, origin, root, task)
    }

    async fn socket(
        origin: &str,
        path: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let url = format!("{}{path}", origin.replace("http://", "ws://"));
        tokio_tungstenite::connect_async(url).await.unwrap().0
    }
    async fn next_text(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Option<String> {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message;
        loop {
            match tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .ok()??
            {
                Ok(Message::Text(text)) => return Some(text.to_string()),
                Ok(Message::Close(frame)) => {
                    return frame.map(|f| format!("close {}", u16::from(f.code)));
                }
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    }

    #[tokio::test]
    async fn the_private_server_speaks_vosus_overlay_protocol() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message;
        let (state, origin, root, task) = stand_in("<p>stand-in</p>", true).await;
        let client = reqwest::Client::new();
        let get = |path: &str| client.get(format!("{origin}{path}")).send();

        // Documents in vosu's shapes.
        let v2: Value = get("/json/v2").await.unwrap().json().await.unwrap();
        assert_eq!(v2["state"], json!({"number": 2, "name": "play"}));
        assert_eq!(
            v2["beatmap"]["stats"]["objects"],
            json!({"circles": 2, "sliders": 0, "spinners": 0, "holds": 1, "total": 3})
        );
        assert_eq!(v2["directPath"]["beatmapFile"], "1 Test - Stand-in/map.osu");
        assert_eq!(
            v2["directPath"]["beatmapBackground"],
            "1 Test - Stand-in/bg.png"
        );
        assert!(v2["keys"]["all"].is_array() && v2.get("__render").is_none());
        let precise: Value = get("/json/v2/precise").await.unwrap().json().await.unwrap();
        assert!(precise["keys"]["k1"].is_object() && precise["hitErrors"].is_array());
        let v1: Value = get("/json").await.unwrap().json().await.unwrap();
        assert_eq!(v1["menu"]["state"], 2);
        let sc: Value = get("/json/sc").await.unwrap().json().await.unwrap();
        assert_eq!(sc["gameMode"], "mania");

        // Map files, by name and by vosu's direct paths.
        for path in [
            "/files/beatmap/file",
            "/files/beatmap/1%20Test%20-%20Stand-in/map.osu",
            "/Songs/1%20Test%20-%20Stand-in/map.osu",
        ] {
            let response = get(path).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert!(
                response
                    .text()
                    .await
                    .unwrap()
                    .starts_with("osu file format")
            );
        }
        assert_eq!(
            get("/files/beatmap/background")
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "png"
        );
        assert_eq!(
            get("/backgroundImage").await.unwrap().status(),
            StatusCode::OK
        );

        // Pages at vosu's path, with its COUNTER_PATH; unknown routes answer 404.
        let redirect = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let moved = redirect
            .get(format!("{origin}/stand-in"))
            .send()
            .await
            .unwrap();
        assert_eq!(moved.status(), StatusCode::FOUND);
        assert_eq!(moved.headers()["location"], "/stand-in/");
        let page = get("/stand-in/").await.unwrap().text().await.unwrap();
        assert!(
            page.ends_with("<script>window.COUNTER_PATH=\"stand-in\";</script>"),
            "{page}"
        );
        for path in [
            "/nothing",
            "/stand-in/missing.js",
            "/api/calculate/nothing",
            "/websocket/other",
            "/files/beatmap/../x",
        ] {
            assert_eq!(
                get(path).await.unwrap().status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        let url = format!("{}/websocket/v3", origin.replace("http://", "ws://"));
        assert!(tokio_tungstenite::connect_async(url).await.is_err());

        // Settings: settings.json defaults (headers dropped, types coerced) under the render's own values.
        let mut commands = socket(&origin, "/websocket/commands?l=stand-in").await;
        commands
            .send(Message::Text("getSettings:stand-in".into()))
            .await
            .unwrap();
        let reply: Value = serde_json::from_str(&next_text(&mut commands).await.unwrap()).unwrap();
        assert_eq!(
            reply,
            json!({"command": "getSettings", "message": {"color": "#ff0000", "size": 48, "show": true}})
        );
        commands
            .send(Message::Text("getSettings:other".into()))
            .await
            .unwrap();
        let reply: Value = serde_json::from_str(&next_text(&mut commands).await.unwrap()).unwrap();
        assert_eq!(reply["message"]["error"], "Wrong overlay");
        commands
            .send(Message::Text("updateSettings:stand-in:{\"size\":3}".into()))
            .await
            .unwrap();
        let reply: Value = serde_json::from_str(&next_text(&mut commands).await.unwrap()).unwrap();
        assert_eq!(
            reply,
            json!({"command": "updateSettings", "message": {"size": 3}})
        );

        // Selected fields: initial frame, change-only updates, the offline sync marker.
        let mut subscription = socket(&origin, "/websocket/v2/subscribe").await;
        subscription
            .send(Message::Text(
                r#"["/play/hits/300","/play/hitErrorArray/0","/beatmap/stats/maxCombo"]"#.into(),
            ))
            .await
            .unwrap();
        let initial: Value =
            serde_json::from_str(&next_text(&mut subscription).await.unwrap()).unwrap();
        assert_eq!(initial[0], 0);
        assert_eq!(initial[2], json!([[0, 0], [2, 8]]));
        assert_eq!(
            next_text(&mut subscription).await.unwrap(),
            format!("{SYNC_PREFIX}1")
        );
        let mut full = socket(&origin, "/websocket/v2").await;
        assert!(next_text(&mut full).await.unwrap().starts_with('{'));
        assert_eq!(
            next_text(&mut full).await.unwrap(),
            format!("{SYNC_PREFIX}1")
        );
        let sequence = state
            .publish(json!({"play": {"mode": {"number": 3}, "hits": {"300": 1}, "hitErrorArray": [-4.5]}, "__render": {}}))
            .await
            .unwrap();
        assert_eq!(
            next_text(&mut subscription).await.unwrap(),
            format!("[1,{sequence},[[0,1],[1,-4.5]],[]]")
        );
        assert_eq!(
            next_text(&mut subscription).await.unwrap(),
            format!("{SYNC_PREFIX}{sequence}")
        );
        state
            .publish(json!({"play": {"mode": {"number": 3}, "hits": {"300": 1}}, "__render": {}}))
            .await
            .unwrap();
        // Nothing changed but the removed error; the marker still follows.
        assert_eq!(
            next_text(&mut subscription).await.unwrap(),
            format!("[1,{},[],[1]]", sequence + 1)
        );
        assert_eq!(
            next_text(&mut subscription).await.unwrap(),
            format!("{SYNC_PREFIX}{}", sequence + 1)
        );
        subscription
            .send(Message::Text(r#"["/state"]"#.into()))
            .await
            .unwrap();
        assert_eq!(
            next_text(&mut subscription).await.unwrap(),
            "[2,5,\"subscription already established\"]"
        );
        assert_eq!(next_text(&mut subscription).await.unwrap(), "close 1008");
        // The whole-document stream follows vosu's 150 ms publishing interval of render time.
        assert_eq!(
            next_text(&mut full).await.unwrap(),
            format!("{SYNC_PREFIX}{sequence}")
        );
        assert_eq!(
            next_text(&mut full).await.unwrap(),
            format!("{SYNC_PREFIX}{}", sequence + 1)
        );
        let later = state
            .publish(json!({"play": {"mode": {"number": 3}, "hits": {"300": 2}}, "__render": {"wallMs": 200.0}}))
            .await
            .unwrap();
        let document: Value = serde_json::from_str(&next_text(&mut full).await.unwrap()).unwrap();
        assert_eq!(document["play"]["hits"]["300"], 2);
        assert_eq!(
            next_text(&mut full).await.unwrap(),
            format!("{SYNC_PREFIX}{later}")
        );
        let mut invalid = socket(&origin, "/websocket/v2/subscribe").await;
        invalid
            .send(Message::Text(r#"["/a","/a/b"]"#.into()))
            .await
            .unwrap();
        assert_eq!(
            next_text(&mut invalid).await.unwrap(),
            "[2,2,\"invalid JSON Pointer\"]"
        );
        task.abort();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn live_previews_get_no_sync_markers_and_may_be_embedded() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message;
        let (_state, origin, root, task) = stand_in("<p>stand-in</p>", false).await;
        let mut subscription = socket(&origin, "/websocket/v2/subscribe").await;
        subscription
            .send(Message::Text(r#"["/state/number"]"#.into()))
            .await
            .unwrap();
        assert_eq!(next_text(&mut subscription).await.unwrap(), "[0,1,[[0,2]]]");
        use futures_util::StreamExt;
        assert!(
            tokio::time::timeout(Duration::from_millis(300), subscription.next())
                .await
                .is_err()
        );
        let client = reqwest::Client::new();
        // The studio frames the page (a cross-site navigation)...
        let framed = client
            .get(format!("{origin}/stand-in/"))
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "iframe")
            .send()
            .await
            .unwrap();
        assert_eq!(framed.status(), StatusCode::OK);
        // ...but other sites still cannot read its state.
        let read = client
            .get(format!("{origin}/json/v2"))
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "cors")
            .send()
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::FORBIDDEN);
        task.abort();
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Regression: a page that draws only after `getSettings` (and its first
    /// subscription frame) answered is captured drawn on the first frame,
    /// instead of the render waiting until a protocol timeout. Needs Chromium
    /// (`VOSU_RENDER_CHROMIUM`); skipped without it.
    #[tokio::test]
    async fn pages_that_wait_for_settings_render_in_headless_chromium() {
        let Some(chromium) = std::env::var_os("VOSU_RENDER_CHROMIUM").filter(|p| !p.is_empty())
        else {
            eprintln!("skipped: VOSU_RENDER_CHROMIUM is not set");
            return;
        };
        // Draws its settings colour once getSettings and the first subscription frame arrived.
        let gated = r#"<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body><script type="module">
            const host = location.host, path = encodeURIComponent(window.COUNTER_PATH);
            let settings = null, hits = null;
            const draw = () => { if (settings && hits !== null) document.body.innerHTML = `<div style="width:200px;height:100px;background:${settings.color}"></div>`; };
            const commands = new WebSocket(`ws://${host}/websocket/commands?l=${path}`);
            commands.onopen = () => commands.send(`getSettings:${path}`);
            commands.onmessage = (e) => { const m = JSON.parse(e.data); if (m.command === "getSettings") { settings = m.message; draw(); } };
            const fields = new WebSocket(`ws://${host}/websocket/v2/subscribe`);
            fields.onopen = () => fields.send(JSON.stringify(["/play/hits/300"]));
            fields.onmessage = (e) => { const f = JSON.parse(e.data); if (f[0] === 0) { hits = f[2][0]?.[1] ?? 0; draw(); } };
        </script></body></html>"#;
        let (state, _origin, root, task) = stand_in(gated, true).await;
        // A plain page drawing the same pixels unconditionally, and an empty one.
        let reference = root.join("reference");
        std::fs::create_dir_all(&reference).unwrap();
        std::fs::write(reference.join("index.html"), r#"<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body><div style="width:200px;height:100px;background:#ff0000"></div></body></html>"#).unwrap();
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(empty.join("index.html"), "<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body></body></html>").unwrap();
        let mut layers = state.layers.clone();
        for folder in [reference, empty] {
            let mut layer = layers[0].clone();
            layer.folder = folder;
            layer.id = None;
            layers.push(layer);
        }
        Overlays::validate(&mut layers, 1).unwrap();
        task.abort();
        let runtime = Overlays::new(layers, true);
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        runtime
            .origin(format!("http://{}", listener.local_addr().unwrap()))
            .await;
        let served = runtime.clone();
        let task =
            tokio::spawn(async move { axum::serve(listener, routes(served)).await.unwrap() });
        let songs = root.join("Songs/1 Test - Stand-in/map.osu");
        runtime
            .configure(
                crate::library::MapFiles::Stable(songs),
                STAND_IN_MAP.as_bytes().to_vec(),
                RatingMods {
                    rate: 1.0,
                    legacy: 0,
                    acronyms: None,
                    overrides: DifficultyOverrides::default(),
                },
                json!({"client": "stable", "play": {"mode": {"number": 3}}, "__render": {}}),
                None,
            )
            .await
            .unwrap();
        let profile = root.join("chromium");
        let mut chromium = tokio::process::Command::new(chromium)
            .args([
                "--headless=new",
                "--no-first-run",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("about:blank")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let endpoint = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Ok(text) =
                    tokio::fs::read_to_string(profile.join("DevToolsActivePort")).await
                    && let [port, path, ..] = text.lines().collect::<Vec<_>>()[..]
                {
                    break format!("ws://127.0.0.1:{port}{path}");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        runtime.debug(endpoint).await;
        let state = |wall: f64| json!({"client": "stable", "play": {"mode": {"number": 3}}, "__render": {"wallMs": wall, "epochMs": 0.0}});
        let started = std::time::Instant::now();
        let first = runtime.frame(state(0.0)).await.unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the frame waited {:?}",
            started.elapsed()
        );
        assert_eq!(first.len(), 3);
        assert_ne!(first[1].png, first[2].png, "the reference page draws");
        assert_eq!(
            first[0].png, first[1].png,
            "the settings-gated page is drawn on the first frame"
        );
        let second = runtime.frame(state(16.0)).await.unwrap();
        assert_eq!(second[0].png, second[1].png);
        let _ = chromium.kill().await;
        task.abort();
        // Chrome's helper processes may still be leaving the profile: best effort.
        let _ = std::fs::remove_dir_all(root);
    }

    /// Starts headless Chromium on a throwaway profile; its DevTools endpoint.
    async fn chromium(root: &std::path::Path) -> Option<(tokio::process::Child, String)> {
        let chromium = std::env::var_os("VOSU_RENDER_CHROMIUM").filter(|p| !p.is_empty())?;
        Some(launch(chromium.as_ref(), root).await)
    }
    /// A full (non-shell) Chrome: `VOSU_TEST_FULL_CHROME`, else a system
    /// Chrome or Chromium.
    fn full_chrome() -> Option<PathBuf> {
        std::env::var_os("VOSU_TEST_FULL_CHROME")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                [
                    "/usr/bin/google-chrome-stable",
                    "/usr/bin/google-chrome",
                    "/usr/bin/chromium",
                    "/usr/bin/chromium-browser",
                ]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
            })
    }
    /// Starts `executable` headless, with the renderer's compositor flags, on
    /// a throwaway profile under `root`; its DevTools endpoint.
    async fn launch(
        executable: &std::path::Path,
        root: &std::path::Path,
    ) -> (tokio::process::Child, String) {
        let profile = root.join("chromium");
        let child = tokio::process::Command::new(executable)
            .args([
                "--headless=new",
                "--no-first-run",
                "--run-all-compositor-stages-before-draw",
                "--disable-gpu-vsync",
                "--enable-unsafe-webgpu",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("about:blank")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let endpoint = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Ok(text) =
                    tokio::fs::read_to_string(profile.join("DevToolsActivePort")).await
                    && let [port, path, ..] = text.lines().collect::<Vec<_>>()[..]
                {
                    break format!("ws://127.0.0.1:{port}{path}");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        (child, endpoint)
    }

    /// Regression: sockets a page opens while a frame settles (the timing
    /// bar's rolling subscription windows) connect and answer within the
    /// frame instead of stalling it.
    #[tokio::test]
    async fn sockets_opened_mid_frame_connect_in_headless_chromium() {
        let page = r#"<!doctype html><html><body><script type="module">
            let opened = 0;
            const open = () => {
              const socket = new WebSocket(`ws://${location.host}/websocket/v2/subscribe`);
              socket.onopen = () => socket.send(JSON.stringify(["/play/hits/300"]));
              socket.onmessage = (e) => {
                const frame = JSON.parse(e.data);
                document.body.textContent = String(frame[2][0]?.[1]);
                if (frame[0] === 1) { opened++; open(); }
              };
            };
            open();
        </script></body></html>"#;
        let (runtime, _origin, root, task) = stand_in(page, true).await;
        let Some((mut child, endpoint)) = chromium(&root).await else {
            eprintln!("skipped: VOSU_RENDER_CHROMIUM is not set");
            task.abort();
            return;
        };
        runtime.debug(endpoint).await;
        for frame in 0..4 {
            let started = std::time::Instant::now();
            let state = json!({"client": "stable", "play": {"mode": {"number": 3}, "hits": {"300": frame}},
                "__render": {"wallMs": f64::from(frame) * 16.0, "epochMs": 0.0}});
            runtime.frame(state).await.unwrap();
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "frame {frame} took {:?}",
                started.elapsed()
            );
        }
        let _ = child.kill().await;
        task.abort();
        // Chrome's helper processes may still be leaving the profile: best effort.
        let _ = std::fs::remove_dir_all(root);
    }

    /// Regression: an overlay's animation runs once per export frame. Every
    /// animation frame callback runs exactly once per frame with the frame's
    /// time (so a page measuring its own frame rate sees the video's), the
    /// precise feed delivers every frame and `/websocket/v2` keeps vosu's
    /// 150 ms poll grid, also across uncaptured frames (parallel workers
    /// replaying history).
    #[tokio::test]
    async fn animation_frames_follow_export_frames_in_headless_chromium() {
        let page = r#"<!doctype html><html><body><script type="module">
            let precise = 0, full = 0;
            const frames = [];
            const loop = (time) => {
              frames.push([time, performance.now(), precise, full]);
              requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
            new WebSocket(`ws://${location.host}/websocket/v2/precise`).onmessage = () => precise++;
            new WebSocket(`ws://${location.host}/websocket/v2`).onmessage = () => full++;
            window.frames = frames;
        </script></body></html>"#;
        for fps in [30.0, 60.0] {
            let (runtime, _origin, root, task) = stand_in(page, true).await;
            let Some((mut child, endpoint)) = chromium(&root).await else {
                eprintln!("skipped: VOSU_RENDER_CHROMIUM is not set");
                task.abort();
                return;
            };
            runtime.debug(endpoint).await;
            let step = 1000.0 / fps;
            let count = 2 * fps as u32;
            for frame in 0..=count {
                let state = json!({"client": "stable", "play": {"mode": {"number": 3},
                    "hits": {"300": frame}, "hitErrorArray": [frame]},
                    "__render": {"wallMs": f64::from(frame) * step, "epochMs": 0.0, "capture": frame > count / 2}});
                runtime.frame(state).await.unwrap();
            }
            let seen = runtime.evaluate("window.frames").await.remove(0);
            // Callbacks Chrome ran while the page loaded (before the first frame) are at time 0.
            let frames: Vec<[f64; 4]> = serde_json::from_value::<Vec<[f64; 4]>>(seen)
                .unwrap()
                .into_iter()
                .filter(|frame| frame[0] > 0.0)
                .collect();
            assert_eq!(
                frames.len(),
                count as usize,
                "{fps} fps: one callback per frame"
            );
            for (index, [time, now, precise, full]) in frames.iter().copied().enumerate() {
                let expected = (index + 1) as f64 * step;
                assert!(
                    (time - expected).abs() < 1e-6,
                    "{fps} fps frame {index}: {time}"
                );
                assert_eq!(now, time, "performance.now() is the frame time");
                // The connect document plus one per frame since.
                assert_eq!(
                    precise,
                    index as f64 + 2.0,
                    "{fps} fps frame {index}: precise"
                );
                // The connect document (frame 0) plus one per 150 ms poll.
                assert_eq!(
                    full,
                    (expected / 150.0).floor() + 1.0,
                    "{fps} fps frame {index}: v2"
                );
            }
            let _ = child.kill().await;
            task.abort();
            // Chrome's helper processes may still be leaving the profile: best effort.
            let _ = std::fs::remove_dir_all(root);
        }
    }

    /// Regression: a page whose picture stops changing (a judgement counter
    /// once the counts settle) is captured every frame, in the managed
    /// headless shell and in full Chrome (a custom `VOSU_RENDER_CHROMIUM`),
    /// and both capture the same pixels for the same frame. (The counter is
    /// a bar: generic font families resolve to each browser's own defaults.)
    #[tokio::test]
    async fn still_pages_capture_in_shell_and_full_chrome() {
        let page = r#"<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head>
            <body><div id="n" style="height:40px;width:0;background:#fff;border-radius:6px"></div><script type="module">
            const counter = document.getElementById("n");
            let shown = 0, target = 0, from = 0, start = null;
            const ease = (time) => {
              start ??= time;
              const progress = Math.min(1, (time - start) / 100);
              shown = Math.round(from + (target - from) * progress);
              counter.style.width = `${shown * 9}px`;
              if (progress < 1) requestAnimationFrame(ease);
            };
            const socket = new WebSocket(`ws://${location.host}/websocket/v2/subscribe`);
            socket.onopen = () => socket.send(JSON.stringify(["/play/hits/300"]));
            socket.onmessage = (event) => {
              const value = JSON.parse(event.data)[2][0]?.[1];
              if (typeof value !== "number" || value === target) return;
              from = shown; target = value; start = null;
              requestAnimationFrame(ease);
            };
        </script></body></html>"#;
        let shell = std::env::var_os("VOSU_RENDER_CHROMIUM")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from);
        let (Some(shell), Some(full)) = (shell, full_chrome()) else {
            eprintln!(
                "skipped: needs VOSU_RENDER_CHROMIUM (the headless shell) and full Chrome \
                 (VOSU_TEST_FULL_CHROME, /usr/bin/google-chrome-stable or /usr/bin/chromium)"
            );
            return;
        };
        let mut captures = Vec::new();
        for browser in [shell, full] {
            let (runtime, _origin, root, task) = stand_in(page, true).await;
            let (mut child, endpoint) = launch(&browser, &root).await;
            runtime.debug(endpoint).await;
            let mut frames = Vec::new();
            for frame in 0..90u32 {
                // The count settles at frame 20; the picture is still from frame 24 on.
                let state = json!({"client": "stable", "play": {"mode": {"number": 3},
                    "hits": {"300": frame.min(20)}},
                    "__render": {"wallMs": f64::from(frame) * 1000.0 / 30.0, "epochMs": 0.0}});
                let started = std::time::Instant::now();
                let images = runtime.frame(state).await.unwrap_or_else(|error| {
                    panic!("{}: frame {frame}: {error:?}", browser.display())
                });
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "{}: frame {frame} took {:?}",
                    browser.display(),
                    started.elapsed()
                );
                frames.push(images.into_iter().next().unwrap().png);
            }
            assert!(
                frames[24..].iter().all(|png| *png == frames[24]),
                "{}: the still picture changed",
                browser.display()
            );
            assert_ne!(
                frames[0],
                frames[24],
                "{}: the counter drew",
                browser.display()
            );
            captures.push(frames);
            let _ = child.kill().await;
            task.abort();
            // Chrome's helper processes may still be leaving the profile: best effort.
            let _ = std::fs::remove_dir_all(root);
        }
        for (frame, (shell, full)) in captures[0].iter().zip(&captures[1]).enumerate() {
            assert!(
                shell == full,
                "frame {frame}: the browsers captured different pictures"
            );
        }
    }

    /// Regression: a page that draws with WebGPU is named for the job warning
    /// in full Chrome (whose captures leave WebGPU canvases blank), not in the
    /// headless shell (which captures them).
    #[tokio::test]
    async fn webgpu_pages_are_named_only_in_full_chrome() {
        let page = r#"<!doctype html><html><body><canvas width="64" height="64"></canvas><script type="module">
            window.context = document.querySelector("canvas").getContext("webgpu");
        </script></body></html>"#;
        let shell = std::env::var_os("VOSU_RENDER_CHROMIUM")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from);
        let (Some(shell), Some(full)) = (shell, full_chrome()) else {
            eprintln!(
                "skipped: needs VOSU_RENDER_CHROMIUM (the headless shell) and full Chrome \
                 (VOSU_TEST_FULL_CHROME, /usr/bin/google-chrome-stable or /usr/bin/chromium)"
            );
            return;
        };
        for (browser, named) in [(shell, false), (full, true)] {
            let (runtime, _origin, root, task) = stand_in(page, true).await;
            let (mut child, endpoint) = launch(&browser, &root).await;
            runtime.debug(endpoint).await;
            let state = json!({"client": "stable", "play": {"mode": {"number": 3}},
                "__render": {"wallMs": 0.0, "epochMs": 0.0}});
            runtime.frame(state).await.unwrap();
            let created = runtime.evaluate("!!window.context").await.remove(0);
            assert_eq!(
                created,
                true,
                "{}: WebGPU canvas context",
                browser.display()
            );
            let expected = if named {
                vec![runtime.layers[0].name.clone()]
            } else {
                Vec::new()
            };
            assert_eq!(
                runtime.blank_webgpu().await,
                expected,
                "{}",
                browser.display()
            );
            let _ = child.kill().await;
            task.abort();
            // Chrome's helper processes may still be leaving the profile: best effort.
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn preview_pages_report_webgpu_before_their_own_scripts() {
        let report =
            |html: &str| String::from_utf8(server::with_webgpu_report(html.into())).unwrap();
        let script = r#"<script>(()=>{for(const C of"#;
        let page =
            report("<!DOCTYPE html><HTML lang=en><Head><script>own()</script></head></html>");
        assert!(
            page.starts_with(&format!("<!DOCTYPE html><HTML lang=en><Head>{script}")),
            "{page}"
        );
        assert!(page.ends_with("</script><script>own()</script></head></html>"));
        // `<header>` is not `<head>`; without a head the script follows `<html>`.
        let page = report("<html><body><header>x</header></body></html>");
        assert!(page.starts_with(&format!("<html>{script}")), "{page}");
        let page = report("<!doctype html><p>bare</p>");
        assert!(
            page.starts_with(&format!("<!doctype html>{script}")),
            "{page}"
        );
        assert!(report("<p>fragment</p>").starts_with(script));
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
            ..Default::default()
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
            ..Default::default()
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
