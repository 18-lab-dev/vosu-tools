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
    #[serde(default)]
    encoder: Option<String>,
    #[serde(default)]
    overlays: Vec<crate::overlays::Overlay>,
    /// Time after the last object and the fade at its end, wall-clock ms;
    /// absent: the tool settings (lazer timing by default).
    #[serde(default)]
    outro_ms: Option<u32>,
    #[serde(default)]
    fade_ms: Option<u32>,
    /// Debug export: the composition inspector is drawn into every frame.
    #[serde(default)]
    inspect: bool,
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
    /// One overlay runtime per track that shows overlays, each on its own
    /// private origin so its pages read that track's state.
    overlays: Arc<Vec<Instance>>,
}
struct Instance {
    track: usize,
    overlays: Arc<crate::overlays::Overlays>,
}
pub(super) async fn start(
    State(app): State<App>,
    Json(mut request): Json<Request>,
) -> Result<(StatusCode, Json<Value>), Error> {
    if request.replays.is_empty()
        || request.replays.len() > 16
        || !(1..=240).contains(&request.fps)
        || !crate::output::LAYOUTS.contains(&request.layout.as_str())
    {
        return Err(error("Invalid render configuration"));
    }
    let (width, height) = crate::output::parse_size(&request.resolution)?;
    let settings: Value = app.env.client().settings().await.map_err(error)?;
    let defaults = crate::output::defaults(&settings);
    let preference = request
        .encoder
        .as_deref()
        .unwrap_or_else(|| defaults["encoder"].as_str().unwrap_or("auto"));
    if !matches!(preference, "auto" | "hardware" | "software") {
        return Err(error("Encoder must be auto, hardware or software"));
    }
    request.encoder = Some(preference.to_owned());
    let outro = request
        .outro_ms
        .unwrap_or(defaults["outro_ms"].as_u64().unwrap_or(1250) as u32);
    let fade = request
        .fade_ms
        .unwrap_or(defaults["fade_ms"].as_u64().unwrap_or(250) as u32)
        .min(outro);
    if outro > crate::output::MAX_OUTRO_MS {
        return Err(error("Outro must be at most 60 000 ms"));
    }
    (request.outro_ms, request.fade_ms) = (Some(outro), Some(fade));
    let relative = !request.out.is_absolute();
    request.out = crate::output::resolve_out(&request.out, &settings)?;
    if relative && let Some(folder) = request.out.parent() {
        tokio::fs::create_dir_all(folder).await.map_err(error)?;
    }
    if request.out.exists() {
        return Err(error(format!(
            "{} already exists; choose a new file name",
            request.out.display()
        )));
    }
    for replay in &request.replays {
        uuid::Uuid::parse_str(&replay.id).map_err(error)?;
        for (key, value) in &replay.preset.settings {
            parse_setting(&format!("{key}={value}")).map_err(error)?;
        }
    }
    crate::overlays::Overlays::validate(&mut request.overlays, request.replays.len())?;
    let instances = (0..request.replays.len())
        .filter_map(|track| {
            let layers: Vec<_> = request
                .overlays
                .iter()
                .filter(|layer| layer.shows(track))
                .cloned()
                .collect();
            (!layers.is_empty()).then(|| Instance {
                track,
                overlays: crate::overlays::Overlays::new(layers),
            })
        })
        .collect::<Vec<_>>();
    let id = uuid::Uuid::new_v4().to_string();
    app.jobs.lock().await.insert(id.clone(),json!({"state":"queued","progress":0.0,"message":"Starting private headless renderer","result":null}));
    let worker = Worker {
        app,
        id: id.clone(),
        overlays: Arc::new(instances),
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
        .route("/frame-state", post(frame_state))
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
    let mut servers = vec![tokio::spawn(async move {
        let _ = axum::serve(listener, Router::new().nest(&format!("/{cap}"), router)).await;
    })];
    for instance in worker.overlays.iter() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        instance
            .overlays
            .origin(format!("http://127.0.0.1:{port}"))
            .await;
        let routes = crate::overlays::routes(instance.overlays.clone());
        servers.push(tokio::spawn(async move {
            let _ = axum::serve(listener, routes).await;
        }));
    }
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
            "--run-all-compositor-stages-before-draw",
            "--disable-gpu-vsync",
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
        .args(if worker.overlays.is_empty() {
            &[][..]
        } else {
            &[
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
            ][..]
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
            servers.iter().for_each(|server| server.abort());
            return Err(format!(
                "Cannot launch Chromium; set VOSU_RENDER_CHROMIUM: {error}"
            ));
        }
    };
    if !worker.overlays.is_empty() {
        let endpoint = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                if let Ok(text) =
                    tokio::fs::read_to_string(profile.join("DevToolsActivePort")).await
                {
                    let mut lines = text.lines();
                    if let (Some(port), Some(path)) = (lines.next(), lines.next())
                        && port.parse::<u16>().is_ok()
                        && path.starts_with("/devtools/browser/")
                    {
                        break format!("ws://127.0.0.1:{port}{path}");
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "Managed browser did not expose its private overlay debugger".to_owned())?;
        for instance in worker.overlays.iter() {
            instance.overlays.debug(endpoint.clone()).await;
        }
    }
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
    servers.iter().for_each(|server| server.abort());
    let _ = tokio::fs::remove_dir_all(profile).await;
    result
}
async fn spec(State(worker): State<Worker>) -> Result<Json<Value>, Error> {
    let mut value = json!(worker.request);
    value["presets"] = json!(*worker.app.presets.lock().await);
    let context = host_context(&worker.app).await?;
    value["default_settings"] = context["default_settings"].clone();
    value["current_skin"] = crate::skins::current(&worker.app, &context)
        .await
        .describe();
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
    /// The first track's map: its song is the soundtrack.
    hash: String,
    rate: f64,
    /// The song's pitch follows the rate (Nightcore, Daycore, DT/HT "adjust pitch").
    #[serde(default)]
    pitch: bool,
    frames: u64,
    /// Map time of the first frame; negative during a lead-in before the song.
    #[serde(default)]
    start_ms: f64,
    /// Every track's map, mods and initial state, for its overlay runtime.
    #[serde(default)]
    tracks: Vec<TrackBegin>,
}
#[derive(Deserialize)]
struct TrackBegin {
    hash: String,
    #[serde(default)]
    mods: u32,
    /// lazer's mod acronyms (with Classic and custom-rate mods), when the replay stores them.
    #[serde(default)]
    acronyms: Option<String>,
    /// Difficulty Adjust's values, which replace the map's.
    #[serde(default)]
    overrides: crate::overlays::DifficultyOverrides,
    #[serde(default)]
    initial: Value,
}
async fn begin(
    State(worker): State<Worker>,
    Json(input): Json<Begin>,
) -> Result<Json<Value>, Error> {
    let mut encoder = worker.encoder.lock().await;
    if encoder.is_some() {
        return Err(error("Encoder already started"));
    }
    // lazer's rate mods run from 0.5× to 2×.
    if !(0.5..=2.0).contains(&input.rate) || input.frames == 0 || !input.start_ms.is_finite() {
        return Err(error("Invalid export clock"));
    }
    let map = crate::library::find_map(&worker.app, &input.hash).await?;
    let text = tokio::fs::read_to_string(map.osu()).await.map_err(error)?;
    for instance in worker.overlays.iter() {
        let track = input
            .tracks
            .get(instance.track)
            .ok_or_else(|| error("Missing overlay track state"))?;
        let files = crate::library::find_map(&worker.app, &track.hash).await?;
        let bytes = tokio::fs::read(files.osu()).await.map_err(error)?;
        instance
            .overlays
            .configure(
                files,
                bytes,
                crate::overlays::RatingMods {
                    rate: input.rate,
                    legacy: track.mods,
                    acronyms: track.acronyms.clone(),
                    overrides: track.overrides,
                },
                track.initial.clone(),
            )
            .await?;
    }
    let audio = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("AudioFilename:"))
        .map(str::trim)
        .ok_or_else(|| error("Beatmap has no audio"))?;
    let audio = map.asset(audio)?;
    let settings: Value = worker.app.env.client().settings().await.map_err(error)?;
    let executable = crate::output::ffmpeg(&settings);
    let selected = crate::encoder::select(
        &executable,
        worker.request.encoder.as_deref().unwrap_or("auto"),
        worker.width,
        worker.height,
    )
    .await
    .map_err(error)?;
    let mut command = selected.command(&executable);
    let mut child = command
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
        .args(["-pix_fmt", "yuv420p"])
        .args(["-c:v", selected.name])
        .args(selected.output)
        .args([
            "-c:a",
            "aac",
            "-af",
            &audio_filter(
                input.rate,
                input.pitch,
                input.start_ms,
                input.frames as f64 / f64::from(worker.request.fps),
                worker.request.fade_ms.unwrap_or(0),
            ),
            "-shortest",
        ])
        .arg(&worker.staged)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            error(format!(
                "Cannot launch FFmpeg ({e}); set the FFmpeg path in the tool's settings"
            ))
        })?;
    *worker.pipe.lock().await = child.stdin.take();
    *encoder = Some(child);
    worker.app.jobs.lock().await.insert(worker.id.clone(),json!({"state":"running","progress":0.0,"message":format!("Rendering frames ({})",selected.name),"encoder":selected.name,"total_frames":input.frames,"result":null}));
    Ok(Json(json!({"ready":true})))
}
/// The song on the video clock: tempo for the replay rate (pitch-shifted when
/// `pitch`, as Nightcore does), silence during a lead-in (or the map start
/// skipped), lazer's entry fade in and the outro fade out.
fn audio_filter(rate: f64, pitch: bool, start_ms: f64, seconds: f64, fade_ms: u32) -> String {
    let mut filters = Vec::new();
    if start_ms > 0.0 {
        filters.push(format!(
            "atrim=start={:.3},asetpts=PTS-STARTPTS",
            start_ms / 1000.0
        ));
    }
    if pitch {
        // Resample at a fixed rate, then play it back faster or slower.
        filters.push(format!(
            "aresample=48000,asetrate={},aresample=48000",
            (48000.0 * rate).round()
        ));
    } else {
        filters.push(format!("atempo={rate}"));
    }
    if start_ms < 0.0 {
        filters.push(format!("adelay={:.0}:all=1", -start_ms / rate));
    }
    filters.push("apad".to_owned());
    let hold = f64::from(crate::output::ENTRY_HOLD_MS) / 1000.0;
    let entry = f64::from(crate::output::ENTRY_FADE_MS) / 1000.0;
    filters.push(format!("afade=t=in:st={hold:.3}:d={entry:.3}"));
    if fade_ms > 0 {
        let fade = f64::from(fade_ms) / 1000.0;
        filters.push(format!(
            "afade=t=out:st={:.3}:d={fade:.3}",
            (seconds - fade).max(0.0)
        ));
    }
    filters.join(",")
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
async fn finish(
    State(worker): State<Worker>,
    Json(profile): Json<Value>,
) -> Result<Json<Value>, Error> {
    worker.pipe.lock().await.take();
    let child = worker
        .encoder
        .lock()
        .await
        .take()
        .ok_or_else(|| error("Encoder not started"))?;
    let drain_started = Instant::now();
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
    let encoder = worker.app.jobs.lock().await[&worker.id]["encoder"].clone();
    let result = json!({"out":worker.request.out,"frames":frames,"seconds":seconds,"render_fps":frames as f64/seconds,"encoder":encoder,"timings_ms":profile["timings_ms"],"startup_ms":profile["startup_ms"],"encoder_drain_ms":drain_started.elapsed().as_secs_f64()*1000.0});
    worker.app.jobs.lock().await.insert(
        worker.id.clone(),
        json!({"state":"done","progress":1.0,"message":"Render complete","encoder":encoder,"result":result}),
    );
    Ok(Json(result))
}
async fn fail(State(worker): State<Worker>, Json(value): Json<Value>) -> Json<Value> {
    let mut jobs = worker.app.jobs.lock().await;
    if jobs[&worker.id]["state"] != "cancelled" {
        let job = jobs.get_mut(&worker.id).unwrap();
        job["state"] = json!("failed");
        job["message"] = value["error"].clone();
    }
    Json(json!({"received":true}))
}

/// One overlay frame for every track that shows overlays: `states` holds each
/// track's state (indexed by track), the answer each runtime's page images.
async fn frame_state(
    State(worker): State<Worker>,
    Json(states): Json<Vec<Value>>,
) -> Result<Json<Vec<Value>>, Error> {
    if worker.app.jobs.lock().await[&worker.id]["state"] == "cancelled" {
        return Err(error("Render cancelled"));
    }
    let frames = worker.overlays.iter().map(|instance| {
        let state = states.get(instance.track).cloned();
        async move {
            let state = state.ok_or_else(|| error("Missing overlay track state"))?;
            let images = instance.overlays.frame(state).await?;
            Ok::<_, Error>(json!({"track": instance.track, "images": images}))
        }
    });
    Ok(Json(futures_util::future::try_join_all(frames).await?))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audio_follows_lead_in_rate_and_fades() {
        // Lead-in two seconds before the song at 1.5×: 1333 ms of silence first.
        assert_eq!(
            audio_filter(1.5, false, -2000.0, 60.0, 250),
            "atempo=1.5,adelay=1333:all=1,apad,afade=t=in:st=0.250:d=0.250,afade=t=out:st=59.750:d=0.250"
        );
        // A render starting after the song begins skips into it; no fade out requested.
        assert_eq!(
            audio_filter(1.0, false, 1500.0, 10.0, 0),
            "atrim=start=1.500,asetpts=PTS-STARTPTS,atempo=1,apad,afade=t=in:st=0.250:d=0.250"
        );
        // Nightcore at a custom 1.25×: the pitch rises with the tempo.
        assert_eq!(
            audio_filter(1.25, true, 0.0, 10.0, 0),
            "aresample=48000,asetrate=60000,aresample=48000,apad,afade=t=in:st=0.250:d=0.250"
        );
    }
}
