mod engine;
#[cfg(test)]
mod tests;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use clap::Parser;
use engine::{Cache, Input, Map};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::io::AsyncReadExt;
use vosu_tool_sdk::{
    Client, ToolEnv,
    cli::{Method, number, print_result, table, text},
};

type ApiError = (StatusCode, Json<Value>);
fn bad(message: impl ToString) -> ApiError {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":message.to_string()})),
    )
}
#[derive(Clone)]
struct App {
    client: Client,
    cache: Arc<Mutex<Cache>>,
    dir: PathBuf,
}
impl App {
    fn cached(&self, i: &Input) -> Result<Option<Arc<Map>>, ApiError> {
        let Some(checksum) = i.checksum.as_deref() else {
            return Ok(None);
        };
        Ok(self
            .cache
            .lock()
            .map_err(|_| bad("cache unavailable"))?
            .get(&i.server, checksum, engine::mods(&i.mods).map_err(bad)?))
    }
    fn insert(&self, i: &Input, map: Arc<Map>) -> Result<(), ApiError> {
        self.cache
            .lock()
            .map_err(|_| bad("cache unavailable"))?
            .insert(&i.server, engine::mods(&i.mods).map_err(bad)?, map);
        Ok(())
    }
    async fn selected(&self, i: &Input) -> Result<Arc<Map>, ApiError> {
        if let Some(map) = self.cached(i)? {
            return Ok(map);
        }
        let response = self
            .client
            .request(Method::GET, "/files/beatmap/file")
            .send()
            .await
            .map_err(bad)?;
        if !response.status().is_success() {
            return Err(bad(
                "no selected beatmap; POST .osu bytes to /v1/calculate first",
            ));
        }
        let bytes = response.bytes().await.map_err(bad)?;
        let map = Arc::new(Map::parse(&bytes).map_err(bad)?);
        if i.checksum.as_ref().is_some_and(|v| v != &map.checksum) {
            return Err((
                StatusCode::NOT_FOUND,
                Json(json!({"error":"checksum not cached or selected; upload the map first"})),
            ));
        }
        self.insert(i, map.clone())?;
        Ok(map)
    }
    async fn output(&self, map: Arc<Map>, i: Input) -> Result<Json<Value>, ApiError> {
        let mut result = engine::calculate(&map, &i).map_err(bad)?;
        result["official"] = match self.official(&map, &i).await {
            Ok(v) => json!({"available":true,"result":v}),
            Err(e) => json!({"available":false,"reason":e}),
        };
        Ok(Json(result))
    }
    async fn official(&self, map: &Map, i: &Input) -> Result<Value, String> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|e| e.to_string())?;
        let path = self.dir.join(format!(
            "official-{}-{}.osu",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        tokio::fs::write(&path, &map.bytes)
            .await
            .map_err(|e| e.to_string())?;
        let mut query = vec![
            ("path", path.to_string_lossy().into_owned()),
            ("lazer", "false".into()),
            ("mods", engine::mods(&i.mods)?.to_string()),
            ("nMisses", i.misses.to_string()),
        ];
        macro_rules! field {
            ($key:literal,$v:expr) => {
                if let Some(v) = $v {
                    query.push(($key, v.to_string()))
                }
            };
        }
        field!("acc", i.acc);
        field!("combo", i.combo);
        field!("n300", i.n300);
        field!("n100", i.n100);
        field!("n50", i.n50);
        field!("nGeki", i.n_geki);
        field!("nKatu", i.n_katu);
        field!("passedObjects", i.passed_objects);
        let result = vosu_tool_sdk::send_json(
            self.client
                .request(Method::GET, "/api/calculate/pp")
                .query(&query),
        )
        .await
        .map_err(|e| e.to_string());
        let _ = tokio::fs::remove_file(&path).await;
        result
    }
}
async fn pp(State(app): State<App>, Query(i): Query<Input>) -> Result<Json<Value>, ApiError> {
    let map = app.selected(&i).await?;
    app.output(map, i).await
}
async fn upload(
    State(app): State<App>,
    Query(i): Query<Input>,
    bytes: Bytes,
) -> Result<Json<Value>, ApiError> {
    let map = Arc::new(Map::parse(&bytes).map_err(bad)?);
    if i.checksum.as_ref().is_some_and(|v| v != &map.checksum) {
        return Err(bad("checksum mismatch"));
    }
    engine::calculate(&map, &i).map_err(bad)?;
    app.insert(&i, map.clone())?;
    app.output(map, i).await
}
fn count(v: &Value, key: &str) -> Result<u32, ApiError> {
    v[key]
        .as_u64()
        .and_then(|n| n.try_into().ok())
        .ok_or_else(|| bad(format!("live state missing valid {key}")))
}
async fn current(
    State(app): State<App>,
    Query(mut i): Query<Input>,
) -> Result<Json<Value>, ApiError> {
    let live: Value = app.client.get_json("/json/v2").await.map_err(bad)?;
    let play = &live["play"];
    i.mods = count(&play["mods"], "number")?.to_string();
    i.acc = None;
    i.combo = Some(count(&play["combo"], "current")?);
    let hits = &play["hits"];
    i.n300 = Some(count(hits, "300")?);
    i.n100 = Some(count(hits, "100")?);
    i.n50 = Some(count(hits, "50")?);
    i.n_geki = Some(count(hits, "geki")?);
    i.n_katu = Some(count(hits, "katu")?);
    i.misses = count(hits, "0")?;
    let mode = count(&play["mode"], "number")?;
    i.passed_objects = Some(
        match mode {
            0 | 1 => [i.n300, i.n100, i.n50, None, None, Some(i.misses)],
            2 => [i.n300, i.n100, None, None, None, Some(i.misses)],
            _ => [i.n300, i.n100, i.n50, i.n_geki, i.n_katu, Some(i.misses)],
        }
        .into_iter()
        .flatten()
        .try_fold(0u32, |a, b| a.checked_add(b))
        .ok_or_else(|| bad("invalid live hit total"))?,
    );
    i.checksum = live["beatmap"]["checksum"].as_str().map(str::to_owned);
    if i.checksum.is_none() {
        return Err(bad("live beatmap checksum unavailable"));
    }
    let map = app.selected(&i).await?;
    let mode = map.akatsuki.mode as u8;
    // A native-map-only profile cannot silently score a ruleset conversion.
    if live["play"]["mode"]["number"]
        .as_u64()
        .is_some_and(|v| v != mode as u64)
    {
        return Err(bad("ruleset conversions are not supported"));
    }
    app.output(map, i).await
}
fn router(app: App) -> Router {
    Router::new()
        .route("/v1/servers", get(|| async { Json(engine::servers()) }))
        .route("/v1/pp", get(pp))
        .route("/v1/current", get(current))
        .route("/v1/calculate", post(upload))
        .with_state(app)
}

