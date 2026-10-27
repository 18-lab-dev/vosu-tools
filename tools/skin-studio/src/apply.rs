//! Applying a draft to the skin it edits, Skin studio's default target.
//!
//! The page keeps every edit in a draft; nothing here runs until the user
//! presses Apply changes. A review lists exactly what an apply writes where
//! and carries a revision of the files it read, so an apply refuses when the
//! skin changed on disk after the user confirmed.
//!
//! - **Folders** (stable and added skins): only changed files are written,
//!   each staged next to its target and renamed into place; every file
//!   replaced or removed is first copied into a timestamped backup under the
//!   data dir (`backups/<id>/`), and the newest apply can be restored. Files
//!   the draft does not name are never touched; files are removed only when
//!   the draft removes them explicitly.
//! - **osu!lazer**: lazer keeps skins in its own file store. When lazer's
//!   "Edit externally" has the skin mounted (`<temp>/<skin hash>`,
//!   `RealmArchiveModelImporter.BeginExternalEditing`), the draft is applied
//!   into that folder like a stable one and lazer's "Finish editing" replaces
//!   the skin in place (`SkinImporter.ImportAsUpdate`, same skin ID).
//!   Otherwise the edited skin is imported as a new skin named
//!   `<name> [vosu edit N]`: an import whose skin.ini differs always becomes
//!   a new skin, since lazer's skin hash covers only `.ini`/`.json` files
//!   (`SkinImporter.HashableFileTypes`, `RealmArchiveModelImporter.CheckForExisting`).
//!   The `.osk` is handed to the running lazer by starting its executable
//!   with the path, which forwards it over lazer's IPC and exits
//!   (`osu.Desktop/Program.cs`, `ArchiveImportIPCChannel`).

use crate::{
    App, Failure,
    build::{self, Plan},
    failure,
    library::{self, Origin, Source, relative},
};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tempfile::{NamedTempFile, PersistError};
use tokio::sync::mpsc;

#[derive(Deserialize)]
pub struct Request {
    /// Library key of the skin the draft edits.
    pub skin: String,
    pub plan: Plan,
    /// Files of the skin the draft removes explicitly (a group set to the
    /// built-in look).
    #[serde(default)]
    pub remove: Vec<String>,
    /// The revision of the review the user confirmed; absent for a review.
    #[serde(default)]
    pub revision: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Add,
    Replace,
    Remove,
}

#[derive(Serialize, Clone, Debug)]
pub struct Change {
    pub path: String,
    pub action: Action,
    /// Size written (add / replace) or removed.
    pub bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Target {
    /// A stable or added skin folder.
    Folder { path: String },
    /// lazer's "Edit externally" folder for this skin.
    Mounted { path: String },
    /// Imported into osu!lazer as a new skin.
    Import {
        name: String,
        /// The running lazer that will receive the file, if one was found.
        lazer: Option<String>,
    },
}

#[derive(Serialize)]
pub struct Review {
    pub target: Target,
    pub changes: Vec<Change>,
    pub revision: String,
}

#[derive(Serialize)]
pub struct Applied {
    pub target: Target,
    pub changes: Vec<Change>,
    /// Backup id (folders), for restoring.
    pub backup: Option<String>,
    /// Import: the written `.osk`, and whether lazer was asked to open it.
    pub file: Option<String>,
    pub opened: bool,
}

struct Planned {
    change: Change,
    /// New content; none for a removal.
    content: Option<Vec<u8>>,
}

/// Where the skin's current files are read from.
enum Existing {
    Folder(PathBuf),
    Source(Source),
}
impl Existing {
    async fn read(&self, app: &App, path: &str) -> Result<Option<Vec<u8>>, Failure> {
        match self {
            Existing::Folder(folder) => {
                let target = safe_target(folder, path)?;
                match fs::read(target) {
                    Ok(bytes) => Ok(Some(bytes)),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(e) => Err(failure(format!("{path}: {e}"))),
                }
            }
            Existing::Source(source) => match source.read(app, path).await {
                Ok(bytes) => Ok(Some(bytes)),
                Err((StatusCode::NOT_FOUND, _)) => Ok(None),
                Err(error) => Err(error),
            },
        }
    }
}

/// `folder/rel`, refusing paths that leave the folder or pass a symlink.
pub fn safe_target(folder: &Path, rel: &str) -> Result<PathBuf, Failure> {
    let rel = relative(rel)?;
    let mut at = folder.to_path_buf();
    for part in rel.components() {
        at.push(part);
        if let Ok(meta) = fs::symlink_metadata(&at)
            && meta.file_type().is_symlink()
        {
            return Err(failure(format!("{} is a symlink.", at.display())));
        }
    }
    Ok(at)
}

/// The new skin.ini bytes for `new` text replacing `old` bytes: lines the
/// draft did not change keep their own line ending, and a BOM stays.
pub fn preserve_ini(old: &[u8], new: &str) -> Vec<u8> {
    const BOM: &str = "\u{feff}";
    let old = String::from_utf8_lossy(old);
    let bom = old.starts_with(BOM);
    let old = old.strip_prefix(BOM).unwrap_or(&old);
    let new = new.strip_prefix(BOM).unwrap_or(new);
    let split = |text: &str| -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut rest = text;
        while !rest.is_empty() {
            let end = rest.find(['\r', '\n']).unwrap_or(rest.len());
            let (line, tail) = rest.split_at(end);
            let eol = if tail.starts_with("\r\n") {
                "\r\n"
            } else if tail.starts_with('\r') || tail.starts_with('\n') {
                &tail[..1]
            } else {
                ""
            };
            out.push((line.to_owned(), eol.to_owned()));
            rest = &tail[eol.len()..];
        }
        out
    };
    let (a, b) = (split(old), split(new));
    // Matched lines keep the old ending: the common prefix and suffix one to
    // one (a draft changes a few lines in one place, and repeated lines such
    // as blank ones must not trade endings), then the longest common
    // subsequence of the lines between.
    let (n, m) = (a.len(), b.len());
    let mut keep = vec![None; m];
    let mut head = 0;
    while head < n && head < m && a[head].0 == b[head].0 {
        keep[head] = Some(head);
        head += 1;
    }
    let mut tail = 0;
    while tail < n - head && tail < m - head && a[n - 1 - tail].0 == b[m - 1 - tail].0 {
        keep[m - 1 - tail] = Some(n - 1 - tail);
        tail += 1;
    }
    let (a_mid, b_mid) = (&a[head..n - tail], &b[head..m - tail]);
    let (n, m) = (a_mid.len(), b_mid.len());
    if n * m <= 16_000_000 {
        let mut table = vec![0u32; (n + 1) * (m + 1)];
        let at = |i: usize, j: usize| i * (m + 1) + j;
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                table[at(i, j)] = if a_mid[i].0 == b_mid[j].0 {
                    table[at(i + 1, j + 1)] + 1
                } else {
                    table[at(i + 1, j)].max(table[at(i, j + 1)])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if a_mid[i].0 == b_mid[j].0 {
                keep[head + j] = Some(head + i);
                i += 1;
                j += 1;
            } else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    let mut out = String::with_capacity(new.len() + 3);
    if bom {
        out.push_str(BOM);
    }
    for (j, (line, eol)) in b.iter().enumerate() {
        out.push_str(line);
        match keep[j] {
            // The old line's ending, unless it was the old last line without one.
            Some(i) if !a[i].1.is_empty() || eol.is_empty() => out.push_str(&a[i].1),
            _ => out.push_str(eol),
        }
    }
    out.into_bytes()
}

/// `text` with `[General]`'s `Name` set to `name`, other lines untouched.
pub fn set_general_name(text: &str, name: &str) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(text.len() + name.len() + 16);
    let (mut section, mut done, mut seen_general) = (String::new(), false, false);
    let mut rest = text;
    while !rest.is_empty() {
        let end = rest.find('\n').map_or(rest.len(), |i| i + 1);
        let (line, tail) = rest.split_at(end);
        rest = tail;
        let trimmed = line.trim();
        if let Some(header) = trimmed.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
            if section.eq_ignore_ascii_case("General") && !done {
                out.push_str(&format!("Name: {name}{eol}"));
                done = true;
            }
            section = header.trim().to_owned();
            seen_general |= section.eq_ignore_ascii_case("General");
        } else if section.eq_ignore_ascii_case("General")
            && !done
            && trimmed
                .split_once(':')
                .is_some_and(|(k, _)| k.trim() == "Name")
        {
            let ending = &line[line.trim_end_matches(['\r', '\n']).len()..];
            let indent = &line[..line.len() - line.trim_start().len()];
            out.push_str(&format!("{indent}Name: {name}{ending}"));
            done = true;
            continue;
        }
        out.push_str(line);
    }
    if !done {
        if seen_general {
            if !out.ends_with('\n') && !out.is_empty() {
                out.push_str(eol);
            }
            out.push_str(&format!("Name: {name}{eol}"));
        } else {
            out = format!("[General]{eol}Name: {name}{eol}{out}");
        }
    }
    out
}

