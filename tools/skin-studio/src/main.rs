mod anim;
mod build;
mod cli;
mod library;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as UrlPath, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use library::{FileEntry, Library, Skin, Source};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tokio::sync::{Mutex, mpsc};
use vosu_tool_sdk::{Client, ToolEnv};

pub type Failure = (StatusCode, String);
/// When the skin list was taken, and its available skins.
pub type Known = (Instant, Vec<Skin>);
pub fn failure(error: impl std::fmt::Display) -> Failure {
    (StatusCode::BAD_REQUEST, error.to_string())
}

#[derive(Clone)]
pub struct App {
    pub client: Client,
    /// Token-free client for other tools' open read routes.
    pub http: reqwest::Client,
    pub cache_dir: PathBuf,
    writes: Arc<Mutex<()>>,
    /// Folders and `.osk` files the user added from a write session, persisted
    /// in the data dir.
    pub added: Arc<Mutex<Vec<PathBuf>>>,
    added_file: Arc<Path>,
    /// Recently listed skins, so bursts of asset reads skip re-listing.
    pub known: Arc<Mutex<Option<Known>>>,
    /// Accepted .osk exports by one-time id, each downloaded at most once.
    exports: Arc<Mutex<HashMap<String, build::Pending>>>,
}

async fn list(State(app): State<App>) -> Result<Json<Library>, Failure> {
    Ok(Json(library::library(&app).await?))
}

#[derive(Deserialize)]
struct Selection {
    skin: String,
}
#[derive(Serialize)]
struct Snapshot {
    text: String,
    revision: String,
    files: Vec<FileEntry>,
    writable: bool,
}
async fn read(
    State(app): State<App>,
    Query(query): Query<Selection>,
) -> Result<Json<Snapshot>, Failure> {
    let (source, skin) = library::resolve(&app, &query.skin).await?;
    let bytes = source.ini(&app).await?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(failure("skin.ini exceeds 4 MiB."));
    }
    let revision = fingerprint(&bytes);
    // Saving lossily decoded text would corrupt non-UTF-8 files.
    let utf8 = std::str::from_utf8(&bytes).is_ok();
    Ok(Json(Snapshot {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        revision,
        files: source.files(&app).await?,
        writable: skin.writable && utf8,
    }))
}

fn content_type(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        Some("ini" | "txt") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}
fn bytes(body: Vec<u8>, kind: &'static str) -> Response {
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=30"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[derive(Deserialize)]
struct AssetQuery {
    skin: String,
    name: String,
}
/// One skin file for previews: images, audio, and text (.ini, .txt, .json)
/// up to 2 MiB for the Explorer's text view.
async fn asset(
    State(app): State<App>,
    Query(query): Query<AssetQuery>,
) -> Result<Response, Failure> {
    let (source, _) = library::resolve(&app, &query.skin).await?;
    let kind = content_type(&query.name);
    let text = kind.starts_with("text/") || kind == "application/json";
    if !(kind.starts_with("image/") || kind.starts_with("audio/") || text) {
        return Err(failure("Only images, audio and text are previewed."));
    }
    let body = source.read(&app, &query.name).await?;
    if text && body.len() > 2 * 1024 * 1024 {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Text files over 2 MiB are not shown.".into(),
        ));
    }
    Ok(bytes(body, kind))
}

#[derive(Deserialize)]
struct AnimationQuery {
    skin: String,
    element: String,
}
/// An animated element's frames as one cached APNG.
async fn animation(
    State(app): State<App>,
    Query(query): Query<AnimationQuery>,
) -> Result<Response, Failure> {
    let (source, _) = library::resolve(&app, &query.skin).await?;
    let names = anim::frames(&source.files(&app).await?, &query.element);
    if names.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            "No animation frames for that element.".into(),
        ));
    }
    let ini = String::from_utf8_lossy(&source.ini(&app).await?).into_owned();
    let fps = anim::fps(anim::framerate(&ini), names.len());
    let mut frames = Vec::with_capacity(names.len());
    for name in &names {
        frames.push(source.read(&app, name).await?);
    }
    let cache = app.cache_dir.clone();
    let apng = tokio::task::spawn_blocking(move || anim::cached(&cache, &frames, fps))
        .await
        .map_err(failure)?
        .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let mut response = bytes(apng, "image/png");
    response.headers_mut().insert(
        "x-frames",
        HeaderValue::from_str(&names.len().to_string()).map_err(failure)?,
    );
    response.headers_mut().insert(
        "x-fps",
        HeaderValue::from_str(&fps.to_string()).map_err(failure)?,
    );
    Ok(response)
}

