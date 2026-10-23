//! Skin sources: stable `Skins/` folders, folders added by path, and lazer
//! skins read through the optional `lazer-library` tool.

use crate::{App, Failure, failure};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub const LAZER_TOOL: &str = "lazer-library";
const LAZER_PREFIX: &str = "lazer:";
pub const MAX_FILES: usize = 50_000;

#[derive(Deserialize)]
struct Context {
    #[serde(default)]
    client: Option<String>,
    osu_dir: Option<PathBuf>,
    skin: Option<SkinContext>,
}
#[derive(Deserialize)]
pub struct SkinContext {
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
#[derive(Serialize, Debug)]
pub struct CurrentSkin {
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

/// Effective `settings.json` values.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub stable_skins_dir: String,
    pub export_dir: String,
    pub open_osk: bool,
    pub credits: bool,
    pub lazer_skins: bool,
    pub start_ruleset: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            stable_skins_dir: String::new(),
            export_dir: String::new(),
            open_osk: true,
            credits: true,
            lazer_skins: true,
            start_ruleset: "follow".into(),
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Stable,
    Added,
    Lazer,
}
#[derive(Serialize, Clone, Debug)]
pub struct Skin {
    /// Stable/added: the absolute folder. Lazer: `lazer:<id>`.
    pub key: String,
    pub name: String,
    pub origin: Origin,
    pub current: bool,
    /// False when an added folder vanished or no longer looks like a skin.
    pub available: bool,
    /// skin.ini can be saved in place (folders only).
    pub writable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builtin: Option<String>,
}
#[derive(Serialize, Debug)]
pub struct LazerStatus {
    pub enabled: bool,
    pub available: bool,
    pub error: Option<String>,
}
#[derive(Serialize, Debug)]
pub struct UiSettings {
    pub start_ruleset: String,
    pub open_osk: bool,
    pub credits: bool,
}
#[derive(Serialize, Debug)]
pub struct Library {
    pub client: Option<String>,
    pub current: Option<CurrentSkin>,
    /// Where new stable skins are created; null when unknown.
    pub stable_dir: Option<String>,
    pub export_dir: String,
    pub lazer: LazerStatus,
    pub settings: UiSettings,
    pub skins: Vec<Skin>,
}

/// One resolved, readable skin.
#[derive(Clone, Debug)]
pub enum Source {
    Folder(PathBuf),
    Lazer(String),
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
}

pub async fn settings(app: &App) -> Settings {
    app.client.settings().await.unwrap_or_default()
}

/// `Name:` from a skin.ini `[General]` section.
pub fn ini_name(text: &str) -> Option<String> {
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
fn folder_ini_name(folder: &Path) -> Option<String> {
    let ini = folder.join("skin.ini");
    let meta = fs::symlink_metadata(&ini).ok()?;
    if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
        return None;
    }
    ini_name(&String::from_utf8_lossy(&fs::read(ini).ok()?))
}

/// Accepts only existing directories that contain a regular `skin.ini` or a
/// lazer `skininfo.json`, so writes can never target an arbitrary folder.
pub fn skin_folder(path: &Path) -> Result<PathBuf, Failure> {
    if !path.is_absolute() {
        return Err(failure("Use an absolute path"));
    }
    let folder = path
        .canonicalize()
        .map_err(|e| failure(format!("Cannot open {}: {e}", path.display())))?;
    if !folder.is_dir() {
        return Err(failure("Not a folder"));
    }
    let marker = |name: &str| {
        fs::symlink_metadata(folder.join(name))
            .map(|meta| meta.is_file())
            .unwrap_or(false)
    };
    if !marker("skin.ini") && !marker("skininfo.json") {
        return Err(failure("No skin.ini or skininfo.json in that folder"));
    }
    Ok(folder)
}

/// The stable Skins folder new skins are written to.
pub fn stable_dir(settings: &Settings, osu_dir: Option<&Path>) -> Option<PathBuf> {
    let configured = settings.stable_skins_dir.trim();
    let dir = if configured.is_empty() {
        osu_dir?.join("Skins")
    } else {
        PathBuf::from(configured)
    };
    dir.canonicalize().ok().filter(|d| d.is_dir())
}

/// Export folder for .osk files: setting, else Downloads, else the data dir.
pub fn export_dir(settings: &Settings, data_dir: &Path) -> PathBuf {
    let configured = settings.export_dir.trim();
    if !configured.is_empty() {
        return PathBuf::from(configured);
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    home.map(|h| PathBuf::from(h).join("Downloads"))
        .filter(|d| d.is_dir())
        .unwrap_or_else(|| data_dir.join("exports"))
}

#[derive(Deserialize)]
struct LazerSkins {
    skins: Vec<LazerSkin>,
}
#[derive(Deserialize)]
struct LazerSkin {
    id: serde_json::Value,
    name: String,
    #[serde(default)]
    creator: Option<String>,
    #[serde(default)]
    builtin: Option<String>,
}
fn lazer_id(id: &serde_json::Value) -> String {
    match id {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// lazer-library is optional, so this tool does not list it in
/// `[[requires]]` (a missing dependency would block Skin studio). Its routes
/// are open read routes, which vosu refuses for undeclared tool tokens, so
/// they are requested like an overlay would: without this tool's token.
fn lazer_get(app: &App, path: &str) -> reqwest::RequestBuilder {
    app.http
        .get(app.client.url(&format!("/tools/{LAZER_TOOL}/api/{path}")))
}

async fn lazer_skins(app: &App) -> Result<Vec<LazerSkin>, String> {
    let response = lazer_get(app, "v1/skins")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    match response.status().as_u16() {
        200 => response
            .json::<LazerSkins>()
            .await
            .map(|s| s.skins)
            .map_err(|e| e.to_string()),
        404 => Err("lazer-library not installed".into()),
        // 503 comes from vosu (tool disabled, failed or untrusted) or from
        // lazer-library itself while its Realm snapshot is not readable.
        503 => {
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            let status = lazer_get(app, "v1/status")
                .send()
                .await
                .ok()
                .filter(|r| r.status().is_success());
            let status: serde_json::Value = match status {
                Some(r) => r.json().await.unwrap_or_default(),
                None => serde_json::Value::Null,
            };
            Err(match (status["error"].as_str(), status.is_object()) {
                (Some(error), _) => format!("lazer-library: {error}"),
                (None, true) => "Reading lazer…".into(),
                (None, false) => format!(
                    "lazer-library {}",
                    body["error"].as_str().unwrap_or("unavailable")
                ),
            })
        }
        status => Err(format!("lazer-library error {status}")),
    }
}

pub async fn library(app: &App) -> Result<Library, Failure> {
    let context: Context = app.client.host("context").await.map_err(failure)?;
    let settings = settings(app).await;
    let current_folder = context
        .skin
        .as_ref()
        .and_then(|s| s.folder.as_ref())
        .and_then(|p| p.canonicalize().ok());
    let current_name = context.skin.as_ref().and_then(|s| s.name.clone());
    let stable = stable_dir(&settings, context.osu_dir.as_deref());
    let mut skins = Vec::new();
    if let Some(root) = &stable {
        for entry in fs::read_dir(root).map_err(failure)? {
            let entry = entry.map_err(failure)?;
            if !entry.file_type().map_err(failure)?.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // Skip our own staging folders and other hidden folders.
            if name.starts_with('.') {
                continue;
            }
            let Ok(folder) = entry.path().canonicalize() else {
                continue;
            };
            if folder.parent() != Some(root.as_path()) {
                continue;
            }
            skins.push(Skin {
                key: folder.to_string_lossy().into_owned(),
                current: current_folder.as_ref() == Some(&folder),
                name,
                origin: Origin::Stable,
                available: true,
                writable: true,
                creator: None,
                builtin: None,
            });
        }
    }
    skins.sort_by_cached_key(|skin| skin.name.to_lowercase());
    for folder in app.added.lock().await.iter() {
        let key = folder.to_string_lossy().into_owned();
        if skins.iter().any(|s| s.key == key) {
            continue;
        }
        let available = skin_folder(folder).is_ok_and(|f| &f == folder);
        skins.push(Skin {
            name: folder_ini_name(folder)
                .or_else(|| folder.file_name().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_else(|| key.clone()),
            current: current_folder.as_ref() == Some(folder),
            key,
            origin: Origin::Added,
            available,
            writable: available,
            creator: None,
            builtin: None,
        });
    }
    let mut lazer = LazerStatus {
        enabled: settings.lazer_skins,
        available: false,
        error: None,
    };
    if settings.lazer_skins {
        match lazer_skins(app).await {
            Ok(mut list) => {
                lazer.available = true;
                let lazer_client = context.client.as_deref() == Some("lazer");
                list.sort_by_cached_key(|s| (s.builtin.is_some(), s.name.to_lowercase()));
                for skin in list {
                    skins.push(Skin {
                        key: format!("{LAZER_PREFIX}{}", lazer_id(&skin.id)),
                        current: lazer_client && current_name.as_deref() == Some(&skin.name),
                        name: skin.name,
                        origin: Origin::Lazer,
                        // Built-in lazer skins have no files to browse or mix.
                        available: skin.builtin.is_none(),
                        writable: false,
                        creator: skin.creator,
                        builtin: skin.builtin,
                    });
                }
            }
            Err(error) => lazer.error = Some(error),
        }
    }
    *app.known.lock().await = Some((
        std::time::Instant::now(),
        skins.iter().filter(|s| s.available).cloned().collect(),
    ));
    Ok(Library {
        client: context.client,
        current: context.skin.map(CurrentSkin::from),
        stable_dir: stable.map(|d| d.to_string_lossy().into_owned()),
        export_dir: export_dir(&settings, &app.data_dir)
            .to_string_lossy()
            .into_owned(),
        lazer,
        settings: UiSettings {
            start_ruleset: settings.start_ruleset,
            open_osk: settings.open_osk,
            credits: settings.credits,
        },
        skins,
    })
}

/// Resolves a library key to a readable source; unknown keys are refused so
/// read routes can never browse arbitrary folders.
/// Asset requests arrive in bursts, so the key list is reused for a few
/// seconds instead of re-reading context, settings and lazer per file.
pub async fn resolve(app: &App, key: &str) -> Result<(Source, Skin), Failure> {
    let cached = app.known.lock().await.as_ref().and_then(|(at, skins)| {
        (at.elapsed() < std::time::Duration::from_secs(5))
            .then(|| skins.iter().find(|s| s.key == key).cloned())
    });
    let skin = match cached {
        Some(Some(skin)) => skin,
        _ => library(app)
            .await?
            .skins
            .into_iter()
            .find(|s| s.key == key && s.available)
            .ok_or_else(|| failure("Not in the library"))?,
    };
    let source = match key.strip_prefix(LAZER_PREFIX) {
        Some(id) => Source::Lazer(id.to_owned()),
        None => Source::Folder(PathBuf::from(key)),
    };
    Ok((source, skin))
}

/// A skin-relative path with only normal components (no root, `..`, or `.`).
pub fn relative(name: &str) -> Result<PathBuf, Failure> {
    let path = Path::new(name);
    if name.is_empty()
        || name.contains('\\')
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(failure(format!("Invalid skin file path: {name}")));
    }
    Ok(path.to_path_buf())
}

fn walk(folder: &Path, relative: &Path, files: &mut Vec<FileEntry>) -> Result<(), Failure> {
    if relative.components().count() > 16 || files.len() > MAX_FILES {
        return Err(failure("Skin file tree exceeds safe limits."));
    }
    for entry in fs::read_dir(folder.join(relative)).map_err(failure)? {
        let entry = entry.map_err(failure)?;
        let ty = entry.file_type().map_err(failure)?;
        let path = relative.join(entry.file_name());
        if ty.is_dir() {
            walk(folder, &path, files)?;
        } else if ty.is_file() {
            files.push(FileEntry {
                name: path.to_string_lossy().replace('\\', "/"),
                size: entry.metadata().map_err(failure)?.len(),
            });
        }
    }
    Ok(())
}

impl Source {
    pub async fn files(&self, app: &App) -> Result<Vec<FileEntry>, Failure> {
        let mut files = match self {
            Source::Folder(folder) => {
                let folder = folder.clone();
                tokio::task::spawn_blocking(move || {
                    let mut files = Vec::new();
                    walk(&folder, Path::new(""), &mut files).map(|_| files)
                })
                .await
                .map_err(failure)??
            }
            Source::Lazer(id) => {
                #[derive(Deserialize)]
                struct Files {
                    files: Vec<FileEntry>,
                }
                let response = lazer_get(app, &format!("v1/skins/{}/files", segment(id)))
                    .send()
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
                if !response.status().is_success() {
                    return Err((
                        StatusCode::BAD_GATEWAY,
                        format!("lazer-library answered {}", response.status()),
                    ));
                }
                response
                    .json::<Files>()
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?
                    .files
            }
        };
        files.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(files)
    }

    pub async fn read(&self, app: &App, name: &str) -> Result<Vec<u8>, Failure> {
        let rel = relative(name)?;
        match self {
            Source::Folder(folder) => {
                let folder = folder.clone();
                tokio::task::spawn_blocking(move || {
                    let path = folder
                        .join(&rel)
                        .canonicalize()
                        .map_err(|_| (StatusCode::NOT_FOUND, "No such skin file.".to_owned()))?;
                    if !path.starts_with(&folder) || !path.is_file() {
                        return Err((StatusCode::NOT_FOUND, "No such skin file.".to_owned()));
                    }
                    fs::read(path).map_err(failure)
                })
                .await
                .map_err(failure)?
            }
            Source::Lazer(id) => {
                let path = format!(
                    "v1/skins/{}/file/{}",
                    segment(id),
                    name.split('/').map(segment).collect::<Vec<_>>().join("/")
                );
                let response = lazer_get(app, &path)
                    .send()
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
                if response.status() == 404 {
                    return Err((StatusCode::NOT_FOUND, "No such skin file.".into()));
                }
                if !response.status().is_success() {
                    return Err((
                        StatusCode::BAD_GATEWAY,
                        format!("lazer-library answered {}", response.status()),
                    ));
                }
                Ok(response
                    .bytes()
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?
                    .to_vec())
            }
        }
    }

    /// skin.ini text, or empty when the skin has none.
    pub async fn ini(&self, app: &App) -> Result<Vec<u8>, Failure> {
        match self {
            Source::Folder(folder) => {
                let ini = crate::ini_path(folder)?;
                match fs::read(ini) {
                    Ok(bytes) => Ok(bytes),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
                    Err(e) => Err(failure(e)),
                }
            }
            Source::Lazer(_) => match self.read(app, "skin.ini").await {
                Err((StatusCode::NOT_FOUND, _)) => Ok(Vec::new()),
                other => other,
            },
        }
    }
}

/// Percent-encodes one URL path segment.
pub fn segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            ini_name(
                "// x\r\n[General]\r\nAuthor: a\r\nName:  Proof Skin \r\n[Colours]\r\nName: no\r\n"
            )
            .as_deref(),
            Some("Proof Skin")
        );
        assert_eq!(ini_name("[Colours]\nName: x\n"), None);
    }
    #[test]
    fn current_skin_from_contexts() {
        let builtin: SkinContext = serde_json::from_str(
            r#"{"name":"argon","folder":null,"files":false,"builtin":"argon"}"#,
        )
        .unwrap();
        let skin = CurrentSkin::from(builtin);
        assert!(!skin.files);
        assert_eq!(skin.builtin.as_deref(), Some("argon"));
        let stable: SkinContext =
            serde_json::from_str(r#"{"name":"Arturia","folder":"/osu/Skins/Arturia"}"#).unwrap();
        assert!(CurrentSkin::from(stable).files);
    }
    #[test]
    fn relative_paths_stay_inside() {
        assert!(relative("mania/note1.png").is_ok());
        for bad in [
            "",
            "../x.png",
            "/etc/passwd",
            "a/../../b",
            "a\\b.png",
            "./x",
        ] {
            assert!(relative(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn settings_defaults_and_paths() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.open_osk && s.credits && s.lazer_skins);
        let dir = tempfile::tempdir().unwrap();
        let skins = dir.path().join("Skins");
        fs::create_dir(&skins).unwrap();
        assert_eq!(
            stable_dir(&s, Some(dir.path())),
            Some(skins.canonicalize().unwrap())
        );
        assert_eq!(stable_dir(&s, None), None);
        let custom = Settings {
            export_dir: "/tmp/x".into(),
            ..s
        };
        assert_eq!(export_dir(&custom, dir.path()), PathBuf::from("/tmp/x"));
        assert_eq!(segment("a b/é"), "a%20b%2F%C3%A9");
    }
}
