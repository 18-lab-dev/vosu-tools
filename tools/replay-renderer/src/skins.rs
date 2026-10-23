//! Skins the studio can render with: the client's current skin (a stable folder,
//! or files vosu serves for lazer), folders under the stable `Skins` directory,
//! lazer library skins (`lazer/<id>`, read through the optional `lazer-library`
//! tool), render-core's drawn looks (`builtin/<id>`, never read from files), and
//! `.osk` archives imported into this tool's own data directory.
//!
//! vosu forwards at most 1 MiB per request body, so imports arrive as ordered
//! parts that are appended to a private staging file and extracted on finish.
use super::*;
use std::{io::Read, time::Instant};

/// Preset/request prefix selecting a skin imported into the tool data dir.
pub(super) const IMPORTED: &str = "imported/";
/// Prefix selecting a skin from lazer's library by its id.
pub(super) const LAZER: &str = "lazer/";
/// Prefix selecting a built-in look the web renderer draws itself.
pub(super) const BUILTIN: &str = "builtin/";
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED: u64 = 1024 * 1024 * 1024;
const MAX_PART: usize = 1024 * 1024;
const MAX_PARTS: u32 = 4096;
const MAX_ENTRIES: usize = 20_000;
const MAX_UPLOADS: usize = 4;
const UPLOAD_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

pub(super) struct Upload {
    name: String,
    size: u64,
    received: u64,
    parts: u32,
    touched: Instant,
}

pub(super) fn imported_root(app: &App) -> PathBuf {
    app.env.data_dir.join("skins")
}
fn uploads_root(app: &App) -> PathBuf {
    app.env.cache_dir.join("skin-uploads")
}

/// Removes staging files left by a previous process; uploads never survive restarts.
pub(super) async fn reset_uploads(env: &ToolEnv) -> std::io::Result<()> {
    let root = env.cache_dir.join("skin-uploads");
    match tokio::fs::remove_dir_all(&root).await {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    tokio::fs::create_dir_all(root).await
}

fn not_found(message: impl ToString) -> Error {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":message.to_string()})),
    )
}

/// A skin name usable as a single folder on every platform.
pub(super) fn valid_name(name: &str) -> Result<&str, Error> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 128
        || name.starts_with('.')
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))
    {
        return Err(error(
            "Skin names need 1-128 characters without / \\ : * ? \" < > | or a leading/trailing dot",
        ));
    }
    Ok(name)
}

pub(super) fn imported_names(app: &App) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(imported_root(app)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') && entry.file_type().is_ok_and(|t| t.is_dir()) {
                names.push(name);
            }
        }
    }
    names.sort();
    names
}

/// How the client's current skin can be read right now.
#[derive(Debug, PartialEq)]
pub(super) enum Current {
    /// Stable skin folder on disk.
    Folder(PathBuf),
    /// Files served by vosu at `/files/skin/<path>` (lazer's file store).
    Served {
        name: Option<String>,
    },
    /// A lazer built-in skin: drawn by the client, no files to read.
    Builtin {
        name: Option<String>,
        id: String,
    },
    Unavailable,
}

impl Current {
    pub(super) fn describe(&self) -> Value {
        match self {
            Self::Folder(folder) => json!({
                "source": "folder",
                "name": folder.file_name().map(|n| n.to_string_lossy()),
                "builtin": null,
            }),
            Self::Served { name } => json!({"source":"vosu","name":name,"builtin":null}),
            Self::Builtin { name, id } => json!({"source":"builtin","name":name,"builtin":id}),
            Self::Unavailable => json!({"source":"none","name":null,"builtin":null}),
        }
    }
}

/// Interprets vosu's public `GET /files/skin/` descriptor
/// (`{client, name, files, builtin}`); `None` when the route is absent.
pub(super) fn from_descriptor(value: &Value) -> Option<Current> {
    let files = value.get("files")?.as_bool()?;
    let name = value["name"].as_str().map(str::to_owned);
    Some(if files {
        Current::Served { name }
    } else if let Some(id) = value["builtin"].as_str() {
        Current::Builtin {
            name,
            id: id.to_owned(),
        }
    } else {
        Current::Unavailable
    })
}

