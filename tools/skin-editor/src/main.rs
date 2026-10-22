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
use vosu_tool_sdk::{Client, ToolEnv};

type Failure = (StatusCode, String);
fn failure(error: impl std::fmt::Display) -> Failure {
    (StatusCode::BAD_REQUEST, error.to_string())
}
#[derive(Deserialize)]
struct Context {
    osu_dir: Option<PathBuf>,
    skin: Option<SkinContext>,
}
#[derive(Deserialize)]
struct SkinContext {
    folder: Option<PathBuf>,
}
#[derive(Clone)]
struct App {
    client: Client,
    writes: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Serialize)]
struct Skin {
    name: String,
    folder: String,
    current: bool,
}
async fn allowed(app: &App) -> Result<Vec<Skin>, Failure> {
    let context: Context = app.client.host("context").await.map_err(failure)?;
    let mut skins = Vec::new();
    if let Some(osu) = context.osu_dir {
        let root = osu.join("Skins").canonicalize().map_err(failure)?;
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
                current: context
                    .skin
                    .as_ref()
                    .and_then(|s| s.folder.as_ref())
                    .and_then(|p| p.canonicalize().ok())
                    .as_ref()
                    == Some(&folder),
                folder: folder.to_string_lossy().into_owned(),
            });
        }
    }
    skins.sort_by_cached_key(|skin| skin.name.to_lowercase());
    Ok(skins)
}
async fn list(State(app): State<App>) -> Result<Json<Vec<Skin>>, Failure> {
    Ok(Json(allowed(&app).await?))
}
#[derive(Deserialize)]
struct Selection {
    folder: String,
}
async fn selected(app: &App, folder: &str) -> Result<PathBuf, Failure> {
    let skins = allowed(app).await?;
    skins
        .into_iter()
        .find(|s| s.folder == folder)
        .map(|s| PathBuf::from(s.folder))
        .ok_or_else(|| failure("Select a stable skin from the context's Skins directory."))
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
    let app = App {
        client: env.client(),
        writes: Arc::new(tokio::sync::Mutex::new(())),
    };
    vosu_tool_sdk::serve(
        &env,
        Router::new()
            .route("/v1/skins", get(list))
            .route("/v1/skin", get(read))
            .route("/v1/save", post(save))
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
}
