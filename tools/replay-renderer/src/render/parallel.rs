use super::*;

pub(super) async fn run(worker: Worker, count: u32) -> Result<(), String> {
    // Complete first-use installation before workers inspect the shared cache.
    crate::browser::executable(&worker.app.env.cache_dir).await?;
    let settings: Value = worker
        .app
        .env
        .client()
        .settings()
        .await
        .map_err(|e| e.to_string())?;
    let executable = crate::output::ffmpeg(&settings);
    // Probe once before opening concurrent sessions; probing alongside active
    // encoders can exhaust the driver's session quota and select mixed codecs.
    let selected = Arc::new(
        crate::encoder::select(
            &executable,
            worker.request.encoder.as_deref().unwrap_or("auto"),
            &worker.plan(),
            worker.gpu.as_deref(),
        )
        .await?,
    );
    let mut segments = Vec::new();
    let mut tasks = Vec::new();
    for index in 0..count {
        let mut request = worker.request.clone();
        request.segment = Some((index, count));
        request.selected = Some(selected.clone());
        request.out = worker
            .request
            .out
            .with_file_name(format!(".vosu-segment-{}-{index}.mp4", worker.id));
        let id = format!("{}-{index}", worker.id);
        let overlays = worker
            .overlays
            .iter()
            .map(|instance| Instance {
                track: instance.track,
                overlays: crate::overlays::Overlays::new(
                    worker
                        .request
                        .overlays
                        .iter()
                        .filter(|layer| layer.shows(instance.track))
                        .cloned()
                        .collect(),
                    true,
                ),
            })
            .collect();
        let segment = Worker {
            app: worker.app.clone(),
            id: id.clone(),
            staged: request.out.with_extension("staging.mp4"),
            request,
            width: worker.width,
            height: worker.height,
            pipe: Arc::default(),
            encoder: Arc::default(),
            frames: Arc::default(),
            start: Instant::now(),
            overlays: Arc::new(overlays),
            audio: Arc::default(),
            gpu: worker.gpu.clone(),
        };
        worker
            .app
            .jobs
            .lock()
            .await
            .insert(id, json!({"state":"queued","progress":0.0,"result":null}));
        let task_worker = segment.clone();
        tasks.push(tokio::spawn(async move {
            let result = run_single(task_worker.clone()).await;
            if let Err(message) = &result {
                let mut jobs = task_worker.app.jobs.lock().await;
                let job = jobs.get_mut(&task_worker.id).unwrap();
                job["state"] = json!("failed");
                job["message"] = json!(message);
            }
            result
        }));
        segments.push(segment);
    }
    let mut failure = None;
    while tasks.iter().any(|task| !task.is_finished()) {
        {
            let mut jobs = worker.app.jobs.lock().await;
            let cancelled = jobs[&worker.id]["state"] == "cancelled";
            if failure.is_none() {
                failure = segments.iter().find_map(|segment| {
                    let job = &jobs[&segment.id];
                    (job["state"] == "failed").then(|| {
                        job["message"]
                            .as_str()
                            .unwrap_or("Segment failed")
                            .to_owned()
                    })
                });
            }
            if cancelled || failure.is_some() {
                for segment in &segments {
                    jobs.get_mut(&segment.id).unwrap()["state"] = json!("cancelled");
                }
                if cancelled {
                    failure = Some("Render cancelled".into());
                }
            } else {
                let progress = segments
                    .iter()
                    .map(|s| jobs[&s.id]["progress"].as_f64().unwrap_or(0.0))
                    .sum::<f64>()
                    / f64::from(count);
                let encoder = segments
                    .iter()
                    .find_map(|s| jobs[&s.id]["encoder"].as_str())
                    .unwrap_or("probing")
                    .to_owned();
                let warning = segments
                    .iter()
                    .find_map(|s| jobs[&s.id]["warning"].as_str().map(str::to_owned));
                let job = jobs.get_mut(&worker.id).unwrap();
                job["warning"] = json!(warning);
                job["state"] = json!("running");
                job["parallel_jobs"] = json!(count);
                job["gpu"] = json!(worker.gpu.as_ref().map(|g| g.describe()));
                job["encoder"] = json!(encoder);
                job["progress"] = json!(progress);
                job["message"] = json!(format!("Rendering {count} parallel segments ({encoder})"));
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    for task in tasks {
        match task.await {
            Ok(Ok(())) => (),
            Ok(Err(message)) => {
                failure.get_or_insert(message);
            }
            Err(message) => {
                failure.get_or_insert(message.to_string());
            }
        }
    }
    let list = worker.staged.with_extension("concat.txt");
    let plan = worker.plan();
    let result = async {
        if let Some(message) = failure { return Err(message); }
        let settings: Value = worker.app.env.client().settings().await.map_err(|e| e.to_string())?;
        let executable = crate::output::ffmpeg(&settings);
        let mut lines = String::new();
        for segment in &segments {
            let frames = *segment.frames.lock().await;
            if frames > 0 {
                // MP4's container duration is millisecond-rounded. Explicit
                // frame-clock durations prevent concat gaps/overlaps.
                lines.push_str(&format!("file '{}'\nduration {:.9}\n",
                    segment.request.out.file_name().unwrap().to_string_lossy(),
                    frames as f64 / f64::from(worker.request.fps)));
            }
        }
        tokio::fs::write(&list, lines).await.map_err(|e| e.to_string())?;
        let audio = segments[0].audio.lock().await.clone();
        let mux_started = Instant::now();
        let output = Process::new(executable)
            .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-f", "concat", "-safe", "0", "-i"])
            .arg(&list).arg("-i").arg(audio["path"].as_str().ok_or("Missing soundtrack")?)
            .args(["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"]).args(plan.audio_args()).arg("-af")
            .arg(audio["filter"].as_str().ok_or("Missing soundtrack clock")?)
            // The index goes first in the final file, not in the segments.
            .args(["-shortest", "-movflags", "+faststart"]).arg(&worker.staged).kill_on_drop(true).output().await.map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
        if worker.app.jobs.lock().await[&worker.id]["state"] == "cancelled" { return Err("Render cancelled".into()); }
        let total: u64 = { let mut n = 0; for segment in &segments { n += *segment.frames.lock().await; } n };
        let fit = fit_target(&worker, &worker.staged, &plan, total).await.map_err(|e| e.1["error"].as_str().unwrap_or("Discord fit failed").to_owned())?;
        tokio::fs::hard_link(&worker.staged, &worker.request.out).await.map_err(|e| e.to_string())?;
        let mut jobs = worker.app.jobs.lock().await;
        let results: Vec<Value> = segments.iter().map(|s| jobs[&s.id]["result"].clone()).collect();
        let frames: u64 = results.iter().filter_map(|v| v["frames"].as_u64()).sum();
        let seconds = worker.start.elapsed().as_secs_f64();
        let encoder = results[0]["encoder"].clone();
        let gpu = worker.gpu.as_ref().map(|g| g.describe());
        let warning = jobs[&worker.id]["warning"].clone();
        let (width, height, fps) = plan.delivered(&fit);
        let result = json!({"out":worker.request.out,"export_for":plan.target.name(),"width":width,"height":height,"fps":fps,"warning":warning,"fit":fit,"frames":frames,"seconds":seconds,"render_fps":frames as f64/seconds,"encoder":encoder,"parallel_jobs":count,"gpu":gpu,"segments":results,"mux_ms":mux_started.elapsed().as_secs_f64()*1000.0});
        jobs.insert(worker.id.clone(), json!({"state":"done","progress":1.0,"message":"Render complete","encoder":encoder,"parallel_jobs":count,"gpu":gpu,"result":result}));
        Ok(())
    }.await;
    for segment in segments {
        if let Some(mut encoder) = segment.encoder.lock().await.take() {
            let _ = encoder.kill().await;
        }
        let _ = tokio::fs::remove_file(segment.staged).await;
        let _ = tokio::fs::remove_file(segment.request.out).await;
        worker.app.jobs.lock().await.remove(&segment.id);
    }
    let _ = tokio::fs::remove_file(list).await;
    let _ = tokio::fs::remove_file(&worker.staged).await;
    result
}