pub(super) async fn current(app: &App, context: &Value) -> Current {
    if let Some(folder) = context["skin"]["folder"].as_str() {
        return Current::Folder(PathBuf::from(folder));
    }
    let request = app.env.client().request(Method::GET, "/files/skin/");
    let descriptor = match request.send().await {
        Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
        _ => None,
    };
    descriptor
        .as_ref()
        .and_then(from_descriptor)
        .unwrap_or(Current::Unavailable)
}

/// Reads one file of the client's current skin.
pub(super) async fn current_file(app: &App, context: &Value, path: &str) -> Result<Bytes, Error> {
    match current(app, context).await {
        Current::Folder(root) => Ok(tokio::fs::read(confined(&root, path)?)
            .await
            .map_err(not_found)?
            .into()),
        Current::Served { .. } => {
            let relative = FsPath::new(path);
            if path.contains('\\')
                || relative
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err(error("Invalid relative asset path"));
            }
            let encoded = path.split('/').map(encode).collect::<Vec<_>>().join("/");
            let response = app
                .env
                .client()
                .request(Method::GET, &format!("/files/skin/{encoded}"))
                .send()
                .await
                .map_err(error)?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(not_found(format!("{path} is not in the current skin")));
            }
            if !response.status().is_success() {
                return Err(error(format!(
                    "vosu answered {} for current skin file {path}",
                    response.status()
                )));
            }
            response.bytes().await.map_err(error)
        }
        Current::Builtin { id, .. } => Err(not_found(format!(
            "The client uses its built-in {id} skin, which has no files"
        ))),
        Current::Unavailable => Err(not_found("Current skin is unavailable")),
    }
}

