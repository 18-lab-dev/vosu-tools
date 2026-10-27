mod cli;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;
use vosu_map_analysis::{Difficulty, MAX_BYTES, Params, calculate, checksum};
use vosu_tool_sdk::{Client, ToolEnv};

#[derive(Clone)]
struct App {
    database: PathBuf,
    client: Client,
    worker: Arc<Semaphore>,
    queue: Arc<Semaphore>,
}
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<String> for ApiError {
    fn from(e: String) -> Self {
        Self(StatusCode::BAD_REQUEST, e)
    }
}
type Result<T, E = ApiError> = std::result::Result<T, E>;
#[derive(Deserialize)]
struct Options {
    rate: Option<f32>,
    score: Option<f32>,
    systems: Option<String>,
    mode: Option<String>,
    #[serde(default)]
    mods: String,
}
#[derive(Deserialize)]
struct AnalysisOptions {
    #[serde(default = "one")]
    rate: f32,
    #[serde(default = "default_system")]
    system: String,
    window: Option<f32>,
    hop: Option<f32>,
    start: Option<f32>,
    end: Option<f32>,
}
fn default_system() -> String {
    "etterna".into()
}
fn one() -> f32 {
    1.0
}
impl Options {
    fn params(self) -> Result<Params> {
        vosu_map_analysis::analysis::systems(self.systems.as_deref())?;
        Ok(Params::new(self.rate.unwrap_or(1.0), self.score)?)
    }
}
fn db(path: &std::path::Path) -> std::result::Result<rusqlite::Connection, String> {
    rusqlite::Connection::open(path).map_err(|e| e.to_string())
}
fn cached(
    conn: &rusqlite::Connection, md5: &str, bytes: Option<&[u8]>, p: Params,
    mode: Option<&str>, mods: &str,
) -> std::result::Result<Value, String> {
    let stored;
    let bytes = if let Some(bytes) = bytes { bytes } else {
        stored = map_bytes(conn, md5)?;
        &stored
    };
    let official = vosu_map_analysis::official::calculate(bytes, mode, mods, f64::from(p.rate()))?;
    let mut value = serde_json::to_value(cached_mania(conn, md5, Some(bytes), p)?).map_err(|e| e.to_string())?;
    value["stars"] = official["stars"].clone();
    value["mode"] = official["mode"].clone();
    value["unsupported"] = Value::Null;
    value["official"] = official;
    Ok(value)
}
fn cached_mania(
    conn: &rusqlite::Connection,
    md5: &str,
    bytes: Option<&[u8]>,
    p: Params,
) -> std::result::Result<Difficulty, String> {
    use rusqlite::OptionalExtension;
    let key = p.key(md5);
    let value: Option<String> = conn
        .query_row("SELECT result FROM ratings WHERE key=?1", [&key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(value) = value {
        return serde_json::from_str(&value).map_err(|e| e.to_string());
    }
    let stored;
    let bytes = if let Some(bytes) = bytes {
        bytes
    } else {
        stored = conn
            .query_row("SELECT bytes FROM maps WHERE checksum=?1", [md5], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "not calculated".to_string())?;
        &stored
    };
    let result = calculate(bytes, p)?;
    let serialized = serde_json::to_string(&result).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO maps(checksum,bytes) VALUES(?1,?2)",
        rusqlite::params![md5, bytes],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO ratings(key,result) VALUES(?1,?2)",
        rusqlite::params![key, serialized],
    )
    .map_err(|e| e.to_string())?;
    Ok(result)
}
impl App {
    async fn targets(&self, mut value: Value) -> Value {
        let checksum = value["checksum"].as_str().unwrap_or_default().to_owned();
        let bytes = self.work(move |conn| map_bytes(&conn, &checksum)).await;
        let result = match bytes {
            Ok(bytes) => vosu_tool_sdk::send_json::<Value>(self.client.tool(
                vosu_tool_sdk::cli::Method::POST, "server-pp", &format!("v1/targets?mode={}&mods={}&rate={}",
                    value["mode"].as_str().unwrap_or("osu"), value["official"]["mods"], value["rate"]))
                .body(bytes)).await.map_err(|e| e.to_string()),
            Err(_) => Err("map bytes unavailable".into()),
        };
        value["performance"] = match result {
            Ok(result) => result,
            Err(_) => json!({"reason":"PP targets unavailable: enable the optional Server pp calculator tool."}),
        };
        value
    }

    async fn work<T: Send + 'static>(
        &self,
        f: impl FnOnce(rusqlite::Connection) -> std::result::Result<T, String> + Send + 'static,
    ) -> Result<T> {
        let queue = self.queue.clone().try_acquire_owned().map_err(|_| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "calculation queue full".into(),
            )
        })?;
        // Serialize native calculators to bound their large working sets. The
        // cache is rechecked after acquiring this permit, coalescing identical work.
        let worker = self
            .worker
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let path = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let _permits = (queue, worker);
            f(db(&path)?)
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| {
            ApiError(
                if e == "not calculated" {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                },
                e,
            )
        })
    }
}
async fn submit(
    State(app): State<App>,
    Query(options): Query<Options>,
    bytes: Bytes,
) -> Result<Json<Value>> {
    let mode = options.mode.clone();
    let mods = options.mods.clone();
    let p = options.params()?;
    let value = app.work(move |conn| cached(&conn, &checksum(&bytes), Some(&bytes), p, mode.as_deref(), &mods))
        .await
        ?;
    Ok(Json(app.targets(value).await))
}
async fn file_bytes(State(app): State<App>, Path(md5): Path<String>) -> Result<Bytes> {
    app.work(move |conn| map_bytes(&conn, &md5)).await.map(Bytes::from)
}
async fn lookup(
    State(app): State<App>,
    Path(md5): Path<String>,
    Query(options): Query<Options>,
) -> Result<Json<Value>> {
    let mode = options.mode.clone();
    let mods = options.mods.clone();
    let p = options.params()?;
    let value = app.work(move |conn| cached(&conn, &md5, None, p, mode.as_deref(), &mods))
        .await
        ?;
    Ok(Json(app.targets(value).await))
}
async fn current(
    State(app): State<App>,
    Query(mut options): Query<Options>,
) -> Result<Json<Value>> {
    if options.mode.is_none() || options.mods.is_empty() || options.rate.is_none() {
        let telemetry: Value = app.client.get_json("/json/v2").await
            .map_err(|e| ApiError(StatusCode::BAD_GATEWAY,e.to_string()))?;
        if options.mode.is_none() {
            options.mode = (if telemetry["state"]["number"] == 2 { telemetry["play"]["mode"]["name"].as_str() } else { None })
                .or_else(||telemetry["settings"]["mode"]["name"].as_str())
                .or_else(||telemetry["beatmap"]["mode"]["name"].as_str()).map(str::to_owned);
        }
        if options.mods.is_empty() { options.mods=telemetry["play"]["mods"]["name"].as_str().unwrap_or("NM").to_owned(); }
        if options.rate.is_none() { options.rate=telemetry["play"]["mods"]["rate"].as_f64().map(|rate| rate as f32); }
    }
    let mode = options.mode.clone();
    let mods = options.mods.clone();
    let p = options.params()?;
    let map = app
        .client
        .context()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?
        .beatmap
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no selected beatmap".into()))?;
    let value = app.work(move |conn| {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(map.file)
            .map_err(|e| e.to_string())?
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        cached(&conn, &checksum(&bytes), Some(&bytes), p, mode.as_deref(), &mods)
    })
    .await
    ?;
    Ok(Json(app.targets(value).await))
}
fn map_bytes(conn: &rusqlite::Connection, md5: &str) -> std::result::Result<Vec<u8>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT bytes FROM maps WHERE checksum=?1", [md5], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "not calculated".into())
}
async fn timeline(
    State(app): State<App>,
    Path(md5): Path<String>,
    Query(options): Query<AnalysisOptions>,
) -> Result<Json<Value>> {
    let p = Params::new(options.rate, None)?;
    let local = options.system == "etterna";
    let window = options.window.unwrap_or(if local { 12.0 } else { 1.0 });
    let hop = options.hop.unwrap_or(if local { 1.0 } else { 0.25 });
    app.work(move |conn| cached_timeline(&conn, &md5, p, &options.system, window, hop))
        .await
        .map(Json)
}

