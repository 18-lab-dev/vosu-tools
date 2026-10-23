//! Building a mixed skin from a plan: a new stable skin folder (created in a
//! hidden staging folder and renamed into place), or an `.osk` streamed to
//! the browser as a download.

use crate::{
    App, Failure, failure,
    library::{self, relative},
};
use axum::{body::Bytes, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

pub const MAX_PLAN_FILES: usize = 20_000;
pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 1×1 transparent PNG: an empty image file would make osu! fall back to the
/// default skin, so "blank" elements need a real (invisible) image.
pub fn blank_png() -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, 1, 1);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("in-memory PNG header");
    writer
        .write_image_data(&[0; 4])
        .expect("in-memory PNG data");
    writer.finish().expect("in-memory PNG end");
    out
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum BlankKind {
    Png,
    Wav,
}
/// A copied file: `"name"` keeps its path, `["name", "to"]` renames it.
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum FileMap {
    Same(String),
    Renamed(String, String),
}
impl FileMap {
    fn parts(&self) -> (&str, &str) {
        match self {
            FileMap::Same(name) => (name, name),
            FileMap::Renamed(from, to) => (from, to),
        }
    }
}
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct PlanSource {
    pub skin: String,
    pub files: Vec<FileMap>,
}
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Blank {
    pub to: String,
    pub kind: BlankKind,
}
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Plan {
    pub name: String,
    #[serde(default)]
    pub overwrite: bool,
    pub ini: String,
    #[serde(default)]
    pub sources: Vec<PlanSource>,
    #[serde(default)]
    pub blanks: Vec<Blank>,
}
#[derive(Serialize, Debug)]
pub struct Built {
    pub path: String,
    pub replaced: bool,
    pub files: usize,
}

/// Validates a skin folder / archive name for both Windows and Linux.
pub fn skin_name(name: &str) -> Result<&str, Failure> {
    let name = name.trim();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if name.is_empty()
        || name.chars().count() > 120
        || name.starts_with('.')
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))
        || reserved.contains(&name.to_ascii_uppercase().as_str())
    {
        return Err(failure(
            "Use a skin name without / \\ : * ? \" < > | that does not start or end with a dot.",
        ));
    }
    Ok(name)
}

/// Output paths: safe, unique (case-insensitively, for Windows), never skin.ini.
fn targets(plan: &Plan) -> Result<usize, Failure> {
    let mut seen = HashSet::new();
    let mut count = 0;
    let outputs = plan
        .sources
        .iter()
        .flat_map(|s| s.files.iter().map(|f| f.parts().1))
        .chain(plan.blanks.iter().map(|b| b.to.as_str()));
    for to in outputs {
        relative(to)?;
        let lower = to.to_lowercase();
        if lower == "skin.ini" {
            return Err(failure("skin.ini comes from the plan's ini text."));
        }
        if !seen.insert(lower) {
            return Err(failure(format!("{to} is produced twice.")));
        }
        count += 1;
    }
    if count > MAX_PLAN_FILES {
        return Err(failure("The plan has too many files."));
    }
    if plan.ini.len() > 4 * 1024 * 1024 {
        return Err(failure("skin.ini exceeds 4 MiB."));
    }
    Ok(count)
}

fn blank(kind: BlankKind) -> Vec<u8> {
    match kind {
        BlankKind::Png => blank_png(),
        // A zero-length sample is silent in osu!.
        BlankKind::Wav => Vec::new(),
    }
}