#[derive(Deserialize)]
pub(super) struct Start {
    name: String,
    size: u64,
}
pub(super) async fn start(
    State(app): State<App>,
    Query(start): Query<Start>,
) -> Result<Json<Value>, Error> {
    let name = valid_name(&start.name)?.to_owned();
    if start.size == 0 || start.size > MAX_ARCHIVE {
        return Err(error("Skin archives must be 1 byte to 512 MiB"));
    }
    let mut uploads = app.uploads.lock().await;
    let expired = uploads
        .iter()
        .filter(|(_, upload)| upload.touched.elapsed() > UPLOAD_TTL)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in expired {
        uploads.remove(&id);
        let _ = tokio::fs::remove_file(uploads_root(&app).join(&id)).await;
    }
    if uploads.len() >= MAX_UPLOADS {
        return Err(error(
            "Too many skin imports in progress; finish or wait for them",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    tokio::fs::create_dir_all(uploads_root(&app))
        .await
        .map_err(error)?;
    tokio::fs::write(uploads_root(&app).join(&id), b"")
        .await
        .map_err(error)?;
    uploads.insert(
        id.clone(),
        Upload {
            name,
            size: start.size,
            received: 0,
            parts: 0,
            touched: Instant::now(),
        },
    );
    Ok(Json(json!({"upload":id,"part_size":MAX_PART})))
}

#[derive(Deserialize)]
pub(super) struct Part {
    offset: u64,
}
pub(super) async fn part(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(part): Query<Part>,
    body: Bytes,
) -> Result<Json<Value>, Error> {
    let mut uploads = app.uploads.lock().await;
    let upload = uploads
        .get_mut(&id)
        .ok_or_else(|| not_found("Unknown or expired skin upload"))?;
    if part.offset != upload.received {
        return Err(error(format!(
            "Expected part at offset {}",
            upload.received
        )));
    }
    if body.is_empty()
        || body.len() > MAX_PART
        || upload.parts >= MAX_PARTS
        || upload.received + body.len() as u64 > upload.size
    {
        return Err(error("Skin upload part exceeds the declared archive"));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(uploads_root(&app).join(&id))
        .await
        .map_err(error)?;
    tokio::io::AsyncWriteExt::write_all(&mut file, &body)
        .await
        .map_err(error)?;
    upload.received += body.len() as u64;
    upload.parts += 1;
    upload.touched = Instant::now();
    Ok(Json(json!({"received":upload.received})))
}

pub(super) async fn finish(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let upload = app
        .uploads
        .lock()
        .await
        .remove(&id)
        .ok_or_else(|| not_found("Unknown or expired skin upload"))?;
    let archive = uploads_root(&app).join(&id);
    let result = if upload.received != upload.size {
        Err(error("Skin upload is incomplete"))
    } else {
        let root = imported_root(&app);
        let name = upload.name.clone();
        let source = archive.clone();
        tokio::task::spawn_blocking(move || install(&source, &root, &name))
            .await
            .map_err(error)
            .and_then(|r| r.map_err(error))
    };
    let _ = tokio::fs::remove_file(&archive).await;
    let files = result?;
    Ok(Json(json!({"name":upload.name,"files":files})))
}

pub(super) async fn delete(
    State(app): State<App>,
    Path(name): Path<String>,
) -> Result<Json<Value>, Error> {
    let name = valid_name(&name)?;
    let folder = imported_root(&app).join(name);
    if !folder.is_dir() {
        return Err(not_found("No imported skin with that name"));
    }
    tokio::fs::remove_dir_all(folder).await.map_err(error)?;
    Ok(Json(json!({"deleted":name})))
}

/// Extracts an `.osk` into `<root>/<name>`, replacing an earlier import of the
/// same name only after the new copy is complete. Returns the file count.
pub(super) fn install(archive: &FsPath, root: &FsPath, name: &str) -> Result<usize, String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|_| "Not a valid .osk (ZIP) archive")?;
    if zip.len() > MAX_ENTRIES {
        return Err("Skin archive has too many entries".into());
    }
    let mut files = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|_| "Invalid ZIP entry")?;
        if entry.is_symlink() || entry.name().contains('\\') {
            return Err("Skin archive contains an unsafe entry".into());
        }
        let path = entry
            .enclosed_name()
            .ok_or("Skin archive contains an unsafe entry")?;
        if entry.is_file() {
            files.push((i, path));
        }
    }
    if files.is_empty() {
        return Err("Skin archive is empty".into());
    }
    // Archives zipped from the folder itself wrap everything in one directory.
    let wrapper = files[0]
        .1
        .components()
        .next()
        .map(|c| c.as_os_str().to_owned());
    let strip = files.iter().all(|(_, path)| {
        path.components().count() > 1
            && path.components().next().map(|c| c.as_os_str()) == wrapper.as_deref()
    });
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let staging = root.join(format!(".import-{}", uuid::Uuid::new_v4()));
    let written = (|| -> Result<usize, String> {
        let mut expanded = 0u64;
        let mut buf = vec![0u8; 64 * 1024];
        for (index, path) in &files {
            let relative = if strip {
                path.iter().skip(1).collect::<PathBuf>()
            } else {
                path.clone()
            };
            let target = staging.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut entry = zip.by_index(*index).map_err(|_| "Invalid ZIP entry")?;
            let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
            let mut actual = 0u64;
            loop {
                let n = entry
                    .read(&mut buf)
                    .map_err(|_| "Skin archive CRC or decompression failed")?;
                if n == 0 {
                    break;
                }
                actual += n as u64;
                expanded += n as u64;
                if actual > entry.size() || expanded > MAX_EXPANDED {
                    return Err("Skin archive expands beyond 1 GiB".into());
                }
                std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| e.to_string())?;
            }
            if actual != entry.size() {
                return Err("Skin archive entry is truncated".into());
            }
        }
        Ok(files.len())
    })();
    let count = match written {
        Ok(count) => count,
        Err(message) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(message);
        }
    };
    let destination = root.join(name);
    let previous = root.join(format!(".replaced-{}", uuid::Uuid::new_v4()));
    let replaced = destination.exists();
    if replaced {
        std::fs::rename(&destination, &previous).map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(&staging, &destination) {
        if replaced {
            let _ = std::fs::rename(&previous, &destination);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.to_string());
    }
    if replaced {
        let _ = std::fs::remove_dir_all(&previous);
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn osk(path: &FsPath, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }
    fn temp() -> PathBuf {
        let root = std::env::temp_dir().join(format!("vosu-skin-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn imports_flat_and_wrapped_archives_and_replaces_atomically() {
        let root = temp();
        let archive = root.join("a.osk");
        osk(
            &archive,
            &[
                ("skin.ini", b"[General]\nName: A"),
                ("mania-key1.png", b"png"),
            ],
        );
        assert_eq!(install(&archive, &root.join("skins"), "A").unwrap(), 2);
        assert!(root.join("skins/A/skin.ini").is_file());
        osk(
            &archive,
            &[("A v2/skin.ini", b"[General]"), ("A v2/sub/x.png", b"x")],
        );
        assert_eq!(install(&archive, &root.join("skins"), "A").unwrap(), 2);
        assert!(root.join("skins/A/sub/x.png").is_file());
        assert!(!root.join("skins/A/mania-key1.png").exists());
        let leftovers = std::fs::read_dir(root.join("skins")).unwrap().count();
        assert_eq!(leftovers, 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_unsafe_or_invalid_archives() {
        let root = temp();
        let archive = root.join("bad.osk");
        osk(&archive, &[("../escape.png", b"x")]);
        assert!(install(&archive, &root.join("skins"), "Bad").is_err());
        std::fs::write(&archive, b"not a zip").unwrap();
        assert!(install(&archive, &root.join("skins"), "Bad").is_err());
        assert!(!root.join("skins/Bad").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn names_are_single_portable_folders() {
        assert_eq!(valid_name("  My Skin [v2] ").unwrap(), "My Skin [v2]");
        for bad in ["", "a/b", "..", ".hidden", "a:b", "con?", "x\u{0}"] {
            assert!(valid_name(bad).is_err(), "{bad:?}");
        }
    }
    #[test]
    fn lazer_descriptor_maps_to_current_skin_sources() {
        assert_eq!(
            from_descriptor(&json!({"client":"lazer","name":"Mine","files":true,"builtin":null})),
            Some(Current::Served {
                name: Some("Mine".into())
            })
        );
        assert_eq!(
            from_descriptor(
                &json!({"client":"lazer","name":"argon","files":false,"builtin":"argon"})
            ),
            Some(Current::Builtin {
                name: Some("argon".into()),
                id: "argon".into()
            })
        );
        assert_eq!(
            from_descriptor(&json!({"client":null,"name":null,"files":false,"builtin":null})),
            Some(Current::Unavailable)
        );
        assert_eq!(from_descriptor(&json!({"error":"not found"})), None);
    }
    /// A loopback stand-in for vosu: host context/settings plus the public
    /// `/files/skin/` descriptor and file routes, as served for lazer.
    async fn fake_vosu(descriptor: Value) -> (String, tokio::task::JoinHandle<()>) {
        use axum::routing::get;
        let router = Router::new()
            .route(
                "/tools/_host/v1/context",
                get(|| async {
                    Json(
                        json!({"client":"lazer","songs_dir":null,"osu_dir":null,"beatmap":null,
                        "skin":{"name":"Mine","folder":null}}),
                    )
                }),
            )
            .route(
                "/tools/_host/v1/settings",
                get(|| async { Json(json!({})) }),
            )
            .route(
                "/files/skin/",
                get(move || {
                    let descriptor = descriptor.clone();
                    async move { Json(descriptor) }
                }),
            )
            .route(
                "/files/skin/{*path}",
                get(|Path(path): Path<String>| async move {
                    match path.as_str() {
                        "skin.ini" => Ok(Bytes::from_static(b"[General]\nName: Mine")),
                        "sub dir/mania-key1.png" => Ok(Bytes::from_static(b"png")),
                        _ => Err(StatusCode::NOT_FOUND),
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        (
            url,
            tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            }),
        )
    }
    fn app_for(vosu_url: String, root: PathBuf) -> App {
        App {
            env: ToolEnv {
                id: "replay-renderer".into(),
                token: "test-only".into(),
                vosu_url,
                data_dir: root.clone(),
                cache_dir: root,
                interface: vosu_tool_sdk::Interface::Service,
            },
            presets: Arc::default(),
            maps: Arc::default(),
            jobs: Arc::default(),
            render_gate: Arc::new(tokio::sync::Semaphore::new(1)),
            uploads: Arc::default(),
            lazer_maps: Arc::default(),
        }
    }
    fn skin_query(path: &str) -> Query<BTreeMap<String, String>> {
        Query(BTreeMap::from([
            ("kind".into(), "skin".into()),
            ("path".into(), path.into()),
        ]))
    }
    #[tokio::test]
    async fn current_lazer_skin_is_read_through_vosu() {
        let root = temp();
        let (url, server) =
            fake_vosu(json!({"client":"lazer","name":"Mine","files":true,"builtin":null})).await;
        let app = app_for(url, root.clone());
        let context = crate::context(State(app.clone())).await.unwrap().0;
        assert_eq!(context["current_skin"]["source"], "vosu");
        assert_eq!(context["current_skin"]["name"], "Mine");
        let ini = crate::asset(State(app.clone()), skin_query("skin.ini"))
            .await
            .unwrap();
        assert_eq!(&ini[..], b"[General]\nName: Mine");
        let nested = crate::asset(State(app.clone()), skin_query("sub dir/mania-key1.png"))
            .await
            .unwrap();
        assert_eq!(&nested[..], b"png");
        let missing = crate::asset(State(app.clone()), skin_query("cursor.png")).await;
        assert_eq!(missing.unwrap_err().0, StatusCode::NOT_FOUND);
        assert!(
            crate::asset(State(app), skin_query("../escape.png"))
                .await
                .is_err()
        );
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn builtin_lazer_skin_reports_no_files() {
        let root = temp();
        let (url, server) =
            fake_vosu(json!({"client":"lazer","name":"argon","files":false,"builtin":"argon"}))
                .await;
        let app = app_for(url, root.clone());
        let context = crate::context(State(app.clone())).await.unwrap().0;
        assert_eq!(context["current_skin"]["source"], "builtin");
        assert_eq!(context["current_skin"]["builtin"], "argon");
        let error = crate::asset(State(app), skin_query("skin.ini"))
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::NOT_FOUND);
        assert!(
            error.1["error"]
                .as_str()
                .unwrap()
                .contains("built-in argon")
        );
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn chunked_osk_upload_installs_into_tool_data() {
        let root = temp();
        let app = app_for("http://127.0.0.1:1".into(), root.clone());
        let archive = root.join("in.osk");
        osk(
            &archive,
            &[("skin.ini", b"[General]"), ("cursor.png", b"cursor")],
        );
        let bytes = std::fs::read(&archive).unwrap();
        let started = start(
            State(app.clone()),
            Query(Start {
                name: "Chunked".into(),
                size: bytes.len() as u64,
            }),
        )
        .await
        .unwrap()
        .0;
        let id = started["upload"].as_str().unwrap().to_owned();
        let wrong = part(
            State(app.clone()),
            Path(id.clone()),
            Query(Part { offset: 7 }),
            Bytes::from(bytes[..10].to_vec()),
        )
        .await;
        assert!(wrong.is_err());
        for (index, chunk) in bytes.chunks(40).enumerate() {
            let received = part(
                State(app.clone()),
                Path(id.clone()),
                Query(Part {
                    offset: (index * 40) as u64,
                }),
                Bytes::from(chunk.to_vec()),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(received["received"], index * 40 + chunk.len());
        }
        let done = finish(State(app.clone()), Path(id.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(done["files"], 2);
        assert_eq!(imported_names(&app), vec!["Chunked".to_owned()]);
        let cursor = crate::asset(
            State(app.clone()),
            Query(BTreeMap::from([
                ("kind".into(), "skin".into()),
                ("skin".into(), "imported/Chunked".into()),
                ("path".into(), "cursor.png".into()),
            ])),
        )
        .await
        .unwrap();
        assert_eq!(&cursor[..], b"cursor");
        assert!(!uploads_root(&app).join(&id).exists());
        assert!(finish(State(app.clone()), Path(id)).await.is_err());
        let deleted = delete(State(app.clone()), Path("Chunked".into()))
            .await
            .unwrap()
            .0;
        assert_eq!(deleted["deleted"], "Chunked");
        assert!(imported_names(&app).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