fn cached_timeline(
    conn: &rusqlite::Connection,
    md5: &str,
    p: Params,
    system: &str,
    window: f32,
    hop: f32,
) -> std::result::Result<Value, String> {
    use rusqlite::OptionalExtension;
    let key = format!(
        "{}:{system}:{:08x}:{:08x}:centered-rebased-v1",
        p.key(md5),
        window.to_bits(),
        hop.to_bits()
    );
    let stored: Option<String> = conn
        .query_row("SELECT result FROM timelines WHERE key=?1", [&key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(value) = stored {
        return serde_json::from_str(&value).map_err(|e| e.to_string());
    }
    let result =
        vosu_map_analysis::analysis::timeline(&map_bytes(conn, md5)?, p, system, window, hop)?;
    let serialized = serde_json::to_string(&result).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO timelines(key,result) VALUES(?1,?2)",
        rusqlite::params![key, serialized],
    )
    .map_err(|e| e.to_string())?;
    Ok(result)
}
async fn section(
    State(app): State<App>,
    Path(md5): Path<String>,
    Query(options): Query<AnalysisOptions>,
) -> Result<Json<Value>> {
    let p = Params::new(options.rate, None)?;
    let start = options
        .start
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "missing start (seconds)".into()))?;
    let end = options
        .end
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "missing end (seconds)".into()))?;
    app.work(move |conn| {
        vosu_map_analysis::analysis::section(&map_bytes(&conn, &md5)?, p, start, end)
    })
    .await
    .map(Json)
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("cli") {
        if let Err(error) = cli::run().await {
            eprintln!("vosux map-analysis: {error}");
            std::process::exit(1);
        }
        return Ok(());
    }
    let env = ToolEnv::from_env()?;
    std::fs::create_dir_all(&env.data_dir)?;
    let database = env.data_dir.join("ratings.sqlite3");
    let conn = rusqlite::Connection::open(&database)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS maps(checksum TEXT PRIMARY KEY,bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS ratings(key TEXT PRIMARY KEY,result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS timelines(key TEXT PRIMARY KEY,result TEXT NOT NULL);")?;
    drop(conn);
    let app = App {
        database,
        client: env.client(),
        worker: Arc::new(Semaphore::new(1)),
        queue: Arc::new(Semaphore::new(16)),
    };
    let router = Router::new()
        .route("/v1/calculate", post(submit))
        .route("/v1/beatmap/current", get(current))
        .route("/v1/beatmap/{md5}", get(lookup))
        .route("/v1/beatmap/{md5}/file", get(file_bytes))
        .route("/v1/beatmap/{md5}/timeline", get(timeline))
        .route("/v1/beatmap/{md5}/section", get(section))
        .layer(DefaultBodyLimit::max(MAX_BYTES))
        .with_state(app);
    vosu_tool_sdk::serve(&env, router).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_is_durable_and_separates_parameters() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cache.sqlite3");
        let conn = db(&path).unwrap();
        conn.execute_batch("CREATE TABLE maps(checksum TEXT PRIMARY KEY,bytes BLOB NOT NULL); CREATE TABLE ratings(key TEXT PRIMARY KEY,result TEXT NOT NULL);").unwrap();
        let bytes = include_bytes!("../tests/fixtures/cyclic.osu");
        let hash = checksum(bytes);
        let p = Params::new(1.0, None).unwrap();
        cached(&conn, &hash, Some(bytes), p).unwrap();
        drop(conn);
        let conn = db(&path).unwrap();
        let d = cached(&conn, &hash, None, p).unwrap();
        assert_eq!(d.checksum, hash);
        let ssr = cached(&conn, &hash, None, Params::new(1.1, Some(0.95)).unwrap()).unwrap();
        assert!(ssr.ssr.is_some());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM ratings", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            cached(&conn, "missing", None, p).unwrap_err(),
            "not calculated"
        );
    }
    #[test]
    fn timeline_cache_is_durable_and_separates_rate_window_hop_system() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cache.sqlite3");
        let conn = db(&path).unwrap();
        conn.execute_batch("CREATE TABLE maps(checksum TEXT PRIMARY KEY,bytes BLOB NOT NULL); CREATE TABLE ratings(key TEXT PRIMARY KEY,result TEXT NOT NULL); CREATE TABLE timelines(key TEXT PRIMARY KEY,result TEXT NOT NULL);").unwrap();
        let bytes = include_bytes!("../tests/fixtures/mixed7.osu");
        let hash = checksum(bytes);
        let p = Params::new(1.0, None).unwrap();
        cached(&conn, &hash, Some(bytes), p).unwrap();
        let first = cached_timeline(&conn, &hash, p, "etterna", 12.0, 1.0).unwrap();
        drop(conn);
        let conn = db(&path).unwrap();
        assert_eq!(
            first,
            cached_timeline(&conn, &hash, p, "etterna", 12.0, 1.0).unwrap()
        );
        for (rate, system, window, hop) in [
            (1.5, "etterna", 12.0, 1.0),
            (1.0, "etterna", 8.0, 1.0),
            (1.0, "etterna", 12.0, 2.0),
            (1.0, "etterna-native", 12.0, 1.0),
        ] {
            cached_timeline(
                &conn,
                &hash,
                Params::new(rate, None).unwrap(),
                system,
                window,
                hop,
            )
            .unwrap();
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM timelines", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            5
        );
    }
}