/// The name of the next lazer import of `name`: `<root> [vosu edit N]`, with
/// N one more than any such skin lazer has, and characters Windows refuses
/// in file names replaced (the `.osk` must carry the same name, or lazer
/// appends the archive name).
pub fn import_name(name: &str, existing: &[String]) -> String {
    let root = match name.rfind(" [vosu edit ") {
        Some(at) if name.ends_with(']') => &name[..at],
        _ => name,
    };
    let clean: String = root
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim().trim_matches('.').trim();
    let clean = if clean.is_empty() { "Skin" } else { clean };
    let prefix = format!("{clean} [vosu edit ");
    let next = existing
        .iter()
        .filter_map(|n| {
            n.strip_prefix(&prefix)?
                .strip_suffix(']')?
                .parse::<u32>()
                .ok()
        })
        .max()
        .unwrap_or(0)
        + 1;
    format!("{prefix}{next}]")
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// lazer's mounted "Edit externally" folder for a skin hash, if present.
pub fn mounted(hash: &str, temp: &[PathBuf]) -> Option<PathBuf> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    temp.iter()
        .map(|t| t.join(hash))
        .find(|dir| fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()))
}

fn temp_dirs() -> Vec<PathBuf> {
    // .NET's Path.GetTempPath: TMPDIR or /tmp on Unix, %TEMP% on Windows.
    let mut dirs = vec![std::env::temp_dir()];
    if cfg!(unix) && !dirs.contains(&PathBuf::from("/tmp")) {
        dirs.push("/tmp".into());
    }
    dirs
}

#[derive(Deserialize)]
struct LazerSkin {
    id: serde_json::Value,
    name: Option<String>,
    #[serde(default)]
    hash: Option<String>,
}
async fn lazer_skins(app: &App) -> Result<Vec<LazerSkin>, Failure> {
    #[derive(Deserialize)]
    struct List {
        skins: Vec<LazerSkin>,
    }
    let response = library::lazer_get(app, "v1/skins")
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    if !response.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("lazer-library answered {}", response.status()),
        ));
    }
    Ok(response
        .json::<List>()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?
        .skins)
}

/// The skin a draft applies to and where its current files are read.
async fn target(app: &App, key: &str) -> Result<(Target, Existing), Failure> {
    let (source, skin) = library::resolve(app, key).await?;
    match source {
        Source::Folder(folder) if matches!(skin.origin, Origin::Stable | Origin::Added) => {
            if !skin.writable {
                return Err(failure(format!("{} is not writable.", folder.display())));
            }
            Ok((
                Target::Folder {
                    path: folder.to_string_lossy().into_owned(),
                },
                Existing::Folder(folder),
            ))
        }
        Source::Lazer(id) => {
            let skins = lazer_skins(app).await?;
            let hash = skins
                .iter()
                .find(|s| library::lazer_id(&s.id) == id)
                .and_then(|s| s.hash.clone());
            if let Some(dir) = hash.and_then(|h| mounted(&h, &temp_dirs())) {
                return Ok((
                    Target::Mounted {
                        path: dir.to_string_lossy().into_owned(),
                    },
                    Existing::Folder(dir),
                ));
            }
            let names: Vec<String> = skins.into_iter().filter_map(|s| s.name).collect();
            Ok((
                Target::Import {
                    name: import_name(&skin.name, &names),
                    lazer: find_lazer().map(|l| l.exe.to_string_lossy().into_owned()),
                },
                Existing::Source(Source::Lazer(id)),
            ))
        }
        _ => Err(failure(
            "This skin is read-only (an .osk file or dropped files): export it instead.",
        )),
    }
}

#[derive(Default)]
struct Collector {
    planned: Vec<Planned>,
    revision: Sha256,
    total: u64,
    /// Lower-cased output paths, written or unchanged.
    outputs: HashSet<String>,
}
impl Collector {
    fn put(&mut self, path: &str, old: Option<Vec<u8>>, new: Vec<u8>) -> Result<(), Failure> {
        self.outputs.insert(path.to_lowercase());
        if old.as_deref() == Some(new.as_slice()) {
            return Ok(());
        }
        self.total += new.len() as u64;
        if self.total > build::MAX_TOTAL_BYTES {
            return Err(failure("The changes exceed 2 GiB."));
        }
        self.revision.update(format!(
            "{path}\0{}\n",
            old.as_deref().map(sha).unwrap_or_default()
        ));
        self.planned.push(Planned {
            change: Change {
                path: path.to_owned(),
                action: if old.is_some() {
                    Action::Replace
                } else {
                    Action::Add
                },
                bytes: new.len() as u64,
            },
            content: Some(new),
        });
        Ok(())
    }
}

