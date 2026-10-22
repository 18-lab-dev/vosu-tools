mod cli;
mod store;
use osu_file::{audio, map};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
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
        .route("/v1/settings", get(settings).post(save_settings))
        .route("/v1/preview", post(preview))
        .route("/v1/generated", get(generated))
        .route("/v1/generate", post(generate))
        .route("/v1/delete/{id}", post(delete))
        .route("/v1/jobs/{id}", get(job).delete(cancel))
        .with_state(app);
    vosu_tool_sdk::serve(&env, router).await?;
    Ok(())
}
async fn current(
    State(app): State<App>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let ctx = app.client.context().await.map_err(error)?;
    let Some(b) = &ctx.beatmap else {
        return Ok(Json(json!({"beatmap":null})));
    };
    let text = std::fs::read_to_string(&b.file).map_err(error)?;
    let rate = query
        .get("rate")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(1.0);
    if !(0.5..=2.0).contains(&rate) {
        return Err(error("invalid rate"));
    }
    let ratings = app
        .client
        .tool_json::<Value>("mania-ratings", &format!("v1/beatmap/current?rate={rate}"))
        .await
        .ok();
    Ok(Json(
        json!({"client":ctx.client,"beatmap":{"title":map::value(&text,"[Metadata]","Title"),"artist":map::value(&text,"[Metadata]","Artist"),"version":map::value(&text,"[Metadata]","Version"),"mode":b.mode,"bpm":map::bpm(&text).map_err(error)?,"hp":stat(&text,"HPDrainRate"),"cs":stat(&text,"CircleSize"),"ar":stat(&text,"ApproachRate"),"od":stat(&text,"OverallDifficulty")},"ratings":ratings}),
    ))
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

async fn settings(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let path = app.env.data_dir.join("settings.json");
    let options: map::Options = if path.exists() {
        serde_json::from_slice(&std::fs::read(path).map_err(error)?).map_err(error)?
    } else {
        map::Options::default()
    };
    Ok(Json(serde_json::to_value(options).map_err(error)?))
}

async fn save_settings(
    State(app): State<App>,
    Json(options): Json<map::Options>,
) -> Result<Json<Value>, ApiError> {
    let _guard = app.mutation.lock().await;
    let temporary = app.env.data_dir.join("settings.json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&options).map_err(error)?,
    )
    .map_err(error)?;
    std::fs::rename(temporary, app.env.data_dir.join("settings.json")).map_err(error)?;
    Ok(Json(json!({"saved":true})))
}

async fn preview(
    State(app): State<App>,
    Json(options): Json<map::Options>,
) -> Result<Json<Value>, ApiError> {
    let ctx = app.client.context().await.map_err(error)?;
    let beatmap = ctx
        .beatmap
        .as_ref()
        .ok_or_else(|| error("no selected beatmap"))?;
    let text = std::fs::read_to_string(&beatmap.file).map_err(error)?;
    let options = map::effective(&options, &text).map_err(error)?;
    let output = map::transform(&text, &options, "preview.ogg").map_err(error)?;
    let summary = osu_file::mods::summary(&output).map_err(error)?;
    Ok(Json(
        json!({"duration_ms":summary.1,"objects":summary.0,"bpm":map::bpm(&output).map_err(error)?,"hp":stat(&output,"HPDrainRate"),"cs":stat(&output,"CircleSize"),"ar":stat(&output,"ApproachRate"),"od":stat(&output,"OverallDifficulty"),"version":map::value(&output,"[Metadata]","Version")}),
    ))
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
    let ctx = app.client.context().await.map_err(error)?;
    let b = ctx
        .beatmap
        .as_ref()
        .ok_or_else(|| error("no selected beatmap"))?;
    let text = std::fs::read_to_string(&b.file).map_err(error)?;
    let options = map::effective(&options, &text).map_err(error)?;
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
            store::generate(&worker.env.data_dir, &ctx, &options, &token, |p, m| {
                if let Some(j) = worker.jobs.lock().unwrap().get_mut(&worker_id) {
                    j.snapshot = json!({"state":"running","progress":p,"message":m,"result":null});
                }
            })
        })
        .await;
        let snapshot = match result {
            Ok(Ok(entry)) => {
                json!({"state":"done","progress":1.0,"message":if entry.export {"Export ready — import the .osz in lazer."}else{"Practice copy ready."},"result":entry})
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