/// A shared buffer the streaming zip writer appends to; drained after every
/// file so at most one file's bytes wait in memory.
#[derive(Clone, Default)]
struct Pipe(Arc<Mutex<Vec<u8>>>);
impl Write for Pipe {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("pipe lock").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub type Chunk = Result<Bytes, std::io::Error>;

/// Receives every output file in plan order.
enum Sink {
    Folder(PathBuf),
    Zip {
        zip: Box<zip::ZipWriter<zip::write::StreamWriter<Pipe>>>,
        pipe: Pipe,
        tx: mpsc::Sender<Chunk>,
    },
}
impl Sink {
    async fn put(&mut self, path: &str, bytes: &[u8]) -> Result<(), Failure> {
        match self {
            Sink::Folder(root) => {
                let target = root.join(relative(path)?);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(failure)?;
                }
                fs::write(target, bytes).map_err(failure)
            }
            Sink::Zip { zip, pipe, tx } => {
                // Images and audio are compressed already; deflating them costs time for nothing.
                let method = if path.rsplit('.').next().is_some_and(|ext| {
                    ["png", "jpg", "jpeg", "ogg", "mp3"]
                        .contains(&ext.to_ascii_lowercase().as_str())
                }) {
                    zip::CompressionMethod::Stored
                } else {
                    zip::CompressionMethod::Deflated
                };
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(method)
                    .last_modified_time(zip::DateTime::default());
                zip.start_file(path, options).map_err(failure)?;
                zip.write_all(bytes).map_err(failure)?;
                Self::drain(pipe, tx).await
            }
        }
    }
    async fn drain(pipe: &Pipe, tx: &mpsc::Sender<Chunk>) -> Result<(), Failure> {
        let bytes = std::mem::take(&mut *pipe.0.lock().expect("pipe lock"));
        if bytes.is_empty() {
            return Ok(());
        }
        tx.send(Ok(Bytes::from(bytes)))
            .await
            .map_err(|_| failure("The download was cancelled."))
    }
    async fn finish(self) -> Result<(), Failure> {
        if let Sink::Zip { zip, pipe, tx } = self {
            zip.finish().map_err(failure)?;
            Self::drain(&pipe, &tx).await?;
        }
        Ok(())
    }
}

async fn fill(
    app: &App,
    plan: &Plan,
    credits: Option<String>,
    sink: &mut Sink,
) -> Result<usize, Failure> {
    let mut total = 0u64;
    let mut files = 0;
    for source in &plan.sources {
        let (resolved, _) = library::resolve(app, &source.skin).await?;
        for file in &source.files {
            let (from, to) = file.parts();
            let bytes = resolved.read(app, from).await.map_err(|(status, error)| {
                (status, format!("{from} from {}: {error}", source.skin))
            })?;
            total += bytes.len() as u64;
            if total > MAX_TOTAL_BYTES {
                return Err(failure("The mixed skin exceeds 2 GiB."));
            }
            sink.put(to, &bytes).await?;
            files += 1;
        }
    }
    for item in &plan.blanks {
        sink.put(&item.to, &blank(item.kind)).await?;
        files += 1;
    }
    sink.put("skin.ini", plan.ini.as_bytes()).await?;
    if let Some(text) = credits {
        sink.put("skin-studio-credits.txt", text.as_bytes()).await?;
    }
    Ok(files)
}

/// Plain-text record of which skins contributed how many files.
async fn credits(app: &App, plan: &Plan) -> Result<String, Failure> {
    let mut text = format!(
        "{}\nMixed with Skin studio (vosu tools by 18-LAB).\n\nSources:\n",
        plan.name.trim()
    );
    for source in &plan.sources {
        let (_, skin) = library::resolve(app, &source.skin).await?;
        text.push_str(&format!(
            "- {}{}: {} files\n",
            skin.name,
            skin.creator.map(|c| format!(" by {c}")).unwrap_or_default(),
            source.files.len()
        ));
    }
    Ok(text)
}

/// Swaps `staging` into `dest`; an existing `dest` is replaced only when
/// `overwrite` is set, and is restored if the swap fails.
pub fn place(staging: &Path, dest: &Path, overwrite: bool) -> Result<bool, Failure> {
    if !dest.exists() {
        fs::rename(staging, dest).map_err(|e| {
            if dest.exists() {
                exists(dest)
            } else {
                failure(e)
            }
        })?;
        return Ok(false);
    }
    if !overwrite {
        return Err(exists(dest));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| failure("Invalid destination."))?;
    let old = tempfile::Builder::new()
        .prefix(".skin-studio-replaced-")
        .tempdir_in(parent)
        .map_err(failure)?
        .keep();
    let old = old.join("skin");
    fs::rename(dest, &old).map_err(failure)?;
    if let Err(error) = fs::rename(staging, dest) {
        let _ = fs::rename(&old, dest);
        let _ = fs::remove_dir_all(old.parent().unwrap_or(&old));
        return Err(failure(error));
    }
    fs::remove_dir_all(old.parent().unwrap_or(&old)).map_err(failure)?;
    Ok(true)
}