pub fn ini_path(folder: &Path) -> Result<PathBuf, Failure> {
    let ini = folder.join("skin.ini");
    if let Ok(meta) = fs::symlink_metadata(&ini)
        && (!meta.is_file() || meta.file_type().is_symlink())
    {
        return Err(failure("skin.ini must be a regular file, not a symlink."));
    }
    Ok(ini)
}
fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Deserialize)]
struct Save {
    skin: String,
    text: String,
    revision: String,
}
#[derive(Debug, Serialize)]
struct Saved {
    revision: String,
    backup: Option<String>,
}
fn atomic_save(folder: &Path, text: &str, revision: &str) -> Result<Saved, Failure> {
    if text.len() > 4 * 1024 * 1024 {
        return Err(failure("skin.ini exceeds 4 MiB."));
    }
    let ini = ini_path(folder)?;
    let old = match fs::read(&ini) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(failure(e)),
    };
    if fingerprint(old.as_deref().unwrap_or_default()) != revision {
        return Err((
            StatusCode::CONFLICT,
            "File changed externally. Reload before saving; your editor text is retained.".into(),
        ));
    }
    let backup = if let Some(bytes) = old.as_ref() {
        let mut backup = tempfile::Builder::new()
            .prefix("skin.ini.backup-")
            .suffix(".bak")
            .tempfile_in(folder)
            .map_err(failure)?;
        backup.write_all(bytes).map_err(failure)?;
        backup.as_file().sync_all().map_err(failure)?;
        let (_, path) = backup.keep().map_err(failure)?;
        Some(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        None
    };
    let mut temp = tempfile::NamedTempFile::new_in(folder).map_err(failure)?;
    temp.write_all(text.as_bytes()).map_err(failure)?;
    if let Ok(metadata) = fs::metadata(&ini) {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(failure)?;
    }
    temp.as_file().sync_all().map_err(failure)?;
    // Recheck immediately before replace; never intentionally overwrite an observed external edit.
    if fs::read(&ini).ok().as_deref() != old.as_deref() {
        return Err((StatusCode::CONFLICT, "File changed while saving.".into()));
    }
    temp.persist(&ini).map_err(failure)?;
    #[cfg(unix)]
    fs::File::open(folder)
        .and_then(|f| f.sync_all())
        .map_err(failure)?;
    Ok(Saved {
        revision: fingerprint(text.as_bytes()),
        backup,
    })
}
async fn save(State(app): State<App>, Json(save): Json<Save>) -> Result<Json<Saved>, Failure> {
    let _guard = app.writes.lock().await;
    let (source, skin) = library::resolve(&app, &save.skin).await?;
    let Source::Folder(folder) = source else {
        return Err(failure(
            "Lazer skins and .osk files are read-only here; export a mix as .osk instead.",
        ));
    };
    if !skin.writable {
        return Err(failure("This skin is read-only."));
    }
    tokio::task::spawn_blocking(move || atomic_save(&folder, &save.text, &save.revision).map(Json))
        .await
        .map_err(failure)?
}

fn store(path: &Path, folders: &[PathBuf]) -> Result<(), Failure> {
    let parent = path.parent().ok_or_else(|| failure("Invalid data dir."))?;
    fs::create_dir_all(parent).map_err(failure)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(failure)?;
    serde_json::to_writer_pretty(&mut temp, folders).map_err(failure)?;
    temp.as_file().sync_all().map_err(failure)?;
    temp.persist(path).map_err(failure)?;
    Ok(())
}
#[derive(Deserialize)]
struct AddFolder {
    path: String,
}
async fn add_folder(
    State(app): State<App>,
    Json(add): Json<AddFolder>,
) -> Result<Json<Library>, Failure> {
    let path = PathBuf::from(add.path.trim());
    let folder = tokio::task::spawn_blocking(move || library::skin_source(&path))
        .await
        .map_err(failure)??;
    {
        let mut added = app.added.lock().await;
        if !added.contains(&folder) {
            added.push(folder);
            store(&app.added_file, &added)?;
        }
    }
    *app.known.lock().await = None;
    Ok(Json(library::library(&app).await?))
}
async fn forget_folder(
    State(app): State<App>,
    Json(selection): Json<Selection>,
) -> Result<Json<Library>, Failure> {
    {
        let mut added = app.added.lock().await;
        let before = added.len();
        added.retain(|f| f.to_string_lossy() != selection.skin);
        if added.len() == before {
            return Err(failure("That folder is not in the added list."));
        }
        store(&app.added_file, &added)?;
    }
    *app.known.lock().await = None;
    Ok(Json(library::library(&app).await?))
}

