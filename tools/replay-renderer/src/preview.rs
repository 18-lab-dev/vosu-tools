//! Live overlay previews: the studio embeds each overlay page beside its
//! preview, served by the same private overlay runtime a render uses (vosu's
//! routes, the replay's state, the overlay's settings) on its own loopback
//! port, and fed the studio's state for the time on screen. Pages run on real
//! time, without the export's virtual clock. One preview exists at a time; an
//! idle one ends after ten minutes.
use super::*;
use crate::overlays::{DifficultyOverrides, Overlay, Overlays, RatingMods, SkinSource};
use std::time::{Duration, Instant};

const IDLE: Duration = Duration::from_secs(10 * 60);

pub(super) struct Preview {
    id: String,
    /// Each track's runtime, by track index (`None`: no overlay on that track).
    tracks: Vec<Option<Arc<Overlays>>>,
    servers: Vec<tokio::task::JoinHandle<()>>,
    touched: Instant,
}
impl Drop for Preview {
    fn drop(&mut self) {
        self.servers.iter().for_each(|server| server.abort());
    }
}

#[derive(Deserialize)]
pub(super) struct Track {
    hash: String,
    #[serde(default)]
    mods: u32,
    #[serde(default)]
    acronyms: Option<String>,
    #[serde(default)]
    overrides: DifficultyOverrides,
    #[serde(default = "one")]
    rate: f64,
    #[serde(default)]
    skin: Option<String>,
    initial: Value,
}
fn one() -> f64 {
    1.0
}
#[derive(Deserialize)]
pub(super) struct Start {
    overlays: Vec<Overlay>,
    tracks: Vec<Track>,
}

/// Starts a preview (ending the previous one); answers each track's page URLs
/// by overlay index.
pub(super) async fn start(
    State(app): State<App>,
    Json(mut start): Json<Start>,
) -> Result<Json<Value>, Error> {
    *app.preview.lock().await = None;
    if start.tracks.is_empty() || start.tracks.len() > 16 {
        return Err(error("A preview needs 1-16 tracks"));
    }
    if start.tracks.iter().any(|t| !(0.5..=2.0).contains(&t.rate)) {
        return Err(error("Invalid preview rate"));
    }
    Overlays::validate(&mut start.overlays, start.tracks.len())?;
    crate::overlays::resolve(&app, &mut start.overlays).await;
    // Owns the servers from the start: an error below stops them (`Drop`).
    let mut session = Preview {
        id: uuid::Uuid::new_v4().to_string(),
        tracks: Vec::with_capacity(start.tracks.len()),
        servers: Vec::new(),
        touched: Instant::now(),
    };
    let mut pages = Vec::new();
    for (index, track) in start.tracks.into_iter().enumerate() {
        let shown: Vec<usize> = (0..start.overlays.len())
            .filter(|&layer| start.overlays[layer].shows(index))
            .collect();
        if shown.is_empty() {
            session.tracks.push(None);
            continue;
        }
        let runtime = Overlays::new(
            shown
                .iter()
                .map(|&layer| start.overlays[layer].clone())
                .collect(),
            false,
        );
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(error)?;
        let port = listener.local_addr().map_err(error)?.port();
        runtime.origin(format!("http://127.0.0.1:{port}")).await;
        let routes = crate::overlays::routes(runtime.clone());
        session.servers.push(tokio::spawn(async move {
            let _ = axum::serve(crate::overlays::nodelay(listener), routes).await;
        }));
        let files = library::find_map(&app, &track.hash).await?;
        let bytes = tokio::fs::read(files.osu()).await.map_err(error)?;
        runtime
            .configure(
                files,
                bytes,
                RatingMods {
                    rate: track.rate,
                    legacy: track.mods,
                    acronyms: track.acronyms,
                    overrides: track.overrides,
                },
                track.initial,
                Some(SkinSource {
                    app: app.clone(),
                    name: track.skin.unwrap_or_default(),
                }),
            )
            .await?;
        for (layer, url) in shown.iter().zip(runtime.pages().await) {
            pages.push(json!({"track": index, "overlay": layer, "url": url}));
        }
        session.tracks.push(Some(runtime));
    }
    let id = session.id.clone();
    *app.preview.lock().await = Some(session);
    let reaper = app.clone();
    let session = id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let mut preview = reaper.preview.lock().await;
            match preview.as_ref() {
                Some(current) if current.id == session && current.touched.elapsed() > IDLE => {
                    *preview = None;
                    return;
                }
                Some(current) if current.id == session => {}
                _ => return,
            }
        }
    });
    Ok(Json(json!({"session": id, "pages": pages})))
}

/// The studio's state for the time on screen: one partial v2 document per
/// track (`null` for tracks without overlays).
pub(super) async fn state(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(states): Json<Vec<Value>>,
) -> Result<Json<Value>, Error> {
    let tracks = {
        let mut preview = app.preview.lock().await;
        let preview = preview
            .as_mut()
            .filter(|preview| preview.id == id)
            .ok_or_else(|| error("This preview has ended"))?;
        preview.touched = Instant::now();
        preview.tracks.clone()
    };
    for (runtime, state) in tracks.iter().zip(states) {
        if let Some(runtime) = runtime
            && !state.is_null()
        {
            runtime.publish(state).await?;
        }
    }
    Ok(Json(json!({"ok": true})))
}

pub(super) async fn stop(State(app): State<App>, Path(id): Path<String>) -> Json<Value> {
    let mut preview = app.preview.lock().await;
    if preview.as_ref().is_some_and(|preview| preview.id == id) {
        *preview = None;
    }
    Json(json!({"stopped": true}))
}
