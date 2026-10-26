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
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
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
    #[cfg(unix)]
    if !dirs.contains(&PathBuf::from("/tmp")) {
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
            let backup =
                tokio::task::spawn_blocking(move || commit(&folder, &key, planned, &backups))
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
#[derive(Serialize, Deserialize)]
struct Manifest {
    skin: String,
    folder: String,
    created: u64,
    changes: Vec<Record>,
    #[serde(default)]
    restored: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn sync_dir(_dir: &Path) {
    #[cfg(unix)]
    let _ = fs::File::open(_dir).and_then(|f| f.sync_all());
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), Failure> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(failure)?;
    }
    let mut file = fs::File::create(path).map_err(failure)?;
    file.write_all(bytes).map_err(failure)?;
    file.sync_all().map_err(failure)
}

/// Backs up, stages and renames the changes into `folder`; on any failure
/// the folder is put back as it was. Returns the backup id.
fn commit(
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
    let cleanup = || {
        let _ = fs::remove_dir_all(&dir);
    };
    // 1. Originals of every replaced or removed file.
    for p in &planned {
        if p.change.action != Action::Add {
            let source = safe_target(folder, &p.change.path)?;
            let bytes = fs::read(&source).map_err(|e| {
                cleanup();
                failure(format!("{}: {e}", p.change.path))
            })?;
            write_synced(&files.join(relative(&p.change.path)?), &bytes)
                .inspect_err(|_| cleanup())?;
        }
    }
    // 2. Stage new contents next to their targets.
    let mut staged = Vec::new();
    for (index, p) in planned.iter().enumerate() {
        let Some(content) = &p.content else { continue };
        let target = safe_target(folder, &p.change.path).inspect_err(|_| cleanup())?;
        let parent = target.parent().unwrap_or(folder);
        fs::create_dir_all(parent).map_err(|e| {
            cleanup();
            failure(e)
        })?;
        let mut temp = tempfile::Builder::new()
            .prefix(".skin-studio-")
            .tempfile_in(parent)
            .map_err(|e| {
                cleanup();
                failure(e)
            })?;
        if let Ok(meta) = fs::metadata(&target) {
            let _ = temp.as_file().set_permissions(meta.permissions());
        }
        temp.write_all(content)
            .and_then(|()| temp.as_file().sync_all())
            .map_err(|e| {
                cleanup();
                failure(e)
            })?;
        staged.push((index, temp, target));
    }
    let manifest = Manifest {
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
    };
    write_synced(
        &dir.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(failure)?,
    )
    .inspect_err(|_| cleanup())?;
    // 3. Rename into place, then remove; roll back on the first failure.
    let mut done: Vec<usize> = Vec::new();
    let rollback = |done: &[usize]| {
        for &i in done.iter().rev() {
            let p = &planned[i];
            let Ok(target) = safe_target(folder, &p.change.path) else {
                continue;
            };
            match p.change.action {
                Action::Add => {
                    let _ = fs::remove_file(&target);
                }
                _ => {
                    if let Ok(bytes) = fs::read(files.join(&p.change.path)) {
                        let _ = fs::write(&target, bytes);
                    }
                }
            }
        }
        cleanup();
    };
    for (index, temp, target) in staged {
        if let Err(e) = temp.persist(&target) {
            rollback(&done);
            return Err(failure(format!(
                "{}: {}",
                planned[index].change.path, e.error
            )));
        }
        done.push(index);
    }
    for (index, p) in planned.iter().enumerate() {
        if p.change.action == Action::Remove {
            let target = safe_target(folder, &p.change.path)?;
            if let Err(e) = fs::remove_file(&target) {
                rollback(&done);
                return Err(failure(format!("{}: {e}", p.change.path)));
            }
            done.push(index);
        }
    }
    sync_dir(folder);
    Ok(Some(id))
}

#[derive(Serialize)]
pub struct LastApply {
    pub id: String,
    pub created: u64,
    pub changes: usize,
}

fn manifests(backups: &Path, folder: &Path) -> Vec<(String, Manifest)> {
    let folder = folder.to_string_lossy();
    let mut out: Vec<(String, Manifest)> = fs::read_dir(backups)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            let manifest: Manifest =
                serde_json::from_slice(&fs::read(entry.path().join("manifest.json")).ok()?).ok()?;
            (manifest.folder == folder && !manifest.restored).then_some((id, manifest))
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
    Ok(manifests(&app.backups, &folder)
        .pop()
        .map(|(id, m)| LastApply {
            id,
            created: m.created,
            changes: m.changes.len(),
        }))
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
    tokio::task::spawn_blocking(move || restore_folder(&backups, &folder))
        .await
        .map_err(failure)?
}

fn restore_folder(backups: &Path, folder: &Path) -> Result<Restored, Failure> {
    let (id, mut manifest) = manifests(backups, folder)
        .pop()
        .ok_or_else(|| failure("No apply to restore."))?;
    let files = backups.join(&id).join("files");
    let (mut restored, mut skipped) = (0, Vec::new());
    for record in manifest.changes.iter().rev() {
        let target = safe_target(folder, &record.path)?;
        let current = fs::read(&target).ok();
        let untouched = current.as_deref().map(sha) == record.written;
        match record.action {
            Action::Add if untouched => fs::remove_file(&target).map_err(failure)?,
            Action::Replace | Action::Remove if untouched || current.is_none() => {
                let bytes = fs::read(files.join(relative(&record.path)?)).map_err(failure)?;
                let parent = target.parent().unwrap_or(folder);
                fs::create_dir_all(parent).map_err(failure)?;
                let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(failure)?;
                temp.write_all(&bytes).map_err(failure)?;
                temp.as_file().sync_all().map_err(failure)?;
                temp.persist(&target).map_err(|e| failure(e.error))?;
            }
            _ => {
                skipped.push(record.path.clone());
                continue;
            }
        }
        restored += 1;
    }
    sync_dir(folder);
    manifest.restored = true;
    write_synced(
        &backups.join(&id).join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(failure)?,
    )?;
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
        let restored = restore_folder(&backups, &folder).unwrap();
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
        assert!(restore_folder(&backups, &folder).is_err());
    }

    #[test]
    fn nothing_changed_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            commit(dir.path(), "skin", Vec::new(), &dir.path().join("b")).unwrap(),
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