async fn create(
    State(app): State<App>,
    Json(plan): Json<build::Plan>,
) -> Result<Json<build::Built>, Failure> {
    let _guard = app.writes.lock().await;
    let built = build::build(&app, plan).await?;
    *app.known.lock().await = None;
    Ok(Json(built))
}

#[derive(Serialize)]
struct Export {
    /// Relative to this tool's API: `v1/exports/<id>`.
    url: String,
    filename: String,
}
/// Accepts a plan for an .osk download (write route) and returns a one-time
/// download URL. The GET is a plain browser download, so it carries no
/// session; the unguessable id, its single use and a short expiry stand in.
async fn export(
    State(app): State<App>,
    Json(plan): Json<build::Plan>,
) -> Result<Json<Export>, Failure> {
    let plan = build::prepare(&app, plan).await?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let filename = format!("{}.osk", plan.name.trim());
    let mut exports = app.exports.lock().await;
    exports.retain(|_, pending| pending.created.elapsed() < build::PENDING_FOR);
    exports.insert(
        id.clone(),
        build::Pending {
            created: Instant::now(),
            plan,
        },
    );
    Ok(Json(Export {
        url: format!("v1/exports/{id}"),
        filename,
    }))
}
/// Streams an accepted export as `<name>.osk` with an attachment disposition.
async fn download(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, Failure> {
    let pending = app
        .exports
        .lock()
        .await
        .remove(&id)
        .filter(|pending| pending.created.elapsed() < build::PENDING_FOR)
        .ok_or((
            StatusCode::NOT_FOUND,
            "This download has expired; export again.".to_owned(),
        ))?;
    let disposition = build::disposition(&pending.plan.name);
    let (tx, rx) = mpsc::channel::<build::Chunk>(4);
    tokio::spawn(build::stream(app, pending.plan, tx));
    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|chunk| (chunk, rx))
    }));
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).map_err(failure)?,
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/library", get(list))
        .route("/v1/skin", get(read))
        .route("/v1/asset", get(asset))
        .route("/v1/animation", get(animation))
        .route("/v1/save", post(save))
        .route("/v1/folders/add", post(add_folder))
        .route("/v1/folders/forget", post(forget_folder))
        .route("/v1/build", post(create))
        .route("/v1/exports", post(export))
        .route("/v1/exports/{id}", get(download))
        .with_state(app)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("cli") {
        return cli::run(&ToolEnv::from_env()?, args).await;
    }
    let env = ToolEnv::from_env()?;
    let added_file = env.data_dir.join("folders.json");
    let added: Vec<PathBuf> = match fs::read(&added_file) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let app = App {
        client: env.client(),
        http: reqwest::Client::new(),
        cache_dir: env.cache_dir.clone(),
        writes: Arc::new(Mutex::new(())),
        added: Arc::new(Mutex::new(added)),
        added_file: added_file.into(),
        known: Arc::new(Mutex::new(None)),
        exports: Arc::new(Mutex::new(HashMap::new())),
    };
    vosu_tool_sdk::serve(&env, router(app)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_save_backup_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("skin.ini");
        fs::write(&path, "// original\r\n[General]\r\n").unwrap();
        let original = fs::read(&path).unwrap();
        let saved = atomic_save(
            dir.path(),
            "[General]\nName: Test\n",
            &fingerprint(&original),
        )
        .unwrap();
        assert_eq!(
            fs::read(dir.path().join(saved.backup.unwrap())).unwrap(),
            original
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "[General]\nName: Test\n"
        );
        assert_eq!(
            atomic_save(dir.path(), "overwrite", &fingerprint(&original))
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "[General]\nName: Test\n");
    }
    #[test]
    fn creates_missing_ini() {
        let dir = tempfile::tempdir().unwrap();
        let saved = atomic_save(dir.path(), "[General]\n", &fingerprint(b"")).unwrap();
        assert!(saved.backup.is_none());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("skin.ini")).unwrap();
        assert!(ini_path(dir.path()).is_err());
    }
    #[test]
    fn persists_added_folders() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data/folders.json");
        store(&file, &[PathBuf::from("/a"), PathBuf::from("/b")]).unwrap();
        let back: Vec<PathBuf> = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(back, [PathBuf::from("/a"), PathBuf::from("/b")]);
    }
    #[test]
    fn previews_only_media() {
        assert_eq!(content_type("hit300@2x.PNG"), "image/png");
        assert_eq!(content_type("normal-hitclap.ogg"), "audio/ogg");
        assert_eq!(content_type("skin.ini"), "text/plain; charset=utf-8");
    }
}
