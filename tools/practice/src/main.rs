mod cli;
mod profiles;
mod store;
use osu_file::{audio, map, mods};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use vosu_tool_sdk::{Client, ToolEnv};

#[derive(Clone)]
struct App {
    env: ToolEnv,
    client: Client,
    jobs: Arc<Mutex<BTreeMap<String, Job>>>,
    serial: Arc<AtomicU64>,
    mutation: Arc<tokio::sync::Mutex<()>>,
}
struct Job {
    snapshot: Value,
    cancel: Arc<AtomicBool>,
}
type ApiError = (StatusCode, Json<Value>);
fn error(e: impl std::fmt::Display) -> ApiError {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":e.to_string()})),
    )
}

/// Dashboard-editable settings (`settings.json`); missing values use these defaults.
#[derive(Deserialize)]
#[serde(default)]
pub struct Settings {
    pub lead_in_ms: f64,
    pub lead_out_ms: f64,
    pub gap_ms: f64,
    pub fade_ms: f64,
    pub pitch_with_rate: bool,
    pub export_dir: String,
    pub map_analysis_timeline: bool,
}
impl Default for Settings {
    fn default() -> Self {
        let options = map::Options::default();
        Self {
            lead_in_ms: options.lead_in_ms,
            lead_out_ms: options.lead_out_ms,
            gap_ms: options.gap_ms,
            fade_ms: options.fade_ms,
            pitch_with_rate: !options.pitch_preserving,
            export_dir: String::new(),
            map_analysis_timeline: true,
        }
    }
}
impl Settings {
    /// Options for a page with no saved profile.
    fn defaults(&self) -> map::Options {
        map::Options {
            lead_in_ms: self.lead_in_ms,
            lead_out_ms: self.lead_out_ms,
            gap_ms: self.gap_ms,
            fade_ms: self.fade_ms,
            pitch_preserving: !self.pitch_with_rate,
            ..Default::default()
        }
    }
    /// Lazer exports go to this folder when set; it must already exist.
    pub fn export_dir(&self) -> anyhow::Result<Option<PathBuf>> {
        let raw = self.export_dir.trim();
        if raw.is_empty() {
            return Ok(None);
        }
        let path = PathBuf::from(raw);
        anyhow::ensure!(
            path.is_absolute() && path.is_dir(),
            "the lazer export folder setting must be an existing absolute folder"
        );
        Ok(Some(path))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("cli") {
        if let Err(error) = cli::run().await {
            eprintln!("vosux practice: {error}");
            std::process::exit(1);
        }
        return Ok(());
    }
    let env = ToolEnv::from_env()?;
    std::fs::create_dir_all(&env.data_dir)?;
    let app = App {
        client: env.client(),
        env: env.clone(),
        jobs: Arc::default(),
        serial: Arc::default(),
        mutation: Arc::default(),
    };
    let router = Router::new()
        .route("/v1/current", get(current))
        .route("/v1/timeline", get(timeline))
        .route("/v1/preview", get(preview))
        .route("/v1/profiles", get(list_profiles).post(save_profile))
        .route("/v1/profiles/activate", post(activate_profile))
        .route("/v1/profiles/delete", post(delete_profile))
        .route("/v1/generated", get(generated))
        .route("/v1/generate", post(generate))
        .route("/v1/delete/{id}", post(delete))
        .route("/v1/jobs/{id}", get(job).delete(cancel))
        .with_state(app);
    vosu_tool_sdk::serve(&env, router).await?;
    Ok(())
}

async fn settings(app: &App) -> Settings {
    app.client.settings().await.unwrap_or_default()
}

/// The selected map's text and context, or 404-style errors the UI shows as-is.
async fn selected(app: &App) -> Result<(vosu_tool_sdk::Context, String), ApiError> {
    let ctx = app.client.context().await.map_err(error)?;
    let b = ctx
        .beatmap
        .as_ref()
        .ok_or_else(|| error("no selected beatmap"))?;
    let text = std::fs::read_to_string(&b.file).map_err(error)?;
    Ok((ctx, text))
}

fn rate_query(query: &BTreeMap<String, String>) -> Result<f64, ApiError> {
    let rate = query
        .get("rate")
        .map(|s| s.parse::<f64>())
        .transpose()
        .map_err(error)?
        .unwrap_or(1.0);
    if !(0.5..=2.0).contains(&rate) {
        return Err(error("rate must be 0.5–2.0"));
    }
    Ok(rate)
}

fn ruleset(text: &str) -> &'static str {
    match map::value(text, "[General]", "Mode").as_deref() {
        Some("1") => "taiko",
        Some("2") => "fruits",
        Some("3") => "mania",
        _ => "osu",
    }
}

