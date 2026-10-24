//! The private overlay server: vosu's overlay-facing routes, answered from one
//! replay track's state.
//!
//! Every route an installed overlay commonly uses answers in vosu's shape
//! (`/json`, `/json/sc`, `/json/v2`, `/json/v2/precise`, `/ws`, `/tokens`,
//! `/websocket/v2`, `/websocket/v2/precise`, `/websocket/v2/subscribe`,
//! `/websocket/commands`, the map and skin file routes); every other path
//! answers 404 like vosu, so nothing waits on a route the server lacks. Pages
//! are served from their overlay folder at the same path vosu serves them
//! (`/<overlay id>/…`), with vosu's `COUNTER_PATH`.
use super::{Overlays, documents};
use crate::confined;
use axum::{
    Json, Router,
    body::Body,
    extract::{
        Path, RawQuery, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

/// Marks the end of one published state on a stream socket. The offline
/// render clock (`overlay-clock.js`) consumes it before any page listener runs;
/// live previews never receive it.
pub const SYNC_PREFIX: &str = "\u{0}vosu-render-sync:";
/// vosu waits this long for a selected-field subscription's pointers.
const SUBSCRIPTION_DEADLINE: Duration = Duration::from_secs(5);

pub fn routes(state: Arc<Overlays>) -> Router {
    Router::new()
        .route("/json", get(json_v1))
        .route("/json/sc", get(json_sc))
        .route("/json/v2", get(json_v2))
        .route("/json/v2/precise", get(json_precise))
        .route("/ws", get(ws_v1))
        .route("/tokens", get(ws_sc))
        .route("/websocket/v2", get(ws_v2))
        .route("/websocket/v2/precise", get(ws_precise))
        .route("/websocket/v2/subscribe", get(ws_subscribe))
        .route("/websocket/commands", get(ws_commands))
        .route("/backgroundImage", get(background))
        .route("/files/beatmap/{*path}", get(beatmap_file))
        .route("/Songs/{*path}", get(songs_file))
        .route("/files/skin/", get(skin_descriptor))
        .route("/files/skin/{*path}", get(skin_file))
        .route("/tools/mania-ratings/api/{*path}", get(super::ratings))
        .fallback(page)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            same_origin,
        ))
        .with_state(state)
}

/// Pages and their requests come only from this server's own origin: another
/// site may not read replay state or open its sockets. A live preview's
/// studio embeds the pages, so there a document navigation (and nothing
/// else) may come from elsewhere.
async fn same_origin(
    State(state): State<Arc<Overlays>>,
    request: axum::http::Request<Body>,
    next: axum::middleware::Next,
) -> Response {
    let origin = state.origin.lock().await.clone();
    if foreign(request.headers(), &origin, state.offline) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}
fn foreign(headers: &axum::http::HeaderMap, origin: &str, offline: bool) -> bool {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let host_matches = header("host").is_some_and(|host| {
        origin
            .split_once("://")
            .is_some_and(|(_, authority)| host == authority)
    });
    let navigation = !offline
        && header("sec-fetch-mode") == Some("navigate")
        && matches!(header("sec-fetch-dest"), Some("iframe" | "document"));
    !host_matches
        || header("origin").is_some_and(|value| value != origin)
        || (!navigation
            && header("sec-fetch-site").is_some_and(|site| site != "same-origin" && site != "none"))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error": "Not found"}))).into_response()
}

async fn json_v1(State(state): State<Arc<Overlays>>) -> Json<Value> {
    Json(state.documents().v1.clone())
}
async fn json_sc(State(state): State<Arc<Overlays>>) -> Json<Value> {
    Json(state.documents().sc.clone())
}
async fn json_v2(State(state): State<Arc<Overlays>>) -> Json<Value> {
    Json(state.documents().v2.clone())
}
async fn json_precise(State(state): State<Arc<Overlays>>) -> Json<Value> {
    Json(state.documents().precise.clone())
}

