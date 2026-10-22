use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;
use vosu_tool_sdk::{Client, ToolEnv};

type Failure = (StatusCode, String);
fn failure(error: impl std::fmt::Display) -> Failure {
    (StatusCode::BAD_REQUEST, error.to_string())
}
#[derive(Deserialize)]
struct Context {
    #[serde(default)]
    client: Option<String>,
    osu_dir: Option<PathBuf>,
    skin: Option<SkinContext>,
}
#[derive(Deserialize)]
struct SkinContext {
    #[serde(default)]
    name: Option<String>,
    folder: Option<PathBuf>,
    /// Lazer: whether vosu serves the current skin's files at `/files/skin/`.
    #[serde(default)]
    files: Option<bool>,
    /// Lazer: the built-in skin family when the current skin has no files.
    #[serde(default)]
    builtin: Option<String>,
}
#[derive(Clone)]
struct App {
    client: Client,
    writes: Arc<Mutex<()>>,
    /// Folders the user added from a write session, persisted in the data dir.
    added: Arc<Mutex<Vec<PathBuf>>>,
    added_file: Arc<Path>,
}
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum Origin {
    Stable,
    Added,
}
#[derive(Serialize, Debug)]
struct Skin {
    name: String,
    folder: String,
    current: bool,
    origin: Origin,
    /// False when an added folder vanished or no longer looks like a skin
    /// (for example a lazer external-edit folder after import).
    available: bool,
}
#[derive(Serialize)]
struct CurrentSkin {
    name: Option<String>,
    files: bool,
    builtin: Option<String>,
}
impl From<SkinContext> for CurrentSkin {
    fn from(skin: SkinContext) -> Self {
        Self {
            name: skin.name,
            // Hosts without the `files` field only serve stable skin folders.
            files: skin.files.unwrap_or(skin.folder.is_some()),
            builtin: skin.builtin,
        }
    }
}
#[derive(Serialize)]
struct Library {
    client: Option<String>,
    skin: Option<CurrentSkin>,
    skins_dir: Option<String>,
    skins: Vec<Skin>,
}
/// `Name:` from a skin.ini `[General]` section, for labelling added folders
/// whose directory name is meaningless (lazer mounts use a hash).
fn ini_name(folder: &Path) -> Option<String> {
    let ini = folder.join("skin.ini");
    let meta = fs::symlink_metadata(&ini).ok()?;
    if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
        return None;
    }
    let text = String::from_utf8_lossy(&fs::read(ini).ok()?).into_owned();
    let mut general = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[') {
            general = header.trim_end_matches(']').trim() == "General";
        } else if general
            && let Some((key, value)) = line.split_once(':')
            && key.trim() == "Name"
            && !value.trim().is_empty()
        {
            return Some(value.trim().to_owned());
        }
    }
    None
}
/// Accepts only existing directories that contain a regular `skin.ini` or a
/// lazer `skininfo.json`, so writes can never target an arbitrary folder.
fn skin_folder(path: &Path) -> Result<PathBuf, Failure> {
    if !path.is_absolute() {
        return Err(failure("Enter an absolute folder path."));
    }
    let folder = path
        .canonicalize()
        .map_err(|e| failure(format!("Cannot open {}: {e}", path.display())))?;
    if !folder.is_dir() {
        return Err(failure("That path is not a folder."));
    }
    let marker = |name: &str| {
        fs::symlink_metadata(folder.join(name))
            .map(|meta| meta.is_file())
            .unwrap_or(false)
    };
    if !marker("skin.ini") && !marker("skininfo.json") {
        return Err(failure(
            "No skin.ini or skininfo.json in that folder. Choose the skin folder itself.",
        ));
    }
    Ok(folder)
}
async fn library(app: &App) -> Result<Library, Failure> {
    let context: Context = app.client.host("context").await.map_err(failure)?;
    let current = context
        .skin
        .as_ref()
        .and_then(|s| s.folder.as_ref())
        .and_then(|p| p.canonicalize().ok());
    let mut skins = Vec::new();
    let mut skins_dir = None;
    if let Some(osu) = context.osu_dir {
        let dir = osu.join("Skins");
        skins_dir = Some(dir.to_string_lossy().into_owned());
        if let Ok(root) = dir.canonicalize() {
            for entry in fs::read_dir(&root).map_err(failure)? {
                let entry = entry.map_err(failure)?;
                if !entry.file_type().map_err(failure)?.is_dir() {
                    continue;
                }
                let folder = entry.path().canonicalize().map_err(failure)?;
                if folder.parent() != Some(root.as_path()) {
                    continue;
                }
                skins.push(Skin {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    current: current.as_ref() == Some(&folder),
                    folder: folder.to_string_lossy().into_owned(),
                    origin: Origin::Stable,
                    available: true,
                });
            }
        }
    }
    skins.sort_by_cached_key(|skin| skin.name.to_lowercase());
    for folder in app.added.lock().await.iter() {
        let path = folder.to_string_lossy().into_owned();
        if skins.iter().any(|s| s.folder == path) {
            continue;
        }
        let available = skin_folder(folder).is_ok_and(|f| &f == folder);
        skins.push(Skin {
            name: ini_name(folder)
                .or_else(|| folder.file_name().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_else(|| path.clone()),
            current: current.as_ref() == Some(folder),
            folder: path,
            origin: Origin::Added,
            available,
        });
    }
    Ok(Library {
        client: context.client,
        skin: context.skin.map(CurrentSkin::from),
        skins_dir,
        skins,
    })
}
async fn list(State(app): State<App>) -> Result<Json<Library>, Failure> {
    Ok(Json(library(&app).await?))
}
#[derive(Deserialize)]
struct Selection {
    folder: String,
}
async fn selected(app: &App, folder: &str) -> Result<PathBuf, Failure> {
    library(app)
        .await?
        .skins
        .into_iter()
        .find(|s| s.folder == folder && s.available)
        .map(|s| PathBuf::from(s.folder))
        .ok_or_else(|| failure("Choose a skin from the library list."))
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
    let folder = tokio::task::spawn_blocking(move || skin_folder(&path))
        .await
        .map_err(failure)??;
    {
        let mut added = app.added.lock().await;
        if !added.contains(&folder) {
            added.push(folder);
            store(&app.added_file, &added)?;
        }
    }
    Ok(Json(library(&app).await?))
}
async fn forget_folder(
    State(app): State<App>,
    Json(selection): Json<Selection>,
) -> Result<Json<Library>, Failure> {
    {
        let mut added = app.added.lock().await;
        let before = added.len();
        added.retain(|f| f.to_string_lossy() != selection.folder);
        if added.len() == before {
            return Err(failure("That folder is not in the added list."));
        }
        store(&app.added_file, &added)?;
    }
    Ok(Json(library(&app).await?))
}
fn ini_path(folder: &Path) -> Result<PathBuf, Failure> {
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
fn assets(folder: &Path, relative: &Path, files: &mut Vec<String>) -> Result<(), Failure> {
    if relative.components().count() > 16 || files.len() > 50000 {
        return Err(failure("Skin file tree exceeds safe limits."));
    }
    for entry in fs::read_dir(folder.join(relative)).map_err(failure)? {
        let entry = entry.map_err(failure)?;
        let ty = entry.file_type().map_err(failure)?;
        let path = relative.join(entry.file_name());
        if ty.is_dir() {
            assets(folder, &path, files)?;
        } else if ty.is_file() {
            files.push(path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}
#[derive(Serialize)]
struct Snapshot {
    text: String,
    revision: String,
    files: Vec<String>,
}
fn snapshot(folder: &Path) -> Result<Snapshot, Failure> {
    let path = ini_path(folder)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(failure(e)),
    };
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(failure("skin.ini exceeds 4 MiB."));
    }
    let revision = fingerprint(&bytes);
    let text = String::from_utf8(bytes).map_err(failure)?;
    let mut files = Vec::new();
    assets(folder, Path::new(""), &mut files)?;
    files.sort();
    Ok(Snapshot {
        text,
        revision,
        files,
    })
}
async fn read(
    State(app): State<App>,
    Query(query): Query<Selection>,
) -> Result<Json<Snapshot>, Failure> {
    let folder = selected(&app, &query.folder).await?;
    tokio::task::spawn_blocking(move || snapshot(&folder).map(Json))
        .await
        .map_err(failure)?
}
#[derive(Deserialize)]
struct Save {
    folder: String,
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
    let folder = selected(&app, &save.folder).await?;
    tokio::task::spawn_blocking(move || atomic_save(&folder, &save.text, &save.revision).map(Json))
        .await
        .map_err(failure)?
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env = ToolEnv::from_env()?;
    let added_file = env.data_dir.join("folders.json");
    let added: Vec<PathBuf> = match fs::read(&added_file) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let app = App {
        client: env.client(),
        writes: Arc::new(Mutex::new(())),
        added: Arc::new(Mutex::new(added)),
        added_file: added_file.into(),
    };
    vosu_tool_sdk::serve(
        &env,
        Router::new()
            .route("/v1/skins", get(list))
            .route("/v1/skin", get(read))
            .route("/v1/save", post(save))
            .route("/v1/folders/add", post(add_folder))
            .route("/v1/folders/forget", post(forget_folder))
            .with_state(app),
    )
    .await?;
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
        assert!(snapshot(dir.path()).is_err());
    }
    #[test]
    fn added_folders_must_look_like_skins() {
        let dir = tempfile::tempdir().unwrap();
        assert!(skin_folder(Path::new("relative/skin")).is_err());
        assert!(skin_folder(dir.path()).is_err());
        assert!(skin_folder(&dir.path().join("missing")).is_err());
        fs::write(dir.path().join("skininfo.json"), "{}").unwrap();
        assert_eq!(
            skin_folder(dir.path()).unwrap(),
            dir.path().canonicalize().unwrap()
        );
        let ini = tempfile::tempdir().unwrap();
        fs::write(ini.path().join("skin.ini"), "[General]\n").unwrap();
        assert!(skin_folder(ini.path()).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn added_folders_reject_symlinked_markers() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("skin.ini")).unwrap();
        assert!(skin_folder(dir.path()).is_err());
    }
    #[test]
    fn reads_general_name() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("skin.ini"),
            "// x\r\n[General]\r\nAuthor: a\r\nName:  Proof Skin \r\n[Colours]\r\nName: no\r\n",
        )
        .unwrap();
        assert_eq!(ini_name(dir.path()).as_deref(), Some("Proof Skin"));
        fs::write(dir.path().join("skin.ini"), "[Colours]\nName: x\n").unwrap();
        assert_eq!(ini_name(dir.path()), None);
    }
    #[test]
    fn current_skin_from_lazer_and_stable_contexts() {
        let lazer: Context = serde_json::from_str(
            r#"{"client":"lazer","osu_dir":null,"skin":{"name":"Exusiai","folder":null,"files":true,"builtin":null}}"#,
        )
        .unwrap();
        assert_eq!(lazer.client.as_deref(), Some("lazer"));
        let skin = CurrentSkin::from(lazer.skin.unwrap());
        assert!(skin.files && skin.builtin.is_none());
        let builtin: SkinContext = serde_json::from_str(
            r#"{"name":"argon","folder":null,"files":false,"builtin":"argon"}"#,
        )
        .unwrap();
        let skin = CurrentSkin::from(builtin);
        assert!(!skin.files);
        assert_eq!(skin.builtin.as_deref(), Some("argon"));
        // Hosts before lazer skin files: no `files`; a stable folder implies files.
        let stable: SkinContext =
            serde_json::from_str(r#"{"name":"Arturia","folder":"/osu/Skins/Arturia"}"#).unwrap();
        assert!(CurrentSkin::from(stable).files);
        let old_lazer: SkinContext =
            serde_json::from_str(r#"{"name":"Arturia","folder":null}"#).unwrap();
        assert!(!CurrentSkin::from(old_lazer).files);
    }
    #[test]
    fn persists_added_folders() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data/folders.json");
        store(&file, &[PathBuf::from("/a"), PathBuf::from("/b")]).unwrap();
        let back: Vec<PathBuf> = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(back, [PathBuf::from("/a"), PathBuf::from("/b")]);
    }
}
