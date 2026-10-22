mod discovery;
mod model;
mod net;
mod store;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use discovery::{Discovery, Library};
use model::{Mapset, Search, Settings};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::PathBuf,
    sync::Arc,
};
use store::{Queue, Store};
use tokio::sync::Mutex;

type ApiResult = Result<Json<Value>, ApiError>;
struct ApiError(String);
impl From<String> for ApiError {
    fn from(e: String) -> Self {
        Self(e)
    }
}
impl From<&str> for ApiError {
    fn from(e: &str) -> Self {
        Self(e.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, Json(json!({"error":self.0}))).into_response()
    }
}
#[derive(Clone, Serialize)]
struct Task {
    state: String,
    progress: f64,
    message: String,
    result: Value,
    #[serde(skip)]
    abort: Option<tokio::task::AbortHandle>,
}
#[derive(Clone)]
struct App {
    discovery: Discovery,
    tasks: Arc<Mutex<BTreeMap<String, Task>>>,
    next: Arc<std::sync::atomic::AtomicU64>,
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env = vosu_tool_sdk::ToolEnv::from_env()?;
    std::fs::create_dir_all(&env.data_dir)?;
    let settings: Settings = store::load(&env.data_dir.join("settings.json"))?;
    settings.validate()?;
    let mut queue: Queue = store::load(&env.data_dir.join("queue.json"))?;
    queue.recover();
    let store = Store {
        queue: Arc::new(Mutex::new(queue)),
        settings: Arc::new(Mutex::new(settings)),
        data: env.data_dir.clone(),
        network: net::Network::new(env.cache_dir.join("metadata"))?,
    };
    store.persist().await?;
    let app = App {
        discovery: Discovery {
            store: store.clone(),
            host: env.client(),
            library: Arc::new(Mutex::new(Library {
                warnings: vec!["Library snapshot not loaded: ownership is unknown until you refresh local context.".into()],
                ..Library::default()
            })),
        },
        tasks: Arc::default(),
        next: Arc::default(),
    };
    tokio::spawn(store.worker());
    let router = Router::new()
        .route("/v1/state", get(state))
        .route("/v1/settings", post(update_settings))
        .route("/v1/search", post(search))
        .route("/v1/library", post(library))
        .route("/v1/queue", post(enqueue))
        .route("/v1/queue/control", post(control))
        .route("/v1/jobs/{id}", get(job).delete(cancel))
        .route("/v1/import/{id}", post(import))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .with_state(app);
    vosu_tool_sdk::serve(&env, router).await?;
    Ok(())
}
async fn state(State(a): State<App>) -> ApiResult {
    let s = a.discovery.store.settings.lock().await.public();
    let q = a.discovery.store.queue.lock().await;
    let lib = a.discovery.library.lock().await;
    Ok(Json(
        json!({"settings":s,"queue":&*q,"library":{"maps":lib.maps.len(),"scores":lib.scores.len(),"collections":lib.collections,"warnings":lib.warnings}}),
    ))
}
async fn update_settings(State(a): State<App>, Json(mut s): Json<Settings>) -> ApiResult {
    s.validate()?;
    let mut old = a.discovery.store.settings.lock().await;
    // Blank credential fields preserve saved credentials; values never read back.
    if s.client_secret.is_empty() {
        s.client_secret = old.client_secret.clone();
    }
    if s.client_id.is_empty() {
        s.client_id = old.client_id.clone();
    }
    store::save(&a.discovery.store.data.join("settings.json"), &s)?;
    *old = s;
    a.discovery.store.network.clear_token().await;
    Ok(Json(old.public()))
}
async fn start_task(a: App, input: Option<Search>) -> (StatusCode, Json<Value>) {
    use std::sync::atomic::Ordering;
    let id = format!("task-{}", a.next.fetch_add(1, Ordering::Relaxed));
    let mut tasks = a.tasks.lock().await;
    if tasks.len() >= 100 {
        let completed = tasks
            .iter()
            .filter(|(_, t)| t.state != "running")
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in completed {
            tasks.remove(&id);
        }
    }
    if tasks.len() >= 100 {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"too many active jobs"})),
        );
    }
    tasks.insert(
        id.clone(),
        Task {
            state: "running".into(),
            progress: 0.0,
            message: "Working".into(),
            result: Value::Null,
            abort: None,
        },
    );
    let app = a.clone();
    let tid = id.clone();
    let task = tokio::spawn(async move {
        let result = match input {
            Some(q) => app.discovery.search(q).await,
            None => app.discovery.refresh().await,
        };
        if let Some(t) = app.tasks.lock().await.get_mut(&tid) {
            match result {
                Ok(v) => {
                    t.state = "done".into();
                    t.progress = 1.0;
                    t.result = v;
                    t.message = "Complete".into();
                }
                Err(e) => {
                    t.state = "failed".into();
                    t.message = e;
                }
            }
            t.abort = None;
        }
    });
    tasks.get_mut(&id).unwrap().abort = Some(task.abort_handle());
    (StatusCode::ACCEPTED, Json(json!({"job":id})))
}
async fn search(
    State(a): State<App>,
    Json(q): Json<Search>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    q.validate()?;
    Ok(start_task(a, Some(q)).await)
}
async fn library(State(a): State<App>) -> (StatusCode, Json<Value>) {
    start_task(a, None).await
}
async fn job(State(a): State<App>, Path(id): Path<String>) -> ApiResult {
    if id.starts_with("task-") {
        return a
            .tasks
            .lock()
            .await
            .get(&id)
            .map(|j| Json(serde_json::to_value(j).unwrap()))
            .ok_or_else(|| ApiError("job not found".into()));
    }
    a.discovery
        .store
        .queue
        .lock()
        .await
        .jobs
        .iter()
        .find(|j| j.id == id)
        .map(|j| Json(serde_json::to_value(j).unwrap()))
        .ok_or_else(|| ApiError("job not found".into()))
}
async fn cancel(State(a): State<App>, Path(id): Path<String>) -> ApiResult {
    if id.starts_with("task-") {
        let mut tasks = a.tasks.lock().await;
        let t = tasks.get_mut(&id).ok_or("job not found")?;
        if let Some(h) = t.abort.take() {
            h.abort();
            t.state = "cancelled".into();
            t.message = "Cancelled".into();
        }
    } else {
        let mut q = a.discovery.store.queue.lock().await;
        let j = q
            .jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or("job not found")?;
        if j.state == "running" || j.state == "queued" {
            j.state = "cancelled".into();
            j.message = "Cancelled".into();
        }
        store::save(&a.discovery.store.queue_path(), &*q)?;
    }
    Ok(Json(json!({"state":"cancelled"})))
}
#[derive(Deserialize)]
struct Enqueue {
    sets: Vec<Mapset>,
    source: Option<String>,
    #[serde(default)]
    no_video: bool,
}
async fn enqueue(
    State(a): State<App>,
    Json(input): Json<Enqueue>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if input.sets.is_empty() || input.sets.len() > 50 {
        return Err("select 1–50 mapsets".into());
    }
    let source = a
        .discovery
        .store
        .settings
        .lock()
        .await
        .source(input.source.as_deref())?;
    let mut q = a.discovery.store.queue.lock().await;
    let before = serde_json::to_vec(&*q).unwrap();
    let mut ids = Vec::new();
    for set in input.sets {
        match q.add(set, source.clone(), input.no_video) {
            Ok(id) => ids.push(id),
            Err(e) => {
                *q = serde_json::from_slice(&before).unwrap();
                return Err(e.into());
            }
        }
    }
    if let Err(e) = store::save(&a.discovery.store.queue_path(), &*q) {
        *q = serde_json::from_slice(&before).unwrap();
        return Err(e.into());
    }
    Ok((StatusCode::ACCEPTED, Json(json!({"job":ids[0],"jobs":ids}))))
}
#[derive(Deserialize)]
struct Control {
    action: String,
}
async fn control(State(a): State<App>, Json(c): Json<Control>) -> ApiResult {
    let mut q = a.discovery.store.queue.lock().await;
    match c.action.as_str() {
        "pause" => q.paused = true,
        "resume" => q.paused = false,
        "retry" => {
            for j in &mut q.jobs {
                if j.state == "failed" {
                    j.state = "queued".into();
                    j.message = "Queued for retry".into();
                }
            }
        }
        "clear" => q
            .jobs
            .retain(|j| j.state == "queued" || j.state == "running"),
        _ => return Err("unknown queue action".into()),
    }
    store::save(&a.discovery.store.queue_path(), &*q)?;
    Ok(Json(json!({"paused":q.paused})))
}
#[derive(Deserialize)]
struct Import {
    client: String,
    songs_dir: Option<PathBuf>,
}
async fn import(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(input): Json<Import>,
) -> ApiResult {
    let j = a
        .discovery
        .store
        .queue
        .lock()
        .await
        .jobs
        .iter()
        .find(|j| j.id == id)
        .cloned()
        .ok_or("job not found")?;
    if j.state != "done" {
        return Err("only validated completed downloads can be imported".into());
    }
    let path = j.result.as_ref().ok_or("download file missing")?;
    // Revalidate persisted bytes before handing them to either client.
    let mut f = std::fs::File::open(path).map_err(|_| "download file no longer exists")?;
    let mut sha = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|_| "cannot verify downloaded file")?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
    }
    if j.sha256.as_deref() != Some(format!("{:x}", sha.finalize()).as_str()) {
        return Err("download file changed; import refused".into());
    }
    match input.client.as_str() {
        "stable" => {
            let target = input
                .songs_dir
                .ok_or("choose and confirm a stable Songs directory")?
                .canonicalize()
                .map_err(|_| "Songs directory must exist")?;
            if !target.is_dir() {
                return Err("Songs target is not a directory".into());
            }
            let dest = target.join(format!(
                "{}{}.osz",
                j.set.id,
                if j.no_video { "-novideo" } else { "" }
            ));
            let mut tmp = tempfile::NamedTempFile::new_in(&target)
                .map_err(|_| "cannot create import file")?;
            std::io::copy(
                &mut std::fs::File::open(path).map_err(|_| "cannot read archive")?,
                &mut tmp,
            )
            .map_err(|_| "cannot copy archive")?;
            tmp.flush().map_err(|_| "cannot flush import")?;
            tmp.as_file().sync_all().map_err(|_| "cannot sync import")?;
            tmp.persist_noclobber(&dest).map_err(
                |_| "import file already exists or cannot be placed; no overwrite performed",
            )?;
            let mut q = a.discovery.store.queue.lock().await;
            if let Some(j) = q.jobs.iter_mut().find(|j| j.id == id) {
                j.imported_to = Some(dest.clone());
            }
            store::save(&a.discovery.store.queue_path(), &*q)?;
            Ok(Json(
                json!({"path":dest,"message":"Archive placed in Songs. In stable Song Select press F5, or restart stable, to import it. No client database was modified."}),
            ))
        }
        "lazer" => {
            open_file(path)?;
            Ok(Json(
                json!({"message":"Sent .osz to the operating system file handler. Choose osu!(lazer) if prompted, or drag this archive into lazer. Import completion is client-owned; no internal Realm files were read or written.","path":path}),
            ))
        }
        _ => Err("client must be stable or lazer".into()),
    }
}
fn open_file(path: &std::path::Path) -> Result<(), ApiError> {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer.exe").arg(path).spawn();
    #[cfg(not(target_os = "windows"))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();
    result
        .map(|_| ())
        .map_err(|_| "cannot open .osz file handler".into())
}