#[derive(Clone, Copy)]
enum Stream {
    V1,
    Sc,
    V2,
    Precise,
}
impl Stream {
    /// vosu's default publishing intervals: `POLL_RATE` (150 ms) for the
    /// regular documents, `PRECISE_DATA_POLL_RATE` (10 ms) for precise.
    fn interval(self) -> f64 {
        match self {
            Self::Precise => 10.0,
            _ => 150.0,
        }
    }
    fn document(self, documents: &documents::Documents) -> &Value {
        match self {
            Self::V1 => &documents.v1,
            Self::Sc => &documents.sc,
            Self::V2 => &documents.v2,
            Self::Precise => &documents.precise,
        }
    }
}
fn upgrade(state: Arc<Overlays>, upgrade: WebSocketUpgrade, stream: Stream) -> Response {
    upgrade
        .max_frame_size(1 << 20)
        .max_message_size(1 << 20)
        .on_upgrade(move |socket| full_stream(socket, state, stream))
        .into_response()
}
async fn ws_v1(State(state): State<Arc<Overlays>>, socket: WebSocketUpgrade) -> Response {
    upgrade(state, socket, Stream::V1)
}
async fn ws_sc(State(state): State<Arc<Overlays>>, socket: WebSocketUpgrade) -> Response {
    upgrade(state, socket, Stream::Sc)
}
async fn ws_v2(State(state): State<Arc<Overlays>>, socket: WebSocketUpgrade) -> Response {
    upgrade(state, socket, Stream::V2)
}
async fn ws_precise(State(state): State<Arc<Overlays>>, socket: WebSocketUpgrade) -> Response {
    upgrade(state, socket, Stream::Precise)
}

async fn send(socket: &mut WebSocket, text: String) -> bool {
    socket.send(Message::Text(text.into())).await.is_ok()
}
/// The offline clock's end-of-state marker, after a state's frames.
async fn sync(socket: &mut WebSocket, state: &Overlays, sequence: u64) -> bool {
    !state.offline || send(socket, format!("{SYNC_PREFIX}{sequence}")).await
}

/// The whole document on connect, then at each vosu poll (every publishing
/// interval of render time, on a grid from the connection) when it changed;
/// a clock that went back restarts the grid. Client text (tosu's
/// `applyFilters`) is accepted and ignored: the full document is a superset of
/// any filtered one.
async fn full_stream(mut socket: WebSocket, state: Arc<Overlays>, stream: Stream) {
    let mut receiver = state.source.subscribe();
    // vosu polls on a fixed grid from the connection: the next poll's render
    // time, and the document last sent.
    let mut poll = f64::NEG_INFINITY;
    let mut sent: Option<String> = None;
    loop {
        let documents = receiver.borrow_and_update().clone();
        let wall = documents.wall;
        let rewound = wall < poll - stream.interval();
        if sent.is_none() || rewound || wall >= poll {
            poll = if sent.is_none() || rewound {
                wall + stream.interval()
            } else {
                poll + ((wall - poll) / stream.interval())
                    .floor()
                    .mul_add(stream.interval(), stream.interval())
            };
            let text = stream.document(&documents).to_string();
            if sent.as_ref() != Some(&text) {
                if !send(&mut socket, text.clone()).await {
                    return;
                }
                sent = Some(text);
            }
        }
        if !sync(&mut socket, &state, documents.sequence).await {
            return;
        }
        loop {
            tokio::select! {
                changed = receiver.changed() => if changed.is_err() { return } else { break },
                message = socket.recv() => match message {
                    Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                    _ => {}
                },
            }
        }
    }
}

async fn close(socket: &mut WebSocket, code: u16) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: "".into(),
        })))
        .await;
}