#[derive(Parser)]
#[command(
    about = "Pinned public server calculator snapshots, not guaranteed live deployment parity"
)]
struct Args {
    /// .osu file, '-' for stdin, 'servers' to list profiles; omitted uses live state
    file: Option<String>,
    #[arg(long, default_value = "akatsuki")]
    server: String,
    #[arg(long, default_value = "NM")]
    mods: String,
    #[arg(long)]
    acc: Option<f64>,
    #[arg(long)]
    combo: Option<u32>,
    #[arg(long, default_value_t = 0)]
    misses: u32,
    #[arg(long)]
    json: bool,
}
async fn cli(env: &ToolEnv, args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let client = env.client();
    let value: Value = if args.file.as_deref() == Some("servers") {
        client.own_json("v1/servers").await?
    } else {
        let i = Input {
            server: args.server,
            mods: args.mods,
            acc: args.acc,
            combo: args.combo,
            misses: args.misses,
            ..Input::default()
        };
        if let Some(file) = args.file {
            let bytes = if file == "-" {
                let mut b = Vec::new();
                tokio::io::stdin()
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut b)
                    .await?;
                b
            } else {
                let mut b = Vec::new();
                tokio::fs::File::open(file)
                    .await?
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut b)
                    .await?;
                b
            };
            vosu_tool_sdk::send_json(
                client
                    .own(Method::POST, "v1/calculate")
                    .query(&i)
                    .body(bytes),
            )
            .await?
        } else {
            vosu_tool_sdk::send_json(client.own(Method::GET, "v1/current").query(&i)).await?
        }
    };
    print_result(&value, args.json, || {
        if let Some(servers) = value["servers"].as_array() {
            let rows = servers
                .iter()
                .map(|s| vec![text(&s["id"]), text(&s["version"]), text(&s["coverage"])])
                .collect::<Vec<_>>();
            format!(
                "{}\n\n{}\nUnsupported: {}",
                table(&["Profile", "Revision", "Coverage"], &rows),
                text(&value["warning"]),
                value["unsupported"]
            )
        } else {
            format!(
                "{} snapshot {}\nCurrent: {} pp · if FC: {} pp · {} stars\nOfficial (vosu /api/calculate/pp): {}\nLive server deployment is NOT verified.",
                text(&value["server"]),
                text(&value["version"]),
                number(&value["current"]),
                number(&value["if_fc"]),
                number(&value["stars"]),
                value["official"]
            )
        }
    })?;
    Ok(())
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("cli") {
        let parsed = Args::parse_from(std::iter::once("vosux server-pp".to_owned()).chain(args));
        return cli(&ToolEnv::from_env()?, parsed).await;
    }
    let env = ToolEnv::from_env()?;
    let app = App {
        client: env.client(),
        cache: Arc::new(Mutex::new(Cache::default())),
        dir: env.cache_dir.clone(),
    };
    vosu_tool_sdk::serve(&env, router(app)).await?;
    Ok(())
}