/// Every statistic the UI may show; it picks the ones its ruleset uses.
fn stats(text: &str) -> anyhow::Result<Value> {
    let (objects, end) = mods::summary(text)?;
    let ruleset = ruleset(text);
    Ok(json!({
        "ruleset": ruleset,
        "objects": objects,
        "length_ms": end,
        "bpm": map::bpm(text)?,
        "hp": stat(text, "HPDrainRate"),
        "cs": stat(text, "CircleSize"),
        "ar": stat(text, "ApproachRate"),
        "od": stat(text, "OverallDifficulty"),
        // The key count lazer plays (the `mania-keys` rule shared with the web UIs).
        "keys": (ruleset == "mania")
            .then(|| mania_keys::key_count_of(map::value(text, "[Difficulty]", "CircleSize").as_deref()).ok())
            .flatten(),
    }))
}

/// Whether `bytes` are the beatmap with this MD5 checksum (always true
/// without a checksum).
fn checksum_matches(bytes: &[u8], checksum: &str) -> bool {
    use md5::{Digest, Md5};
    let digest: String = Md5::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    checksum.is_empty() || digest.eq_ignore_ascii_case(checksum)
}

async fn current(
    State(app): State<App>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let rate = rate_query(&query)?;
    let ctx = app.client.context().await.map_err(error)?;
    let Some(b) = &ctx.beatmap else {
        return Ok(Json(json!({"client":ctx.client,"beatmap":null})));
    };
    let bytes = std::fs::read(&b.file).map_err(error)?;
    // Right after a selection change the file can still be the previous
    // difficulty's; the UI retries on 409 until it matches the checksum.
    if !checksum_matches(&bytes, &b.checksum) {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"the beatmap file does not match the selected checksum yet"})),
        ));
    }
    let text = String::from_utf8(bytes).map_err(error)?;
    let ratings = if ruleset(&text) == "mania" {
        app.client
            .tool_json::<Value>("map-analysis", &format!("v1/beatmap/current?rate={rate}"))
            .await
            .ok()
    } else {
        None
    };
    let meta = |key| map::value(&text, "[Metadata]", key);
    Ok(Json(json!({
        "client": ctx.client,
        "beatmap": {
            "md5": b.checksum,
            "title": meta("Title"),
            "artist": meta("Artist"),
            "creator": meta("Creator"),
            "version": meta("Version"),
            "played_ruleset": b.mode,
            "background": b.background.as_ref().is_some_and(|p| p.is_file()),
            "stats": stats(&text).map_err(error)?,
        },
        "ratings": ratings,
    })))
}

/// Difficulty over source time for the trim strip: map-analysis' local MSD for
/// mania maps when that tool answers, otherwise notes per second.
async fn timeline(
    State(app): State<App>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let rate = rate_query(&query)?;
    let (ctx, text) = selected(&app).await?;
    let spans = mods::spans(&text).map_err(error)?;
    let starts: Vec<f64> = spans.iter().map(|s| s.0).collect();
    let duration = spans.iter().fold(0.0_f64, |a, s| a.max(s.1));
    let mut note = None;
    if ruleset(&text) == "mania" {
        if settings(&app).await.map_analysis_timeline {
            let md5 = &ctx.beatmap.as_ref().expect("selected").checksum;
            match msd_timeline(&app, md5, rate).await {
                Ok(points) => {
                    return Ok(Json(json!({
                        "source": "map-analysis",
                        "label": "Local MSD",
                        "duration_ms": duration,
                        "points": points,
                        "objects": starts,
                    })));
                }
                Err(e) => {
                    note = Some(format!(
                        "Map analysis unavailable ({e}); showing notes per second."
                    ))
                }
            }
        } else {
            note = Some(
                "Map analysis timeline is turned off in settings; showing notes per second."
                    .into(),
            );
        }
    }
    // 2 s centred window every 250 ms, in notes per playback second at `rate`.
    let mut points = Vec::new();
    let mut t = 0.0;
    while t <= duration {
        let lo = starts.partition_point(|s| *s < t - 1000.0);
        let hi = starts.partition_point(|s| *s < t + 1000.0);
        points.push([t, (hi - lo) as f64 / 2.0 * rate]);
        t += 250.0;
    }
    Ok(Json(json!({
        "source": "nps",
        "label": "Notes per second",
        "note": note,
        "duration_ms": duration,
        "points": points,
        "objects": starts,
    })))
}