/// vosu's selected-field protocol: one pointer list within five seconds, then
/// an initial frame and change-only updates; a second message is an error.
async fn ws_subscribe(State(state): State<Arc<Overlays>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .max_frame_size(1 << 20)
        .max_message_size(1 << 20)
        .on_upgrade(move |socket| subscription(socket, state))
        .into_response()
}
async fn subscription(mut socket: WebSocket, state: Arc<Overlays>) {
    let request = tokio::time::timeout(SUBSCRIPTION_DEADLINE, async {
        loop {
            match socket.recv().await {
                Some(Ok(Message::Text(text))) => return Some(text.to_string()),
                Some(Ok(Message::Binary(_))) => return None,
                Some(Ok(_)) => continue,
                _ => return None,
            }
        }
    })
    .await;
    let text = match request {
        Ok(Some(text)) => text,
        Ok(None) => return,
        Err(_) => {
            let _ = send(
                &mut socket,
                documents::error_frame(3, "subscription timed out"),
            )
            .await;
            return close(&mut socket, 1008).await;
        }
    };
    let pointers = serde_json::from_str::<Vec<String>>(&text)
        .map_err(|_| (1, "invalid subscription request"))
        .and_then(documents::compile_pointers);
    let pointers = match pointers {
        Ok(pointers) => pointers,
        Err((code, message)) => {
            let _ = send(&mut socket, documents::error_frame(code, message)).await;
            return close(&mut socket, 1008).await;
        }
    };
    let mut receiver = state.source.subscribe();
    let documents = receiver.borrow_and_update().clone();
    let mut values = documents::select(&documents.v2, &pointers);
    if !send(
        &mut socket,
        documents::initial_frame(documents.sequence, &values),
    )
    .await
        || !sync(&mut socket, &state, documents.sequence).await
    {
        return;
    }
    loop {
        tokio::select! {
            changed = receiver.changed() => {
                if changed.is_err() { return }
                let documents = receiver.borrow_and_update().clone();
                let next = documents::select(&documents.v2, &pointers);
                if let Some(frame) = documents::update_frame(documents.sequence, &values, &next)
                    && !send(&mut socket, frame).await
                {
                    return;
                }
                values = next;
                if !sync(&mut socket, &state, documents.sequence).await { return }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Text(_) | Message::Binary(_))) => {
                    let _ = send(&mut socket, documents::error_frame(5, "subscription already established")).await;
                    return close(&mut socket, 1008).await;
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                _ => {}
            },
        }
    }
}

/// vosu's `CommandProcessor`, read-only: `getSettings` answers the overlay's
/// effective settings, `updateSettings` echoes, `saveSettings` and
/// `applyFilters` are accepted without effect.
async fn ws_commands(
    State(state): State<Arc<Overlays>>,
    RawQuery(query): RawQuery,
    upgrade: WebSocketUpgrade,
) -> Response {
    // vosu: `URLSearchParams` decoding of `l`, then `decodeURI`.
    let overlay = query
        .as_deref()
        .unwrap_or("")
        .split('&')
        .find_map(|pair| pair.strip_prefix("l="))
        .map(|value| percent_decode(&value.replace('+', " "), false))
        .unwrap_or(Some(String::new()))
        .and_then(|value| percent_decode(&value, true));
    let Some(overlay) = overlay else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    upgrade
        .on_upgrade(move |mut socket| async move {
            while let Some(Ok(message)) = socket.recv().await {
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) {
                        return;
                    }
                    continue;
                };
                if let Some(reply) = command(&state, &overlay, &text)
                    && !send(&mut socket, reply.to_string()).await
                {
                    return;
                }
            }
        })
        .into_response()
}

/// One command frame `command:overlay[:payload]`; the reply, if any.
pub(super) fn command(state: &Overlays, client: &str, data: &str) -> Option<Value> {
    let first = data.find(':')?;
    let second = data[first + 1..].find(':').map(|index| first + 1 + index);
    let name = &data[..first];
    let encoded = second.map_or(&data[first + 1..], |index| &data[first + 1..index]);
    let overlay = percent_decode(encoded, false)?;
    let payload = second.map_or(data, |index| &data[index + 1..]);
    match name {
        "getSettings" => {
            let message = if overlay != client {
                json!({"error": "Wrong overlay"})
            } else {
                match state
                    .layers
                    .iter()
                    .find(|layer| layer.counter_path() == overlay)
                {
                    Some(layer) => Value::Object(layer.values.clone()),
                    None => json!({"error": "counter not found"}),
                }
            };
            Some(json!({"command": "getSettings", "message": message}))
        }
        "updateSettings" => serde_json::from_str::<Value>(payload)
            .ok()
            .map(|value| json!({"command": "updateSettings", "message": value})),
        "saveSettings" | "applyFilters" => None,
        other => Some(json!({"command": other})),
    }
}

