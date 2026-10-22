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
use model::{Mapset, Search, Workspace};
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
    workspace: Arc<Mutex<Workspace>>,
    tasks: Arc<Mutex<BTreeMap<String, Task>>>,
    next: Arc<std::sync::atomic::AtomicU64>,
}
/// Loads saved searches/presets. Before tool settings moved to vosu's
/// `settings.json`, they shared `settings.json` in the data directory with
/// mirrors and API credentials; keep the workspace part and delete the rest so
/// no credential copy lingers outside vosu's settings store.
fn load_workspace(data: &std::path::Path) -> Result<Workspace, String> {
    let path = data.join("workspace.json");
    let legacy = data.join("settings.json");
    if !path.exists() && legacy.exists() {
        let workspace: Workspace = store::load(&legacy)?;
        store::save(&path, &workspace)?;
        std::fs::remove_file(&legacy).map_err(|_| "cannot remove legacy settings file")?;
    }
    let workspace: Workspace = store::load(&path)?;
    workspace.validate()?;
    Ok(workspace)
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env = vosu_tool_sdk::ToolEnv::from_env()?;
    std::fs::create_dir_all(&env.data_dir)?;
    let workspace = load_workspace(&env.data_dir)?;
    let mut queue: Queue = store::load(&env.data_dir.join("queue.json"))?;
    queue.recover();
    let store = Store::new(
        queue,
        env.data_dir.clone(),
        net::Network::new(env.cache_dir.join("metadata"))?,
        env.client(),
    );
    store.persist().await?;
    let app = App {
        discovery: Discovery {
            store: store.clone(),
            host: env.client(),
            library: Arc::new(Mutex::new(Library::default())),
        },
        workspace: Arc::new(Mutex::new(workspace)),
        tasks: Arc::default(),
        next: Arc::default(),
    };
    tokio::spawn(store.worker());
    let router = Router::new()
        .route("/v1/state", get(state))
        .route("/v1/lookup/{md5}", get(lookup))
        .route("/v1/workspace", post(update_workspace))
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
    let (config, config_error) = match a.discovery.store.config().await {
        Ok(c) => (c.public(), Value::Null),
        Err(e) => (Value::Null, e.into()),
    };
    let workspace = a.workspace.lock().await.clone();
    let q = a.discovery.store.queue.lock().await;
    let lib = a.discovery.library.lock().await.summary();
    Ok(Json(json!({
        "config": config,
        "config_error": config_error,
        "workspace": workspace,
        "queue": &*q,
        "library": lib,
    })))
}
/// Read route: anyone may resolve a difficulty MD5 (e.g. a replay's map) to
/// its set. Requests are paced and cached like every other mirror request.
async fn lookup(State(a): State<App>, Path(md5): Path<String>) -> ApiResult {
    Ok(Json(a.discovery.lookup(&md5).await?))
}
async fn update_workspace(State(a): State<App>, Json(w): Json<Workspace>) -> ApiResult {
    w.validate()?;
    let mut current = a.workspace.lock().await;
    store::save(&a.discovery.store.data.join("workspace.json"), &w)?;
    *current = w;
    Ok(Json(json!(*current)))
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
        .config()
        .await?
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_settings_keep_workspace_and_drop_credentials() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"sources":[],"concurrency":2,"client_id":"1","client_secret":"s3cret",
                "saved_searches":{"mania":{"query":"x","mode":3}},"presets":{}}"#,
        )
        .unwrap();
        let w = load_workspace(dir.path()).unwrap();
        assert_eq!(w.saved_searches["mania"].query, "x");
        assert!(!dir.path().join("settings.json").exists());
        let saved = std::fs::read_to_string(dir.path().join("workspace.json")).unwrap();
        assert!(!saved.contains("s3cret"));
        assert_eq!(load_workspace(dir.path()).unwrap().saved_searches.len(), 1);
    }
}
