use super::*;
use axum::{body::Body, response::Response};
use std::{process::Stdio, time::Instant};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin, Command as Process},
};
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Entry {
    id: String,
    #[serde(flatten)]
    preset: Preset,
}
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Request {
    replays: Vec<Entry>,
    out: PathBuf,
    fps: u32,
    resolution: String,
    layout: String,
}
#[derive(Clone)]
struct Worker {
    app: App,
    id: String,
    request: Request,
    staged: PathBuf,
    width: u32,
    height: u32,
    pipe: Arc<Mutex<Option<ChildStdin>>>,
    encoder: Arc<Mutex<Option<Child>>>,
    frames: Arc<Mutex<u64>>,
    start: Instant,
}
pub(super) async fn start(
    State(app): State<App>,
    Json(request): Json<Request>,
) -> Result<(StatusCode, Json<Value>), Error> {
    if request.replays.is_empty()
        || request.replays.len() > 16
        || !(1..=240).contains(&request.fps)
        || !matches!(request.layout.as_str(), "side-by-side" | "stacked" | "grid")
    {
        return Err(error("Invalid render configuration"));
    }
    let (width, height) = request
        .resolution
        .split_once('x')
        .ok_or_else(|| error("Resolution must be WIDTHxHEIGHT"))?;
    let width: u32 = width.parse().map_err(error)?;
    let height: u32 = height.parse().map_err(error)?;
    if !(64..=7680).contains(&width)
        || !(64..=4320).contains(&height)
        || !width.is_multiple_of(2)
        || !height.is_multiple_of(2)
    {
        return Err(error(
            "Video dimensions must be even and within 64x64..7680x4320",
        ));
    }
    if !request.out.is_absolute() || request.out.extension().is_none_or(|e| e != "mp4") {
        return Err(error("Output must be an absolute .mp4 path"));
    }
    if request.out.exists() {
        return Err(error("Output already exists; choose a new file"));
    }
    for replay in &request.replays {
        uuid::Uuid::parse_str(&replay.id).map_err(error)?;
        for (key, value) in &replay.preset.settings {
            parse_setting(&format!("{key}={value}")).map_err(error)?;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    app.jobs.lock().await.insert(id.clone(),json!({"state":"queued","progress":0.0,"message":"Starting private headless renderer","result":null}));
    let worker = Worker {
        app,
        id: id.clone(),
        staged: request.out.with_file_name(format!(".vosu-render-{id}.mp4")),
        request,
        width,
        height,
        pipe: Arc::default(),
        encoder: Arc::default(),
        frames: Arc::default(),
        start: Instant::now(),
    };
    tokio::spawn(async move {
        if let Err(message) = run(worker.clone()).await {
            let mut jobs = worker.app.jobs.lock().await;
            if jobs[&worker.id]["state"] != "cancelled" {
                jobs.get_mut(&worker.id).unwrap()["state"] = json!("failed");
                jobs.get_mut(&worker.id).unwrap()["message"] = json!(message);
            }
            if let Some(mut encoder) = worker.encoder.lock().await.take() {
                let _ = encoder.kill().await;
            }
            let _ = tokio::fs::remove_file(&worker.staged).await;
        }
    });
    Ok((StatusCode::ACCEPTED, Json(json!({"job":id}))))
}
async fn run(worker: Worker) -> Result<(), String> {
    let _permit = worker
        .app
        .render_gate
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    if worker.app.jobs.lock().await[&worker.id]["state"] == "cancelled" {
        return Err("Render cancelled".into());
    }
    worker.app.jobs.lock().await.get_mut(&worker.id).unwrap()["message"] =
        json!("Preparing SHA-256-pinned browser runtime (first use may download)");
    let browser = crate::browser::executable(&worker.app.env.cache_dir).await?;
    let cap = uuid::Uuid::new_v4().simple().to_string();
    let router = Router::new()
        .route("/spec", get(spec))
        .route("/assets", get(private_asset))
        .route("/replay/{id}", get(private_replay))
        .route("/begin", post(begin))
        .route("/frame", post(frame))
        .route("/finish", post(finish))
        .route("/fail", post(fail))
        .route("/{*path}", get(web))
        .layer(DefaultBodyLimit::max(
            (worker.width as usize) * (worker.height as usize) * 4 + 1024,
        ))
        .with_state(worker.clone());
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let url = format!("http://127.0.0.1:{port}/{cap}/export.html");
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, Router::new().nest(&format!("/{cap}"), router)).await;
    });
    // The capability never enters the host overlay origin; this private browser has no vosu credentials.
    let profile = worker
        .app
        .env
        .cache_dir
        .join(format!("chromium-{}", worker.id));
    let spawned = Process::new(browser)
        .args([
            "--headless=new",
            "--no-first-run",
            "--no-default-browser-check",
            "--enable-unsafe-webgpu",
            "--disable-dev-shm-usage",
        ])
        .args(if cfg!(target_os = "linux") {
            &[
                "--use-angle=vulkan",
                "--enable-features=Vulkan",
                "--disable-vulkan-surface",
            ][..]
        } else {
            &[][..]
        })
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            server.abort();
            return Err(format!(
                "Cannot launch Chromium; set VOSU_RENDER_CHROMIUM: {error}"
            ));
        }
    };
    let result = loop {
        let state = worker.app.jobs.lock().await[&worker.id]["state"]
            .as_str()
            .unwrap_or("failed")
            .to_owned();
        if state == "done" {
            break Ok(());
        }
        if state == "failed" {
            break Err(worker.app.jobs.lock().await[&worker.id]["message"]
                .as_str()
                .unwrap_or("Export failed")
                .to_owned());
        }
        if state == "cancelled" {
            break Err("Render cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(_)) => break Err("Headless Chromium exited before export completed".into()),
            Ok(None) => (),
            Err(error) => break Err(error.to_string()),
        }
        if worker.start.elapsed().as_secs() > 7200 {
            break Err("Render exceeded two-hour deadline".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    let _ = child.kill().await;
    server.abort();
    let _ = tokio::fs::remove_dir_all(profile).await;
    result
}
async fn spec(State(worker): State<Worker>) -> Result<Json<Value>, Error> {
    let mut value = json!(worker.request);
    value["presets"] = json!(*worker.app.presets.lock().await);
    value["default_settings"] = host_context(&worker.app).await?["default_settings"].clone();
    Ok(Json(value))
}
async fn private_asset(
    State(worker): State<Worker>,
    query: Query<BTreeMap<String, String>>,
) -> Result<Bytes, Error> {
    asset(State(worker.app), query).await
}
async fn private_replay(
    State(worker): State<Worker>,
    Path(id): Path<String>,
) -> Result<Bytes, Error> {
    if !worker.request.replays.iter().any(|r| r.id == id) {
        return Err(error("Unknown replay"));
    }
    replay_file(State(worker.app), Path(id), Query(BTreeMap::new())).await
}
async fn web(Path(path): Path<String>) -> Result<Response, Error> {
    let root = std::env::current_dir().map_err(error)?.join("web/dist");
    let file = confined(&root, &path)?;
    let mime = match file.extension().and_then(|s| s.to_str()) {
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("html") => "text/html",
        _ => "application/octet-stream",
    };
    Response::builder()
        .header("content-type", mime)
        .body(Body::from(tokio::fs::read(file).await.map_err(error)?))
        .map_err(error)
}
#[derive(Deserialize)]
struct Begin {
    hash: String,
    rate: f64,
    frames: u64,
}
async fn begin(
    State(worker): State<Worker>,
    Json(input): Json<Begin>,
) -> Result<Json<Value>, Error> {
    let mut encoder = worker.encoder.lock().await;
    if encoder.is_some() {
        return Err(error("Encoder already started"));
    }
    if ![0.75, 1.0, 1.5].contains(&input.rate) || input.frames == 0 {
        return Err(error("Invalid export clock"));
    }
    let map = map_path(&worker.app, &input.hash).await?;
    let text = tokio::fs::read_to_string(&map).await.map_err(error)?;
    let audio = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("AudioFilename:"))
        .map(str::trim)
        .ok_or_else(|| error("Beatmap has no audio"))?;
    let audio = confined(
        map.parent().ok_or_else(|| error("Map has no parent"))?,
        audio,
    )?;
    let executable = std::env::var("VOSU_RENDER_FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let mut child = Process::new(executable)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-n",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgba",
            "-video_size",
            &format!("{}x{}", worker.width, worker.height),
            "-framerate",
            &worker.request.fps.to_string(),
            "-i",
            "pipe:0",
            "-i",
        ])
        .arg(audio)
        .args([
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            "realtime",
            "-cpu-used",
            "6",
            "-b:v",
            "6M",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-af",
            &format!("atempo={},apad", input.rate),
            "-shortest",
        ])
        .arg(&worker.staged)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| error(format!("Cannot launch ffmpeg; set VOSU_RENDER_FFMPEG: {e}")))?;
    *worker.pipe.lock().await = child.stdin.take();
    *encoder = Some(child);
    worker.app.jobs.lock().await.insert(worker.id.clone(),json!({"state":"running","progress":0.0,"message":"Rendering frames","total_frames":input.frames,"result":null}));
    Ok(Json(json!({"ready":true})))
}
async fn frame(State(worker): State<Worker>, body: Bytes) -> Result<Json<Value>, Error> {
    if body.len() != worker.width as usize * worker.height as usize * 4 {
        return Err(error("Frame buffer size mismatch"));
    }
    if worker.app.jobs.lock().await[&worker.id]["state"] == "cancelled" {
        return Err(error("Render cancelled"));
    }
    worker
        .pipe
        .lock()
        .await
        .as_mut()
        .ok_or_else(|| error("Encoder is not running"))?
        .write_all(&body)
        .await
        .map_err(error)?;
    let mut count = worker.frames.lock().await;
    *count += 1;
    let mut jobs = worker.app.jobs.lock().await;
    let job = jobs.get_mut(&worker.id).unwrap();
    let total = job["total_frames"].as_u64().unwrap_or(1);
    job["progress"] = json!(*count as f64 / total as f64);
    job["message"] = json!(format!("Frame {count}/{total}"));
    Ok(Json(json!({"frame":*count})))
}
async fn finish(State(worker): State<Worker>) -> Result<Json<Value>, Error> {
    worker.pipe.lock().await.take();
    let child = worker
        .encoder
        .lock()
        .await
        .take()
        .ok_or_else(|| error("Encoder not started"))?;
    let result = child.wait_with_output().await.map_err(error)?;
    if !result.status.success() {
        return Err(error(String::from_utf8_lossy(&result.stderr)));
    }
    let frames = *worker.frames.lock().await;
    if worker.app.jobs.lock().await[&worker.id]["state"] == "cancelled" {
        return Err(error("Render cancelled"));
    }
    let total = worker.app.jobs.lock().await[&worker.id]["total_frames"]
        .as_u64()
        .unwrap_or(0);
    if frames != total {
        return Err(error("Export ended before every frame was encoded"));
    }
    tokio::fs::hard_link(&worker.staged, &worker.request.out)
        .await
        .map_err(error)?;
    tokio::fs::remove_file(&worker.staged)
        .await
        .map_err(error)?;
    let seconds = worker.start.elapsed().as_secs_f64();
    let result = json!({"out":worker.request.out,"frames":frames,"seconds":seconds,"render_fps":frames as f64/seconds});
    worker.app.jobs.lock().await.insert(
        worker.id.clone(),
        json!({"state":"done","progress":1.0,"message":"Render complete","result":result}),
    );
    Ok(Json(result))
}
async fn fail(State(worker): State<Worker>, Json(value): Json<Value>) -> Json<Value> {
    let mut jobs = worker.app.jobs.lock().await;
    if jobs[&worker.id]["state"] != "cancelled" {
        jobs.insert(
            worker.id.clone(),
            json!({"state":"failed","progress":0.0,"message":value["error"],"result":null}),
        );
    }
    Json(json!({"received":true}))
}