/// JavaScript `decodeURIComponent` (`preserve_reserved` false) or `decodeURI`
/// (true: escapes of `;/?:@&=+$,#` stay escaped); `None` on a malformed escape
/// or invalid UTF-8.
pub(super) fn percent_decode(input: &str, preserve_reserved: bool) -> Option<String> {
    const RESERVED: &[u8] = b";/?:@&=+$,#";
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        let hex = bytes.get(index + 1..index + 3)?;
        let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
        if preserve_reserved && RESERVED.contains(&value) {
            out.extend_from_slice(&bytes[index..index + 3]);
        } else {
            out.push(value);
        }
        index += 3;
    }
    String::from_utf8(out).ok()
}

fn file_response(path: &std::path::Path, bytes: Vec<u8>) -> Response {
    let mime = match path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("osu" | "txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
async fn read(path: std::path::PathBuf) -> Response {
    match tokio::fs::read(&path).await {
        Ok(bytes) => file_response(&path, bytes),
        Err(_) => not_found(),
    }
}

/// Overlay pages at vosu's paths: `/<id>/<file>` from the overlay folder,
/// `/<id>` redirected to `/<id>/`, HTML ending with vosu's `COUNTER_PATH`.
async fn page(State(state): State<Arc<Overlays>>, uri: Uri) -> Response {
    let Some(path) = percent_decode(uri.path(), false) else {
        return not_found();
    };
    let path = path.trim_start_matches('/');
    let found = state.layers.iter().find_map(|layer| {
        let id = layer.counter_path();
        let rest = path.strip_prefix(id.as_str())?;
        (rest.is_empty() || rest.starts_with('/')).then_some((layer, rest))
    });
    let Some((layer, rest)) = found else {
        return not_found();
    };
    if rest.is_empty() {
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, format!("{}/", uri.path()))
            .body(Body::empty())
            .unwrap_or_else(|_| not_found());
    }
    let relative = match rest.trim_start_matches('/') {
        "" => layer.entry.as_str(),
        file => file,
    };
    let Ok(file) = confined(&layer.folder, relative) else {
        return not_found();
    };
    let Ok(mut bytes) = tokio::fs::read(&file).await else {
        return not_found();
    };
    if file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
    {
        if !state.offline {
            bytes = with_webgpu_report(bytes);
        }
        bytes.extend_from_slice(
            format!(
                "<script>window.COUNTER_PATH={};</script>",
                serde_json::to_string(&layer.counter_path()).unwrap_or_default()
            )
            .as_bytes(),
        );
    }
    file_response(&file, bytes)
}

/// Tells the studio (the preview's parent page) once that the page created a
/// WebGPU canvas: a render in full Chrome leaves those blank, and the studio
/// warns before rendering.
const WEBGPU_REPORT: &str = r#"<script>(()=>{for(const C of[window.HTMLCanvasElement,window.OffscreenCanvas]){if(!C)continue;const g=C.prototype.getContext;C.prototype.getContext=function(t,...o){const c=g.call(this,t,...o);if(t==="webgpu"&&c&&!window.__vosuWebGpu){window.__vosuWebGpu=true;parent.postMessage({vosuWebGpu:true},"*")}return c}}})();</script>"#;

/// `html` with `WEBGPU_REPORT` before any of its own scripts: right after
/// the `<head>` tag, else `<html>`, else the doctype, else at the start.
pub(super) fn with_webgpu_report(html: Vec<u8>) -> Vec<u8> {
    let lower = html.to_ascii_lowercase();
    let after_tag = |name: &[u8]| {
        lower
            .windows(name.len())
            .position(|window| window == name)
            .filter(|&at| {
                lower
                    .get(at + name.len())
                    .is_some_and(|b| *b == b'>' || b.is_ascii_whitespace())
            })
            .and_then(|at| {
                lower[at..]
                    .iter()
                    .position(|b| *b == b'>')
                    .map(|end| at + end + 1)
            })
    };
    let at = after_tag(b"<head")
        .or_else(|| after_tag(b"<html"))
        .or_else(|| after_tag(b"<!doctype"))
        .unwrap_or(0);
    let mut out = Vec::with_capacity(html.len() + WEBGPU_REPORT.len());
    out.extend_from_slice(&html[..at]);
    out.extend_from_slice(WEBGPU_REPORT.as_bytes());
    out.extend_from_slice(&html[at..]);
    out
}

async fn background(State(state): State<Arc<Overlays>>) -> Response {
    map_asset(&state, "background").await
}
/// `file`, `audio` and `background` name the map's files; anything else is a
/// path in the map's folder (`directPath` values work too).
async fn beatmap_file(State(state): State<Arc<Overlays>>, Path(path): Path<String>) -> Response {
    match path.as_str() {
        "file" | "audio" | "background" => map_asset(&state, &path).await,
        _ => folder_file(&state, &path).await,
    }
}
/// `/Songs/<map folder>/<file>`: only the replay's own map folder exists.
async fn songs_file(State(state): State<Arc<Overlays>>, Path(path): Path<String>) -> Response {
    folder_file(&state, &path).await
}
async fn map_asset(state: &Overlays, kind: &str) -> Response {
    let native = state.native.lock().await;
    let Some(native) = native.as_ref() else {
        return not_found();
    };
    if kind == "file" {
        return file_response(std::path::Path::new("map.osu"), native.bytes.to_vec());
    }
    let name = state.documents().v2["files"][kind]
        .as_str()
        .unwrap_or("")
        .to_owned();
    if name.is_empty() {
        return not_found();
    }
    match native.files.asset(&name) {
        Ok(file) => read(file).await,
        Err(_) => not_found(),
    }
}
async fn folder_file(state: &Overlays, path: &str) -> Response {
    let native = state.native.lock().await;
    let Some(native) = native.as_ref() else {
        return not_found();
    };
    let path = path.replace('\\', "/");
    let documents = state.documents();
    let folder = documents.v2["folders"]["beatmap"].as_str().unwrap_or("");
    let relative = path
        .strip_prefix(folder)
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or(&path);
    if documents.v2["files"]["beatmap"] == relative {
        return file_response(std::path::Path::new("map.osu"), native.bytes.to_vec());
    }
    match native.files.asset(relative) {
        Ok(file) => read(file).await,
        Err(_) => not_found(),
    }
}

/// vosu's `/files/skin/` descriptor for the skin this track renders with.
async fn skin_descriptor(State(state): State<Arc<Overlays>>) -> Response {
    let skin = state.skin.lock().await.clone();
    match skin {
        Some(skin) => match crate::skins::overlay_descriptor(&skin.app, &skin.name).await {
            Ok(value) => Json(value).into_response(),
            Err(_) => not_found(),
        },
        None => Json(json!({"client":null,"name":null,"files":false,"builtin":null,"base":null}))
            .into_response(),
    }
}
async fn skin_file(State(state): State<Arc<Overlays>>, Path(path): Path<String>) -> Response {
    let skin = state.skin.lock().await.clone();
    let Some(skin) = skin else {
        return not_found();
    };
    match crate::skin_asset(&skin.app, Some(&skin.name), &path).await {
        Ok(bytes) => file_response(std::path::Path::new(&path), bytes.to_vec()),
        Err(_) => not_found(),
    }
}