/// Every file the draft changes, compared with the skin's current files.
async fn plan(
    app: &App,
    request: &Request,
    existing: &Existing,
) -> Result<(Vec<Planned>, String), Failure> {
    build::targets(&request.plan)?;
    let mut c = Collector::default();
    for source in &request.plan.sources {
        let (resolved, _) = library::resolve(app, &source.skin).await?;
        for file in &source.files {
            let (from, to) = file.parts();
            // The skin's own file at its own path: unchanged by construction.
            if source.skin == request.skin && from == to {
                c.outputs.insert(to.to_lowercase());
                continue;
            }
            let bytes = resolved.read(app, from).await.map_err(|(status, error)| {
                (status, format!("{from} from {}: {error}", source.skin))
            })?;
            let old = existing.read(app, to).await?;
            c.put(to, old, bytes)?;
        }
    }
    for item in &request.plan.blanks {
        let old = existing.read(app, &item.to).await?;
        c.put(&item.to, old, build::blank(item.kind))?;
    }
    for item in &request.plan.texts {
        let old = existing.read(app, &item.to).await?;
        c.put(&item.to, old, item.text.clone().into_bytes())?;
    }
    let old_ini = existing.read(app, "skin.ini").await?;
    let ini = preserve_ini(old_ini.as_deref().unwrap_or_default(), &request.plan.ini);
    c.put("skin.ini", old_ini, ini)?;
    let mut removed = HashSet::new();
    for path in &request.remove {
        relative(path)?;
        let lower = path.to_lowercase();
        if lower == "skin.ini" || c.outputs.contains(&lower) || !removed.insert(lower) {
            continue;
        }
        if let Some(old) = existing.read(app, path).await? {
            c.revision.update(format!("{path}\0{}\n", sha(&old)));
            c.planned.push(Planned {
                change: Change {
                    path: path.clone(),
                    action: Action::Remove,
                    bytes: old.len() as u64,
                },
                content: None,
            });
        }
    }
    let Collector {
        mut planned,
        revision,
        ..
    } = c;
    planned.sort_by(|a, b| a.change.path.cmp(&b.change.path));
    let revision = revision
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok((planned, revision))
}

pub async fn review(app: &App, request: Request) -> Result<Review, Failure> {
    let (target, existing) = target(app, &request.skin).await?;
    let (planned, revision) = plan(app, &request, &existing).await?;
    Ok(Review {
        target,
        changes: planned.into_iter().map(|p| p.change).collect(),
        revision,
    })
}

pub async fn apply(app: &App, request: Request) -> Result<Applied, Failure> {
    let _write = app.writes.lock().await;
    let (target, existing) = target(app, &request.skin).await?;
    let (planned, revision) = plan(app, &request, &existing).await?;
    if request.revision.as_deref() != Some(revision.as_str()) {
        return Err((
            StatusCode::CONFLICT,
            "The skin changed since you reviewed the changes. Review them again.".into(),
        ));
    }
    let changes: Vec<Change> = planned.iter().map(|p| p.change.clone()).collect();
    match (&target, existing) {
        (Target::Folder { .. } | Target::Mounted { .. }, Existing::Folder(folder)) => {
            let backups = app.backups.to_path_buf();
            let key = request.skin.clone();
            let backup = tokio::task::spawn_blocking(move || {
                commit(&Disk, &folder, &key, planned, &backups)
            })
            .await
            .map_err(failure)??;
            Ok(Applied {
                target,
                changes,
                backup,
                file: None,
                opened: false,
            })
        }
        (Target::Import { name, .. }, _) => {
            let mut plan = request.plan;
            plan.ini = set_general_name(&plan.ini, name);
            plan.name = name.clone();
            let file = write_osk(app, plan).await?;
            let opened = match find_lazer() {
                Some(lazer) => {
                    launch(&lazer, &file)
                        .map_err(|e| failure(format!("Opening it in osu!lazer failed: {e}")))?;
                    true
                }
                None => false,
            };
            Ok(Applied {
                target,
                changes,
                backup: None,
                file: Some(file.to_string_lossy().into_owned()),
                opened,
            })
        }
        _ => Err(failure("Unsupported apply target.")),
    }
}

/// Streams the plan into `<data>/lazer-imports/<name>.osk` (lazer deletes an
/// imported `.osk`, `SkinImporter.ShouldDeleteArchive`).
async fn write_osk(app: &App, plan: Plan) -> Result<PathBuf, Failure> {
    let dir = app.imports.to_path_buf();
    fs::create_dir_all(&dir).map_err(failure)?;
    let file = dir.join(format!("{}.osk", build::skin_name(&plan.name)?));
    let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(failure)?;
    let (tx, mut rx) = mpsc::channel(8);
    let task = tokio::spawn(build::stream(app.clone(), plan, tx));
    while let Some(chunk) = rx.recv().await {
        let bytes = chunk.map_err(failure)?;
        temp.write_all(&bytes).map_err(failure)?;
    }
    task.await.map_err(failure)?;
    temp.as_file().sync_all().map_err(failure)?;
    temp.persist(&file).map_err(failure)?;
    Ok(file)
}

#[derive(Serialize, Deserialize)]
struct Record {
    path: String,
    action: Action,
    /// SHA-256 of what the apply wrote (add / replace).
    written: Option<String>,
}

/// Where an apply's backup stands.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Every change is in place (manifests from before this field, too).
    #[default]
    Applied,
    /// Renaming into the skin started and has not finished: the service
    /// stopped mid-apply.
    Applying,
    /// An apply or a restore failed and could not put every file back; the
    /// files listed in `failed` still differ from the backup.
    RollbackIncomplete,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Failed {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    skin: String,
    folder: String,
    created: u64,
    changes: Vec<Record>,
    #[serde(default)]
    restored: bool,
    #[serde(default)]
    status: Status,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    failed: Vec<Failed>,
    /// Folders the apply created (deepest last), removed again when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    dirs: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn sync_dir(_dir: &Path) {
    #[cfg(unix)]
    if let Err(e) = fs::File::open(_dir).and_then(|f| f.sync_all()) {
        eprintln!("skin-studio: syncing {}: {e}", _dir.display());
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), Failure> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(failure)?;
    }
    let mut file = fs::File::create(path).map_err(failure)?;
    file.write_all(bytes).map_err(failure)?;
    file.sync_all().map_err(failure)
}

/// The file operations an apply and a restore make inside a skin folder, so
/// tests can make any of them fail (`tests::Faulty`). [`Disk`] is the real one.
pub trait Fs {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    /// A synced temporary file holding `bytes` in `dir` (with `like`'s
    /// permissions when it exists), renamed into place by [`Fs::persist`].
    fn temp(&self, dir: &Path, bytes: &[u8], like: &Path) -> io::Result<NamedTempFile>;
    /// Renames `temp` over `target` (atomic on one volume).
    fn persist(&self, temp: NamedTempFile, target: &Path) -> Result<(), PersistError>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
    fn create_dir(&self, path: &Path) -> io::Result<()>;
    fn remove_dir(&self, path: &Path) -> io::Result<()>;
    /// Windows refusing a file another process holds open (osu! or lazer
    /// showing a skin image, a virus scanner): access denied, sharing or
    /// lock violation, delete pending. std maps none of these to a kind.
    fn sharing_violation(&self, error: &io::Error) -> bool {
        cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33 | 303))
    }
}

pub struct Disk;
impl Fs for Disk {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }
    fn temp(&self, dir: &Path, bytes: &[u8], like: &Path) -> io::Result<NamedTempFile> {
        let mut temp = tempfile::Builder::new()
            .prefix(".skin-studio-")
            .tempfile_in(dir)?;
        if let Ok(meta) = fs::metadata(like) {
            temp.as_file().set_permissions(meta.permissions())?;
        }
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        Ok(temp)
    }
    fn persist(&self, temp: NamedTempFile, target: &Path) -> Result<(), PersistError> {
        temp.persist(target).map(drop)
    }
    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
    fn create_dir(&self, path: &Path) -> io::Result<()> {
        fs::create_dir(path)
    }
    fn remove_dir(&self, path: &Path) -> io::Result<()> {
        fs::remove_dir(path)
    }
}