fn exists(dest: &Path) -> Failure {
    (
        StatusCode::CONFLICT,
        format!("{} already exists. Confirm to replace it.", dest.display()),
    )
}

/// Builds the plan as a new folder in the stable Skins folder.
pub async fn build(app: &App, plan: Plan) -> Result<Built, Failure> {
    let name = skin_name(&plan.name)?.to_owned();
    targets(&plan)?;
    let credits = credits_for(app, &plan).await?;
    let root = PathBuf::from(library::library(app).await?.stable_dir.ok_or_else(|| {
        failure("No stable Skins folder: attach vosu to osu!stable or set the Skins folder in this tool's settings.")
    })?);
    let dest = root.join(&name);
    if dest.exists() && !plan.overwrite {
        return Err(exists(&dest));
    }
    let staging = tempfile::Builder::new()
        .prefix(".skin-studio-")
        .tempdir_in(&root)
        .map_err(failure)?;
    let mut sink = Sink::Folder(staging.path().to_path_buf());
    let files = fill(app, &plan, credits, &mut sink).await?;
    let staged = staging.keep();
    let replaced = tokio::task::spawn_blocking({
        let dest = dest.clone();
        let staged = staged.clone();
        move || place(&staged, &dest, plan.overwrite)
    })
    .await
    .map_err(failure)?
    .inspect_err(|_| {
        let _ = fs::remove_dir_all(&staged);
    })?;
    Ok(Built {
        path: dest.to_string_lossy().into_owned(),
        replaced,
        files,
    })
}

async fn credits_for(app: &App, plan: &Plan) -> Result<Option<String>, Failure> {
    Ok(if library::settings(app).await.credits {
        Some(credits(app, plan).await?)
    } else {
        None
    })
}

/// A plan accepted for download, waiting for its single GET.
pub struct Pending {
    pub created: Instant,
    pub plan: Plan,
}
/// How long an accepted export waits for its download to start.
pub const PENDING_FOR: Duration = Duration::from_secs(120);

/// Validates a plan for an .osk download; the returned plan is what the
/// download route will stream.
pub async fn prepare(app: &App, plan: Plan) -> Result<Plan, Failure> {
    skin_name(&plan.name)?;
    targets(&plan)?;
    // Every source must still be in the library before the response starts:
    // errors after the first byte can only abort the download.
    for source in &plan.sources {
        library::resolve(app, &source.skin).await?;
    }
    Ok(plan)
}

/// `name.osk` for Content-Disposition: an ASCII fallback plus the exact
/// UTF-8 name (RFC 6266 / 5987).
pub fn disposition(name: &str) -> String {
    let file = format!("{}.osk", name.trim());
    let ascii: String = file
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        library::segment(&file)
    )
}