async fn msd_timeline(app: &App, md5: &str, rate: f64) -> anyhow::Result<Vec<[f64; 2]>> {
    // Looking the map up first makes map-analysis store it for the timeline.
    app.client
        .tool_json::<Value>("map-analysis", &format!("v1/beatmap/current?rate={rate}"))
        .await?;
    let v: Value = app
        .client
        .tool_json(
            "map-analysis",
            &format!("v1/beatmap/{md5}/timeline?rate={rate}&system=etterna&hop=1"),
        )
        .await?;
    let points = v["points"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("timeline has no points"))?
        .iter()
        .filter_map(|p| Some([p["time"].as_f64()? * 1000.0, p["value"].as_f64()?]))
        .collect::<Vec<_>>();
    anyhow::ensure!(!points.is_empty(), "empty timeline");
    Ok(points)
}

fn stat(text: &str, key: &str) -> f64 {
    map::value(text, "[Difficulty]", key)
        .or_else(|| {
            if key == "ApproachRate" {
                map::value(text, "[Difficulty]", "OverallDifficulty")
            } else {
                None
            }
        })
        .and_then(|s| s.parse().ok())
        .unwrap_or(5.0)
}

/// Result of the current options without writing anything; read-only pages can
/// preview too. `options` is the JSON options object.
async fn preview(
    State(app): State<App>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let options: map::Options = serde_json::from_str(
        query
            .get("options")
            .ok_or_else(|| error("missing options"))?,
    )
    .map_err(error)?;
    let (_, text) = selected(&app).await?;
    let options = map::effective(&options, &text).map_err(error)?;
    let output = map::transform(&text, &options, "preview.ogg").map_err(error)?;
    Ok(Json(json!({
        "stats": stats(&output.text).map_err(error)?,
        "version": map::value(&output.text, "[Metadata]", "Version"),
        "rate": options.rate,
        "windows": output.windows,
        "warnings": output.warnings,
        "osu": output.text,
    })))
}

async fn list_profiles(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let profiles = profiles::load(&app.env.data_dir).map_err(error)?;
    Ok(Json(profiles_json(&profiles, &settings(&app).await)))
}
fn profiles_json(profiles: &profiles::Profiles, settings: &Settings) -> Value {
    json!({
        "active": profiles.active,
        "profiles": profiles.profiles,
        "defaults": settings.defaults(),
    })
}
#[derive(Deserialize)]
struct SaveProfile {
    name: String,
    options: map::Options,
}
async fn save_profile(
    State(app): State<App>,
    Json(body): Json<SaveProfile>,
) -> Result<Json<Value>, ApiError> {
    // Profiles serve every ruleset, so mods are checked against each map when it
    // is generated; the numeric bounds are checked now so a profile always loads.
    map::effective(
        &map::Options {
            mods: Vec::new(),
            target_bpm: None,
            ..body.options.clone()
        },
        "[General]\nMode: 0\n",
    )
    .map_err(error)?;
    let _guard = app.mutation.lock().await;
    let profiles = profiles::save(&app.env.data_dir, &body.name, body.options).map_err(error)?;
    Ok(Json(profiles_json(&profiles, &settings(&app).await)))
}
#[derive(Deserialize)]
struct ProfileName {
    name: String,
}
async fn activate_profile(
    State(app): State<App>,
    Json(body): Json<ProfileName>,
) -> Result<Json<Value>, ApiError> {
    let _guard = app.mutation.lock().await;
    let profiles = profiles::activate(&app.env.data_dir, &body.name).map_err(error)?;
    Ok(Json(profiles_json(&profiles, &settings(&app).await)))
}
async fn delete_profile(
    State(app): State<App>,
    Json(body): Json<ProfileName>,
) -> Result<Json<Value>, ApiError> {
    let _guard = app.mutation.lock().await;
    let profiles = profiles::delete(&app.env.data_dir, &body.name).map_err(error)?;
    Ok(Json(profiles_json(&profiles, &settings(&app).await)))
}