/// How long a file another process holds open is waited for.
const RETRY_FOR: Duration = Duration::from_secs(2);
const RETRY_EVERY: Duration = Duration::from_millis(50);

/// `op`, retried while Windows reports a sharing violation, for [`RETRY_FOR`].
fn retry<T>(fs: &dyn Fs, mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let deadline = Instant::now() + RETRY_FOR;
    loop {
        match op() {
            Err(e) if fs.sharing_violation(&e) && Instant::now() < deadline => {
                thread::sleep(RETRY_EVERY);
            }
            other => return other,
        }
    }
}

/// [`Fs::persist`] with the same retry; an unpersisted temp is deleted.
fn persist(fs: &dyn Fs, mut temp: NamedTempFile, target: &Path) -> io::Result<()> {
    let deadline = Instant::now() + RETRY_FOR;
    loop {
        match fs.persist(temp, target) {
            Ok(()) => return Ok(()),
            Err(e) if fs.sharing_violation(&e.error) && Instant::now() < deadline => {
                temp = e.file;
                thread::sleep(RETRY_EVERY);
            }
            Err(e) => return Err(e.error),
        }
    }
}

/// Removes `path`; already gone counts as removed.
fn remove(fs: &dyn Fs, path: &Path) -> io::Result<()> {
    match retry(fs, || fs.remove_file(path)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Writes `bytes` over `target` atomically: a temp file next to it, renamed.
fn put(fs: &dyn Fs, target: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("no parent folder"))?;
    persist(fs, fs.temp(parent, bytes, target)?, target)
}

/// Creates `dir` and its missing parents inside `folder`, recording each
/// folder made (outermost first).
fn make_dirs(fs: &dyn Fs, folder: &Path, dir: &Path, made: &mut Vec<PathBuf>) -> io::Result<()> {
    let missing: Vec<&Path> = dir
        .ancestors()
        .take_while(|d| *d != folder && d.starts_with(folder))
        .filter(|d| !d.is_dir())
        .collect();
    for d in missing.into_iter().rev() {
        match fs.create_dir(d) {
            Ok(()) => made.push(d.to_path_buf()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Removes folders an apply made, deepest first, when they are empty. One
/// that is not empty holds files someone else put there and stays.
fn unmake_dirs(fs: &dyn Fs, made: &[PathBuf]) {
    for d in made.iter().rev() {
        if let Err(e) = fs.remove_dir(d)
            && e.kind() != io::ErrorKind::NotFound
        {
            eprintln!("skin-studio: keeping folder {}: {e}", d.display());
        }
    }
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<(), Failure> {
    write_synced(
        &dir.join("manifest.json"),
        &serde_json::to_vec_pretty(manifest).map_err(failure)?,
    )
}

fn list(failed: &[Failed]) -> String {
    failed
        .iter()
        .map(|f| format!("{} ({})", f.path, f.error))
        .collect::<Vec<_>>()
        .join(", ")
}

/// One planned change with its paths resolved.
struct Step<'a> {
    planned: &'a Planned,
    target: PathBuf,
    /// The original's copy in the backup (replace / remove).
    backup: PathBuf,
}

/// Backs up, stages and renames the changes into `folder`. On a failure the
/// folder is put back as it was and the backup deleted; when putting back
/// fails too, the backup is kept, marked [`Status::RollbackIncomplete`],
/// and the error names the files and the backup folder so Restore last
/// apply can finish. Returns the backup id.
fn commit(
    fs: &dyn Fs,
    folder: &Path,
    key: &str,
    planned: Vec<Planned>,
    backups: &Path,
) -> Result<Option<String>, Failure> {
    if planned.is_empty() {
        return Ok(None);
    }
    let id = format!(
        "{}-{}",
        now(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let dir = backups.join(&id);
    let files = dir.join("files");
    // Every path first: a bad one fails before anything is written.
    let steps = planned
        .iter()
        .map(|p| {
            Ok(Step {
                planned: p,
                target: safe_target(folder, &p.change.path)?,
                backup: files.join(relative(&p.change.path)?),
            })
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    let mut manifest = Manifest {
        skin: key.to_owned(),
        folder: folder.to_string_lossy().into_owned(),
        created: now(),
        changes: planned
            .iter()
            .map(|p| Record {
                path: p.change.path.clone(),
                action: p.change.action,
                written: p.content.as_deref().map(sha),
            })
            .collect(),
        restored: false,
        status: Status::Applying,
        failed: Vec::new(),
        dirs: Vec::new(),
    };
    // 1-2. Back up and stage. Until the first rename the skin's own files are
    // unchanged: only new empty folders and temp files (deleted when dropped)
    // exist in it, so a failure here removes those and the backup.
    let mut made = Vec::new();
    let staged = match stage(fs, folder, &steps, &mut made, &dir, &mut manifest) {
        Ok(staged) => staged,
        Err(error) => {
            unmake_dirs(fs, &made);
            if let Err(e) = fs::remove_dir_all(&dir)
                && e.kind() != io::ErrorKind::NotFound
            {
                eprintln!("skin-studio: removing unused backup {}: {e}", dir.display());
            }
            return Err(error);
        }
    };
    // 3. Rename into place, then remove; put back on the first failure.
    let mut done: Vec<usize> = Vec::new();
    let mut error: Option<Failed> = None;
    for (i, temp) in staged {
        match persist(fs, temp, &steps[i].target) {
            Ok(()) => done.push(i),
            Err(e) => {
                error = Some(Failed {
                    path: steps[i].planned.change.path.clone(),
                    error: e.to_string(),
                });
                break;
            }
        }
    }
    if error.is_none() {
        for (i, step) in steps.iter().enumerate() {
            if step.planned.change.action != Action::Remove {
                continue;
            }
            match remove(fs, &step.target) {
                Ok(()) => done.push(i),
                Err(e) => {
                    error = Some(Failed {
                        path: step.planned.change.path.clone(),
                        error: e.to_string(),
                    });
                    break;
                }
            }
        }
    }
    sync_dir(folder);
    let Some(error) = error else {
        manifest.status = Status::Applied;
        // The skin is fully applied; a manifest left at `applying` only makes
        // the studio offer a restore, which then puts everything back.
        if let Err((_, e)) = write_manifest(&dir, &manifest) {
            eprintln!("skin-studio: finishing {}: {e}", dir.display());
        }
        return Ok(Some(id));
    };
    let failed = rollback(fs, &steps, &done);
    if failed.is_empty() {
        unmake_dirs(fs, &made);
        // Restored first, so a backup folder that cannot be deleted is never
        // offered for a restore.
        manifest.restored = true;
        let removed = write_manifest(&dir, &manifest)
            .map_err(|(_, e)| e)
            .and_then(|()| fs::remove_dir_all(&dir).map_err(|e| e.to_string()));
        if let Err(e) = removed {
            eprintln!("skin-studio: removing unused backup {}: {e}", dir.display());
        }
        return Err(failure(format!(
            "{}: {}. Nothing was changed.",
            error.path, error.error
        )));
    }
    manifest.status = Status::RollbackIncomplete;
    manifest.failed = failed;
    let marked = write_manifest(&dir, &manifest)
        .err()
        .map(|(_, e)| format!(" Recording this in the backup failed too: {e}."))
        .unwrap_or_default();
    Err(failure(format!(
        "{}: {}. Putting the skin back failed for {}; the originals are kept in {}. Close osu! and use Restore last apply to finish.{marked}",
        error.path,
        error.error,
        list(&manifest.failed),
        dir.display(),
    )))
}

/// Steps 1-2 of [`commit`]: originals into the backup, new contents staged
/// next to their targets, and the manifest (status `applying`) written.
fn stage(
    fs: &dyn Fs,
    folder: &Path,
    steps: &[Step],
    made: &mut Vec<PathBuf>,
    dir: &Path,
    manifest: &mut Manifest,
) -> Result<Vec<(usize, NamedTempFile)>, Failure> {
    for step in steps {
        if step.planned.change.action != Action::Add {
            let bytes = fs
                .read(&step.target)
                .map_err(|e| failure(format!("{}: {e}", step.planned.change.path)))?;
            write_synced(&step.backup, &bytes)?;
        }
    }
    let mut staged = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let Some(content) = &step.planned.content else {
            continue;
        };
        let parent = step.target.parent().unwrap_or(folder);
        let at = |e: io::Error| failure(format!("{}: {e}", step.planned.change.path));
        make_dirs(fs, folder, parent, made).map_err(at)?;
        staged.push((i, fs.temp(parent, content, &step.target).map_err(at)?));
    }
    manifest.dirs = made
        .iter()
        .filter_map(|d| d.strip_prefix(folder).ok())
        .map(|d| d.to_string_lossy().replace('\\', "/"))
        .collect();
    write_manifest(dir, manifest)?;
    Ok(staged)
}

/// Undoes the `done` steps, newest first; returns the ones that failed.
fn rollback(fs: &dyn Fs, steps: &[Step], done: &[usize]) -> Vec<Failed> {
    let mut failed = Vec::new();
    for &i in done.iter().rev() {
        let step = &steps[i];
        let result = match step.planned.change.action {
            Action::Add => remove(fs, &step.target),
            Action::Replace | Action::Remove => fs
                .read(&step.backup)
                .and_then(|bytes| put(fs, &step.target, &bytes)),
        };
        if let Err(e) = result {
            failed.push(Failed {
                path: step.planned.change.path.clone(),
                error: e.to_string(),
            });
        }
    }
    failed
}

#[derive(Serialize)]
pub struct LastApply {
    pub id: String,
    pub created: u64,
    pub changes: usize,
    pub status: Status,
    pub failed: Vec<Failed>,
}

fn manifests(backups: &Path, folder: Option<&Path>) -> Vec<(String, Manifest)> {
    let folder = folder.map(|f| f.to_string_lossy());
    let mut out: Vec<(String, Manifest)> = fs::read_dir(backups)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            let manifest: Manifest =
                serde_json::from_slice(&fs::read(entry.path().join("manifest.json")).ok()?).ok()?;
            (folder.as_deref().is_none_or(|f| manifest.folder == f) && !manifest.restored)
                .then_some((id, manifest))
        })
        .collect();
    out.sort_by(|a, b| (a.1.created, &a.0).cmp(&(b.1.created, &b.0)));
    out
}

/// The newest apply into a skin's folder that has not been restored.
pub async fn last(app: &App, key: &str) -> Result<Option<LastApply>, Failure> {
    let folder = match target(app, key).await? {
        (_, Existing::Folder(folder)) => folder,
        _ => return Ok(None),
    };
    Ok(manifests(&app.backups, Some(&folder))
        .pop()
        .map(|(id, m)| LastApply {
            id,
            created: m.created,
            changes: m.changes.len(),
            status: m.status,
            failed: m.failed,
        }))
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Unfinished {
    /// Library key of the skin, for Restore last apply.
    pub skin: String,
    pub folder: String,
    pub backup: String,
    pub status: Status,
    pub failed: Vec<Failed>,
}

/// Applies that did not finish: rolled back only partly, or stopped while
/// renaming. The studio offers to restore them when it opens.
pub fn unfinished(backups: &Path) -> Vec<Unfinished> {
    let mut out = Vec::new();
    for (id, m) in manifests(backups, None) {
        if m.status != Status::Applied {
            out.push(Unfinished {
                skin: m.skin,
                folder: m.folder,
                backup: backups.join(id).to_string_lossy().into_owned(),
                status: m.status,
                failed: m.failed,
            });
        }
    }
    out
}

#[derive(Serialize, Debug)]
pub struct Restored {
    pub backup: String,
    pub restored: usize,
    /// Files changed again after the apply, left as they are.
    pub skipped: Vec<String>,
}

pub async fn restore(app: &App, key: &str) -> Result<Restored, Failure> {
    let _write = app.writes.lock().await;
    let folder = match target(app, key).await? {
        (_, Existing::Folder(folder)) => folder,
        _ => return Err(failure("Only folder skins keep backups.")),
    };
    let backups = app.backups.to_path_buf();
    tokio::task::spawn_blocking(move || restore_folder(&Disk, &backups, &folder))
        .await
        .map_err(failure)?
}

fn read_current(fs: &dyn Fs, path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs.read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Puts back the newest unrestored apply into `folder`, by content: a file
/// already like its original is left alone, so a partly applied or partly
/// rolled back apply is finished too. A file that fails is reported and
/// the backup kept for another try.
fn restore_folder(fs: &dyn Fs, backups: &Path, folder: &Path) -> Result<Restored, Failure> {
    let (id, mut manifest) = manifests(backups, Some(folder))
        .pop()
        .ok_or_else(|| failure("No apply to restore."))?;
    let dir = backups.join(&id);
    let files = dir.join("files");
    let (mut restored, mut skipped, mut failed) = (0, Vec::new(), Vec::new());
    for record in manifest.changes.iter().rev() {
        let target = safe_target(folder, &record.path)?;
        let step = || -> io::Result<bool> {
            let current = read_current(fs, &target)?;
            let written = current.as_deref().map(sha) == record.written;
            match record.action {
                Action::Add if current.is_none() => Ok(false),
                Action::Add if written => remove(fs, &target).map(|()| true),
                Action::Replace | Action::Remove => {
                    let original = fs.read(
                        &files.join(relative(&record.path).map_err(|(_, e)| io::Error::other(e))?),
                    )?;
                    if current.as_deref() == Some(original.as_slice()) {
                        Ok(false)
                    } else if written || current.is_none() {
                        put(fs, &target, &original).map(|()| true)
                    } else {
                        Err(io::Error::new(
                            io::ErrorKind::AlreadyExists,
                            "changed since",
                        ))
                    }
                }
                Action::Add => Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "changed since",
                )),
            }
        };
        match step() {
            Ok(true) => restored += 1,
            Ok(false) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => skipped.push(record.path.clone()),
            Err(e) => failed.push(Failed {
                path: record.path.clone(),
                error: e.to_string(),
            }),
        }
    }
    if failed.is_empty() {
        let made: Vec<PathBuf> = manifest.dirs.iter().map(|d| folder.join(d)).collect();
        unmake_dirs(fs, &made);
    }
    sync_dir(folder);
    if !failed.is_empty() {
        manifest.status = Status::RollbackIncomplete;
        manifest.failed = failed;
        let marked = write_manifest(&dir, &manifest)
            .err()
            .map(|(_, e)| format!(" Recording this in the backup failed too: {e}."))
            .unwrap_or_default();
        return Err(failure(format!(
            "Restoring failed for {}; the originals are kept in {}. Close osu! and try again.{marked}",
            list(&manifest.failed),
            dir.display(),
        )));
    }
    manifest.restored = true;
    manifest.failed.clear();
    write_manifest(&dir, &manifest)?;
    Ok(Restored {
        backup: id,
        restored,
        skipped,
    })
}

/// A running osu!lazer: its executable, environment and working directory,
/// so a second start with a file path reaches it over IPC.
pub struct Lazer {
    pub exe: PathBuf,
    env: Option<Vec<(OsString, OsString)>>,
    cwd: Option<PathBuf>,
}

/// The running lazer: on Linux the process whose executable is `osu!` next
/// to `osu.Game.dll` (AppImage mounts included); on Windows the
/// Velopack-installed `%LOCALAPPDATA%\osulazer\current\osu!.exe`.
pub fn find_lazer() -> Option<Lazer> {
    #[cfg(target_os = "linux")]
    return lazer_in(Path::new("/proc"));
    #[cfg(windows)]
    return {
        let exe =
            PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(r"osulazer\current\osu!.exe");
        exe.is_file().then_some(Lazer {
            exe,
            env: None,
            cwd: None,
        })
    };
    #[cfg(not(any(target_os = "linux", windows)))]
    None
}

/// Scans a `/proc`-shaped directory for a running lazer.
#[cfg(target_os = "linux")]
pub fn lazer_in(proc: &Path) -> Option<Lazer> {
    let mut pids: Vec<u32> = fs::read_dir(proc)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse().ok())
        .collect();
    pids.sort_unstable();
    pids.into_iter().find_map(|pid| {
        let dir = proc.join(pid.to_string());
        let exe = fs::read_link(dir.join("exe")).ok()?;
        (exe.file_name()? == "osu!" && exe.with_file_name("osu.Game.dll").is_file())
            .then_some(())?;
        let env = fs::read(dir.join("environ")).ok().map(|bytes| {
            bytes
                .split(|&b| b == 0)
                .filter_map(|pair| {
                    let text = String::from_utf8_lossy(pair);
                    let (k, v) = text.split_once('=')?;
                    (!k.is_empty()).then(|| (k.into(), v.into()))
                })
                .collect()
        });
        Some(Lazer {
            exe,
            env,
            cwd: fs::read_link(dir.join("cwd")).ok(),
        })
    })
}

/// Starts lazer's executable with `file`; the new process hands the file to
/// the running game and exits (it never restarts the game).
pub fn launch(lazer: &Lazer, file: &Path) -> std::io::Result<()> {
    let mut command = Command::new(&lazer.exe);
    command
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(env) = &lazer.env {
        command.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    }
    if let Some(cwd) = lazer.cwd.as_ref().filter(|c| c.is_dir()) {
        command.current_dir(cwd);
    }
    let mut child = command.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planned(path: &str, action: Action, content: Option<&[u8]>) -> Planned {
        Planned {
            change: Change {
                path: path.into(),
                action,
                bytes: content.map_or(0, |c| c.len() as u64),
            },
            content: content.map(<[u8]>::to_vec),
        }
    }

    #[test]
    fn ini_keeps_bom_and_untouched_line_endings() {
        let old = "\u{feff}// hi\r\n[General]\nName: A\r\n[Mania]\r\nKeys: 4\r\nHitPosition: 455"
            .as_bytes();
        // The draft normalised every ending to CRLF and changed one line.
        let new = "// hi\r\n[General]\r\nName: A\r\n[Mania]\r\nKeys: 4\r\nHitPosition: 450\r\n";
        assert_eq!(
            String::from_utf8(preserve_ini(old, new)).unwrap(),
            "\u{feff}// hi\r\n[General]\nName: A\r\n[Mania]\r\nKeys: 4\r\nHitPosition: 450\r\n"
        );
        // Repeated blank lines keep their own endings around an edit.
        let old = b"a\r\n\n\r\nb: 1\r\n\n\r\nc\n";
        assert_eq!(
            String::from_utf8(preserve_ini(old, "a\r\n\r\n\r\nb: 2\r\n\r\n\r\nc\r\n")).unwrap(),
            "a\r\n\n\r\nb: 2\r\n\n\r\nc\n"
        );
        let old = "\u{feff}// hi\r\n[General]\nName: A\r\n[Mania]\r\nKeys: 4\r\nHitPosition: 455"
            .as_bytes();
        // Unchanged text gives the old bytes back exactly.
        let same = "// hi\r\n[General]\r\nName: A\r\n[Mania]\r\nKeys: 4\r\nHitPosition: 455";
        assert_eq!(preserve_ini(old, same), old);
    }

    #[test]
    fn general_name_is_set_in_place() {
        assert_eq!(
            set_general_name(
                "[General]\r\n  Name: Old\r\nAuthor: X\r\n[Mania]\r\nName: keep\r\n",
                "New"
            ),
            "[General]\r\n  Name: New\r\nAuthor: X\r\n[Mania]\r\nName: keep\r\n"
        );
        assert_eq!(
            set_general_name("[General]\nAuthor: X\n[Colours]\n", "N"),
            "[General]\nAuthor: X\nName: N\n[Colours]\n"
        );
        assert_eq!(
            set_general_name("[Mania]\nKeys: 4\n", "N"),
            "[General]\nName: N\n[Mania]\nKeys: 4\n"
        );
    }

    #[test]
    fn import_names_count_up_and_stay_file_safe() {
        let existing = vec![
            "Arturia [vosu edit 1]".to_owned(),
            "Arturia [vosu edit 3]".into(),
        ];
        assert_eq!(import_name("Arturia", &existing), "Arturia [vosu edit 4]");
        assert_eq!(
            import_name("Arturia [vosu edit 3]", &existing),
            "Arturia [vosu edit 4]"
        );
        assert_eq!(import_name("a/b: c?", &[]), "a_b_ c_ [vosu edit 1]");
        build::skin_name(&import_name("a/b: c?", &[])).unwrap();
    }

    #[test]
    fn mounted_folder_by_hash_only() {
        let temp = tempfile::tempdir().unwrap();
        let hash = "ab".repeat(32);
        assert!(mounted(&hash, &[temp.path().into()]).is_none());
        fs::create_dir(temp.path().join(&hash)).unwrap();
        assert_eq!(
            mounted(&hash, &[temp.path().into()]),
            Some(temp.path().join(&hash))
        );
        assert!(mounted("../etc", &[temp.path().into()]).is_none());
    }

    #[test]
    fn apply_backs_up_and_restore_puts_back() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, backups) = (dir.path().join("skin"), dir.path().join("backups"));
        fs::create_dir_all(folder.join("mania")).unwrap();
        fs::write(folder.join("skin.ini"), "[General]\r\nName: A\r\n").unwrap();
        fs::write(folder.join("mania/key.png"), b"old key").unwrap();
        fs::write(folder.join("gone.png"), b"gone").unwrap();
        fs::write(folder.join("other.png"), b"untouched").unwrap();
        let id = commit(
            &Disk,
            &folder,
            "skin",
            vec![
                planned(
                    "skin.ini",
                    Action::Replace,
                    Some(b"[General]\r\nName: B\r\n"),
                ),
                planned("mania/key.png", Action::Replace, Some(b"new key")),
                planned("skin-studio/7k/a.png", Action::Add, Some(b"added")),
                planned("gone.png", Action::Remove, None),
            ],
            &backups,
        )
        .unwrap()
        .unwrap();
        assert_eq!(fs::read(folder.join("mania/key.png")).unwrap(), b"new key");
        assert_eq!(
            fs::read(folder.join("skin-studio/7k/a.png")).unwrap(),
            b"added"
        );
        assert!(!folder.join("gone.png").exists());
        assert_eq!(
            fs::read(backups.join(&id).join("files/mania/key.png")).unwrap(),
            b"old key"
        );
        assert_eq!(
            fs::read(backups.join(&id).join("files/gone.png")).unwrap(),
            b"gone"
        );
        // No staging files are left behind.
        assert!(
            fs::read_dir(&folder)
                .unwrap()
                .flatten()
                .all(|e| !e.file_name().to_string_lossy().starts_with('.'))
        );
        // A file changed again after the apply is kept.
        fs::write(folder.join("skin-studio/7k/a.png"), b"edited by hand").unwrap();
        let restored = restore_folder(&Disk, &backups, &folder).unwrap();
        assert_eq!(restored.restored, 3);
        assert_eq!(restored.skipped, ["skin-studio/7k/a.png"]);
        assert_eq!(
            fs::read_to_string(folder.join("skin.ini")).unwrap(),
            "[General]\r\nName: A\r\n"
        );
        assert_eq!(fs::read(folder.join("mania/key.png")).unwrap(), b"old key");
        assert_eq!(fs::read(folder.join("gone.png")).unwrap(), b"gone");
        assert_eq!(fs::read(folder.join("other.png")).unwrap(), b"untouched");
        // Restored once only.
        assert!(restore_folder(&Disk, &backups, &folder).is_err());
    }

    /// [`Disk`] with injected failures, a test-only failpoint layer.
    struct Faulty {
        faults: std::sync::Mutex<Vec<Fault>>,
        /// Classify errors as Windows does (codes 5/32/33/303).
        windows: bool,
    }
    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Op {
        Read,
        Temp,
        Persist,
        Remove,
    }
    struct Fault {
        op: Op,
        /// Matched against the end of the path (`files/x` is a backup copy).
        path: &'static str,
        /// Calls that succeed before the failures start.
        after: usize,
        /// Failing calls (`usize::MAX`: every one).
        times: usize,
        /// A raw OS error code, else a permission error.
        code: Option<i32>,
    }
    impl Faulty {
        fn new(windows: bool, faults: Vec<Fault>) -> Self {
            Self {
                faults: std::sync::Mutex::new(faults),
                windows,
            }
        }
        fn clear(&self) {
            self.faults.lock().unwrap().clear();
        }
        fn hit(&self, op: Op, path: &Path) -> io::Result<()> {
            for f in self.faults.lock().unwrap().iter_mut() {
                if f.op != op || !path.ends_with(f.path) {
                    continue;
                }
                if f.after > 0 {
                    f.after -= 1;
                    continue;
                }
                if f.times == 0 {
                    continue;
                }
                f.times = f.times.saturating_sub(usize::from(f.times != usize::MAX));
                return Err(match f.code {
                    Some(code) => io::Error::from_raw_os_error(code),
                    None => io::Error::new(io::ErrorKind::PermissionDenied, "injected failure"),
                });
            }
            Ok(())
        }
    }
    impl Fs for Faulty {
        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            self.hit(Op::Read, path)?;
            Disk.read(path)
        }
        fn temp(&self, dir: &Path, bytes: &[u8], like: &Path) -> io::Result<NamedTempFile> {
            self.hit(Op::Temp, like)?;
            Disk.temp(dir, bytes, like)
        }
        fn persist(&self, temp: NamedTempFile, target: &Path) -> Result<(), PersistError> {
            match self.hit(Op::Persist, target) {
                Ok(()) => Disk.persist(temp, target),
                Err(error) => Err(PersistError { error, file: temp }),
            }
        }
        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.hit(Op::Remove, path)?;
            Disk.remove_file(path)
        }
        fn create_dir(&self, path: &Path) -> io::Result<()> {
            Disk.create_dir(path)
        }
        fn remove_dir(&self, path: &Path) -> io::Result<()> {
            Disk.remove_dir(path)
        }
        fn sharing_violation(&self, error: &io::Error) -> bool {
            self.windows && matches!(error.raw_os_error(), Some(5 | 32 | 33 | 303))
        }
    }
    fn fault(op: Op, path: &'static str, after: usize, times: usize, code: Option<i32>) -> Fault {
        Fault {
            op,
            path,
            after,
            times,
            code,
        }
    }

    /// Paths under a folder with their bytes (folders: none).
    type Tree = Vec<(String, Option<Vec<u8>>)>;
    /// Every file and folder under `dir` with its bytes.
    fn snapshot(dir: &Path) -> Tree {
        fn walk(root: &Path, dir: &Path, out: &mut Tree) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                let name = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if path.is_dir() {
                    out.push((name, None));
                    walk(root, &path, out);
                } else {
                    out.push((name, Some(fs::read(&path).unwrap())));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    /// A skin and a plan touching it every way: two replaces, an add in a
    /// new folder, a removal.
    fn scene() -> (tempfile::TempDir, PathBuf, PathBuf, Tree) {
        let dir = tempfile::tempdir().unwrap();
        let (folder, backups) = (dir.path().join("skin"), dir.path().join("backups"));
        fs::create_dir_all(folder.join("mania")).unwrap();
        fs::write(folder.join("skin.ini"), "[General]\r\nName: A\r\n").unwrap();
        fs::write(folder.join("mania/key.png"), b"old key").unwrap();
        fs::write(folder.join("gone.png"), b"gone").unwrap();
        fs::write(folder.join("other.png"), b"untouched").unwrap();
        let before = snapshot(&folder);
        (dir, folder, backups, before)
    }
    fn plan_all() -> Vec<Planned> {
        vec![
            planned(
                "skin.ini",
                Action::Replace,
                Some(b"[General]\r\nName: B\r\n"),
            ),
            planned("mania/key.png", Action::Replace, Some(b"new key")),
            planned("mania/7k/a.png", Action::Add, Some(b"added")),
            planned("gone.png", Action::Remove, None),
        ]
    }
    fn backup_ids(backups: &Path) -> Vec<String> {
        fs::read_dir(backups)
            .map(|d| {
                d.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn staging_failure_touches_nothing() {
        for fault in [
            fault(Op::Read, "skin/gone.png", 0, 1, None),
            fault(Op::Temp, "mania/7k/a.png", 0, 1, None),
        ] {
            let (_dir, folder, backups, before) = scene();
            let fs = Faulty::new(false, vec![fault]);
            let error = commit(&fs, &folder, "skin", plan_all(), &backups).unwrap_err();
            assert!(error.1.contains("injected failure"), "{}", error.1);
            // The new mania/7k folder and the temp files are gone too.
            assert_eq!(snapshot(&folder), before);
            assert!(backup_ids(&backups).is_empty());
        }
    }

    #[test]
    fn persist_failure_rolls_back_and_deletes_the_backup() {
        let (_dir, folder, backups, before) = scene();
        let fs = Faulty::new(
            false,
            vec![fault(Op::Persist, "mania/7k/a.png", 0, 1, None)],
        );
        let error = commit(&fs, &folder, "skin", plan_all(), &backups).unwrap_err();
        assert!(error.1.contains("Nothing was changed"), "{}", error.1);
        assert_eq!(snapshot(&folder), before);
        assert!(backup_ids(&backups).is_empty());
        assert!(unfinished(&backups).is_empty());
    }

    /// The error names the file and the backup, the backup is kept and
    /// marked, and a later restore finishes the recovery.
    fn incomplete_then_restored(faults: Vec<Fault>, path: &str) {
        let (_dir, folder, backups, before) = scene();
        let fs = Faulty::new(false, faults);
        let error = commit(&fs, &folder, "skin", plan_all(), &backups).unwrap_err();
        let ids = backup_ids(&backups);
        assert_eq!(ids.len(), 1);
        let backup = backups.join(&ids[0]);
        assert!(
            error
                .1
                .contains(&format!("Putting the skin back failed for {path} (")),
            "{}",
            error.1
        );
        assert!(
            error.1.contains(&backup.display().to_string()),
            "{}",
            error.1
        );
        assert!(backup.join("files").join(path).exists());
        let open = unfinished(&backups);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].skin, "skin");
        assert_eq!(open[0].status, Status::RollbackIncomplete);
        assert_eq!(
            open[0]
                .failed
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            [path]
        );
        assert_ne!(snapshot(&folder), before);
        // Still locked: the restore reports it and keeps the backup.
        let again = restore_folder(&fs, &backups, &folder).unwrap_err();
        assert!(
            again.1.contains(path) && again.1.contains(&backup.display().to_string()),
            "{}",
            again.1
        );
        assert_eq!(unfinished(&backups).len(), 1);
        // Unlocked: the restore finishes.
        fs.clear();
        let restored = restore_folder(&fs, &backups, &folder).unwrap();
        assert_eq!((restored.restored, restored.skipped.len()), (1, 0));
        assert_eq!(snapshot(&folder), before);
        assert!(unfinished(&backups).is_empty());
        assert!(restore_folder(&fs, &backups, &folder).is_err());
    }

    #[test]
    fn persist_failure_with_a_restore_failure_keeps_the_backup() {
        incomplete_then_restored(
            vec![
                fault(Op::Persist, "mania/7k/a.png", 0, 1, None),
                // skin.ini goes in, then cannot be put back.
                fault(Op::Persist, "skin/skin.ini", 1, usize::MAX, None),
            ],
            "skin.ini",
        );
    }

    #[test]
    fn remove_failure_with_a_restore_failure_keeps_the_backup() {
        incomplete_then_restored(
            vec![
                fault(Op::Remove, "skin/gone.png", 0, 1, None),
                fault(Op::Persist, "mania/key.png", 1, usize::MAX, None),
            ],
            "mania/key.png",
        );
    }

    #[test]
    fn sharing_violations_are_retried() {
        let (_dir, folder, backups, _) = scene();
        let fs = Faulty::new(
            true,
            vec![
                fault(Op::Persist, "mania/key.png", 0, 3, Some(32)),
                fault(Op::Remove, "skin/gone.png", 0, 2, Some(33)),
            ],
        );
        commit(&fs, &folder, "skin", plan_all(), &backups)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(folder.join("mania/key.png")).unwrap(), b"new key");
        assert!(!folder.join("gone.png").exists());
        // Without the Windows classification the same error is not retried.
        let (_dir, folder, backups, before) = scene();
        let fs = Faulty::new(
            false,
            vec![fault(Op::Persist, "mania/key.png", 0, 3, Some(32))],
        );
        assert!(commit(&fs, &folder, "skin", plan_all(), &backups).is_err());
        assert_eq!(snapshot(&folder), before);
    }

    /// A real sharing violation: another handle holds the file with no
    /// sharing, released while the rename retries.
    #[cfg(windows)]
    #[test]
    fn a_locked_file_is_waited_for() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_dir, folder, _, _) = scene();
        let target = folder.join("mania/key.png");
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        // Held for good: the retry gives up, and the error is one it retries.
        let locked = put(&Disk, &target, b"x").unwrap_err();
        assert!(Disk.sharing_violation(&locked), "{locked:?}");
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        let started = Instant::now();
        put(&Disk, &target, b"new key").unwrap();
        release.join().unwrap();
        assert!(started.elapsed() >= Duration::from_millis(250));
        assert_eq!(fs::read(&target).unwrap(), b"new key");
    }

    #[test]
    fn nothing_changed_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            commit(&Disk, dir.path(), "skin", Vec::new(), &dir.path().join("b")).unwrap(),
            None
        );
        assert!(!dir.path().join("b").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc", dir.path().join("link")).unwrap();
        assert!(safe_target(dir.path(), "link/passwd").is_err());
        assert!(safe_target(dir.path(), "../x").is_err());
        assert!(safe_target(dir.path(), "a/b.png").is_ok());
    }

    /// A stand-in lazer: a copy of bash named `osu!` beside an `osu.Game.dll`,
    /// in a fake `/proc` entry. bash sources `BASH_ENV` before running its
    /// "script" (the .osk), which records the path instead.
    #[cfg(target_os = "linux")]
    #[test]
    fn lazer_is_found_and_receives_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("lazer");
        fs::create_dir(&bin).unwrap();
        fs::copy("/bin/bash", bin.join("osu!")).unwrap();
        fs::write(bin.join("osu.Game.dll"), b"").unwrap();
        let record = dir.path().join("record.txt");
        let hook = dir.path().join("hook.sh");
        fs::write(
            &hook,
            format!("printf '%s\\n' \"$0\" >> '{}'; exit 0\n", record.display()),
        )
        .unwrap();
        let proc = dir.path().join("proc");
        for (pid, exe) in [
            ("7", PathBuf::from("/usr/bin/true")),
            ("12", bin.join("osu!")),
        ] {
            fs::create_dir_all(proc.join(pid)).unwrap();
            std::os::unix::fs::symlink(&exe, proc.join(pid).join("exe")).unwrap();
        }
        fs::write(
            proc.join("12/environ"),
            format!("BASH_ENV={}\0PATH=/usr/bin:/bin\0", hook.display()),
        )
        .unwrap();
        std::os::unix::fs::symlink(dir.path(), proc.join("12/cwd")).unwrap();
        let lazer = lazer_in(&proc).unwrap();
        assert_eq!(lazer.exe, bin.join("osu!"));
        let osk = dir.path().join("Skin [vosu edit 1].osk");
        fs::write(&osk, b"PK").unwrap();
        launch(&lazer, &osk).unwrap();
        for _ in 0..100 {
            if record.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(
            fs::read_to_string(&record).unwrap().trim(),
            osk.to_string_lossy()
        );
        // No lazer, no launch.
        assert!(lazer_in(&dir.path().join("missing")).is_none());
    }
}