/// Streams the plan as an .osk (zip) into `tx`, one file in memory at a time.
pub async fn stream(app: App, plan: Plan, tx: mpsc::Sender<Chunk>) {
    let credits = match credits_for(&app, &plan).await {
        Ok(credits) => credits,
        Err((_, error)) => {
            let _ = tx.send(Err(std::io::Error::other(error))).await;
            return;
        }
    };
    let pipe = Pipe::default();
    let mut sink = Sink::Zip {
        zip: Box::new(zip::ZipWriter::new_stream(pipe.clone())),
        pipe,
        tx: tx.clone(),
    };
    let result = match fill(&app, &plan, credits, &mut sink).await {
        Ok(_) => sink.finish().await,
        Err(error) => Err(error),
    };
    if let Err((_, error)) = result {
        // The status line is sent already; an error item aborts the response.
        let _ = tx.send(Err(std::io::Error::other(error))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(files: Vec<FileMap>, blanks: Vec<Blank>) -> Plan {
        Plan {
            name: "Mix".into(),
            overwrite: false,
            ini: "[General]\nName: Mix\n".into(),
            sources: vec![PlanSource {
                skin: "/x".into(),
                files,
            }],
            blanks,
        }
    }

    #[test]
    fn names_are_portable() {
        assert_eq!(skin_name("  My Mix  ").unwrap(), "My Mix");
        for bad in ["", "a/b", "a\\b", ".hidden", "trail.", "CON", "x:y", "a?"] {
            assert!(skin_name(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn targets_are_safe_and_unique() {
        let ok = plan(
            vec![
                FileMap::Same("hitcircle.png".into()),
                FileMap::Renamed("a/b.png".into(), "mania/b.png".into()),
            ],
            vec![Blank {
                to: "hit0.png".into(),
                kind: BlankKind::Png,
            }],
        );
        assert_eq!(targets(&ok).unwrap(), 3);
        for files in [
            vec![FileMap::Same("../x.png".into())],
            vec![FileMap::Same("skin.ini".into())],
            vec![
                FileMap::Same("Cursor.png".into()),
                FileMap::Same("cursor.png".into()),
            ],
        ] {
            assert!(targets(&plan(files, vec![])).is_err());
        }
        let parsed: Plan = serde_json::from_str(
            r#"{"name":"M","ini":"","sources":[{"skin":"/s","files":["a.png",["b.png","c.png"]]}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.sources[0].files[1].parts(), ("b.png", "c.png"));
    }
    #[test]
    fn place_never_clobbers_without_confirmation() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("Mix");
        let staged = |marker: &str| {
            let dir = root.path().join(format!(".stage-{marker}"));
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("skin.ini"), marker).unwrap();
            dir
        };
        assert!(!place(&staged("one"), &dest, false).unwrap());
        let second = staged("two");
        assert_eq!(
            place(&second, &dest, false).unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(fs::read_to_string(dest.join("skin.ini")).unwrap(), "one");
        assert!(place(&second, &dest, true).unwrap());
        assert_eq!(fs::read_to_string(dest.join("skin.ini")).unwrap(), "two");
        // Only the final skin remains; no staging or replaced folders linger.
        let left: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["Mix"]);
    }
    #[test]
    fn disposition_keeps_unicode_names() {
        assert_eq!(
            disposition("My mix"),
            "attachment; filename=\"My mix.osk\"; filename*=UTF-8''My%20mix.osk"
        );
        let jp = disposition("「シルビア」 v1");
        assert!(
            jp.starts_with("attachment; filename=\"______ v1.osk\";"),
            "{jp}"
        );
        assert!(
            jp.ends_with("%E3%80%8C%E3%82%B7%E3%83%AB%E3%83%93%E3%82%A2%E3%80%8D%20v1.osk"),
            "{jp}"
        );
    }
    #[tokio::test]
    async fn streamed_osk_is_a_valid_zip() {
        let (tx, mut rx) = mpsc::channel(4);
        let pipe = Pipe::default();
        let mut sink = Sink::Zip {
            zip: Box::new(zip::ZipWriter::new_stream(pipe.clone())),
            pipe,
            tx,
        };
        let reader = tokio::spawn(async move {
            let mut out = Vec::new();
            let mut chunks = 0;
            while let Some(chunk) = rx.recv().await {
                out.extend_from_slice(&chunk.unwrap());
                chunks += 1;
            }
            (out, chunks)
        });
        let big = vec![7u8; 300_000];
        sink.put("hitcircle@2x.png", &big).await.unwrap();
        sink.put("mania/note1.png", &blank_png()).await.unwrap();
        sink.put("skin.ini", b"[General]\nName: M\n").await.unwrap();
        sink.finish().await.unwrap();
        let (bytes, chunks) = reader.await.unwrap();
        // One chunk per file plus the central directory: never the whole archive at once.
        assert!(chunks >= 4, "{chunks}");
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(archive.len(), 3);
        let mut ini = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("skin.ini").unwrap(), &mut ini).unwrap();
        assert_eq!(ini, "[General]\nName: M\n");
        let entry = archive.by_name("hitcircle@2x.png").unwrap();
        assert_eq!(entry.size(), 300_000);
        assert_eq!(entry.compression(), zip::CompressionMethod::Stored);
    }
    #[test]
    fn blank_png_decodes() {
        let reader = png::Decoder::new(std::io::Cursor::new(blank_png()))
            .read_info()
            .unwrap();
        assert_eq!((reader.info().width, reader.info().height), (1, 1));
    }
}