async fn generated(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        serde_json::to_value(store::load(&app.env.data_dir).map_err(error)?).map_err(error)?,
    ))
}
async fn delete(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let _guard = app.mutation.lock().await;
    store::delete(&app.env.data_dir, &id).map_err(error)?;
    Ok(Json(json!({"deleted":id})))
}
async fn job(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    app.jobs
        .lock()
        .unwrap()
        .get(&id)
        .map(|j| Json(j.snapshot.clone()))
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(json!({"error":"unknown job"}))))
}
async fn cancel(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let jobs = app.jobs.lock().unwrap();
    let j = jobs.get(&id).ok_or_else(|| error("unknown job"))?;
    j.cancel.store(true, Ordering::Relaxed);
    Ok(Json(json!({"cancelled":id})))
}
async fn generate(
    State(app): State<App>,
    Json(options): Json<map::Options>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (ctx, text) = selected(&app).await?;
    let options = map::effective(&options, &text).map_err(error)?;
    // Surface trim and transform errors now rather than in a failed job.
    map::transform(&text, &options, "check.ogg").map_err(error)?;
    let export_dir = settings(&app).await.export_dir().map_err(error)?;
    let id = app.serial.fetch_add(1, Ordering::Relaxed).to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = app.jobs.lock().unwrap();
        if jobs.len() >= 100 {
            let expired = jobs
                .iter()
                .find(|(_, j)| {
                    matches!(
                        j.snapshot["state"].as_str(),
                        Some("done" | "failed" | "cancelled")
                    )
                })
                .map(|(k, _)| k.clone());
            if let Some(k) = expired {
                jobs.remove(&k);
            } else {
                return Err(error("too many active jobs"));
            }
        }
        jobs.insert(id.clone(),Job{snapshot:json!({"state":"queued","progress":0.0,"message":"Waiting","result":null}),cancel:cancel.clone()});
    }
    let task_id = id.clone();
    tokio::spawn(async move {
        let _guard = app.mutation.clone().lock_owned().await;
        let worker = app.clone();
        let worker_id = task_id.clone();
        let token = cancel.clone();
        let result = tokio::task::spawn_blocking(move || {
            store::generate(
                &worker.env.data_dir,
                export_dir.as_deref(),
                &ctx,
                &options,
                &token,
                |p, m| {
                    if let Some(j) = worker.jobs.lock().unwrap().get_mut(&worker_id) {
                        j.snapshot =
                            json!({"state":"running","progress":p,"message":m,"result":null});
                    }
                },
            )
        })
        .await;
        let snapshot = match result {
            Ok(Ok(entry)) => {
                json!({"state":"done","progress":1.0,"message":if entry.export {"Export ready — import the .osz in lazer."}else{"Map ready — refresh the song list in osu! (F5)."},"result":entry})
            }
            Ok(Err(e)) => {
                json!({"state":if cancel.load(Ordering::Relaxed){"cancelled"}else{"failed"},"progress":0.0,"message":e.to_string(),"result":null})
            }
            Err(e) => {
                json!({"state":"failed","progress":0.0,"message":e.to_string(),"result":null})
            }
        };
        if let Some(j) = app.jobs.lock().unwrap().get_mut(&task_id) {
            j.snapshot = snapshot;
        }
    });
    Ok((StatusCode::ACCEPTED, Json(json!({"job":id}))))
}

#[cfg(test)]
mod tests;
