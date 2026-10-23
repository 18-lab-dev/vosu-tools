//! Where replay inputs come from. Maps resolve by MD5 in the stable Songs
//! folder and, through the optional `lazer-library` tool, in lazer's file
//! store. Replays come from stable `Replays`, lazer `exports` and lazer scores.
//! Everything here is read-only.
use super::*;

/// A located beatmap: the `.osu` file plus how its other files are found.
#[derive(Clone, Debug)]
pub(super) enum MapFiles {
    /// Stable: assets are relative to the `.osu` file's folder.
    Stable(PathBuf),
    /// lazer: assets are named entries in the hashed file store.
    Lazer {
        osu: PathBuf,
        /// Lower-cased, `/`-separated beatmap file name → store path.
        files: BTreeMap<String, PathBuf>,
    },
}

impl MapFiles {
    pub(super) fn osu(&self) -> &FsPath {
        match self {
            Self::Stable(path) | Self::Lazer { osu: path, .. } => path,
        }
    }
    /// Resolves a file named by the beatmap (audio, background, …).
    pub(super) fn asset(&self, name: &str) -> Result<PathBuf, Error> {
        match self {
            Self::Stable(osu) => confined(
                osu.parent().ok_or_else(|| error("Map has no folder"))?,
                &name.replace('\\', "/"),
            ),
            Self::Lazer { files, .. } => files
                .get(&lazer_name(name))
                .cloned()
                .ok_or_else(|| error(format!("{name} is not part of this lazer beatmap"))),
        }
    }
}

fn lazer_name(name: &str) -> String {
    name.replace('\\', "/")
        .trim_start_matches("./")
        .to_lowercase()
}

pub(super) fn valid_md5(hash: &str) -> Result<String, Error> {
    if hash.len() != 32 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(error("Invalid beatmap checksum"));
    }
    Ok(hash.to_ascii_lowercase())
}

/// State of the optional `lazer-library` tool.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Lazer {
    Ready {
        data_dir: PathBuf,
    },
    /// Tool reachable, but it found no lazer data (its own explanation).
    NoData(String),
    /// Tool not installed, disabled or not answering.
    Missing,
}

impl Lazer {
    pub(super) fn describe(&self) -> String {
        match self {
            Self::Ready { data_dir } => format!("lazer library ({})", data_dir.display()),
            Self::NoData(reason) => format!("lazer library: {reason}"),
            Self::Missing => {
                "lazer library: the Lazer library tool is not installed or not running".into()
            }
        }
    }
}

const LAZER_TOOL: &str = "lazer-library";

/// `GET` on a lazer-library read route. The library is an optional companion,
/// not a `[[requires]]` dependency (which would block this tool whenever it is
/// missing); vosu lets any tool token use another tool's read routes.
async fn lazer_request(app: &App, path: &str) -> reqwest::Result<reqwest::Response> {
    app.env
        .client()
        .tool(Method::GET, LAZER_TOOL, path)
        .send()
        .await
}

pub(super) async fn lazer(app: &App) -> Lazer {
    let response = lazer_request(app, "v1/status").await;
    let Ok(response) = response else {
        return Lazer::Missing;
    };
    if !response.status().is_success() {
        return Lazer::Missing;
    }
    let Ok(status) = response.json::<Value>().await else {
        return Lazer::Missing;
    };
    match (status["available"].as_bool(), status["data_dir"].as_str()) {
        (Some(true), Some(dir)) => Lazer::Ready {
            data_dir: PathBuf::from(dir),
        },
        _ => Lazer::NoData(
            status["error"]
                .as_str()
                // No error yet: the library is still taking its first Realm snapshot.
                .unwrap_or("still reading lazer's database; try again in a moment")
                .to_owned(),
        ),
    }
}

async fn lazer_get(app: &App, path: &str) -> Result<Option<Value>, Error> {
    let response = lazer_request(app, path).await.map_err(error)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(error(format!(
            "Lazer library answered {} for {path}",
            response.status()
        )));
    }
    Ok(Some(response.json().await.map_err(error)?))
}

/// lazer's file skins from the library (`[{id, name, creator}]`); built-in
/// looks are listed by the studio itself. Empty when the library is missing.
pub(super) async fn lazer_skins(app: &App) -> Vec<Value> {
    let Ok(Some(listing)) = lazer_get(app, "v1/skins").await else {
        return Vec::new();
    };
    let mut skins = listing["skins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|skin| {
            skin["builtin"].is_null() && valid_skin_id(skin["id"].as_str().unwrap_or(""))
        })
        .map(|skin| json!({"id": skin["id"], "name": skin["name"], "creator": skin["creator"]}))
        .collect::<Vec<_>>();
    skins.sort_by_key(|skin| skin["name"].as_str().unwrap_or("").to_lowercase());
    skins
}

/// Library skin ids are GUIDs; anything else never reaches a URL.
pub(super) fn valid_skin_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// One file of a lazer skin, by its in-skin name (case-insensitive in the library).
pub(super) async fn lazer_skin_file(app: &App, id: &str, path: &str) -> Result<Bytes, Error> {
    if !valid_skin_id(id) {
        return Err(error("Invalid lazer skin id"));
    }
    let relative = FsPath::new(path);
    if path.is_empty()
        || path.contains('\\')
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(error("Invalid relative asset path"));
    }
    let encoded = path.split('/').map(encode).collect::<Vec<_>>().join("/");
    let response = lazer_request(app, &format!("v1/skins/{id}/file/{encoded}"))
        .await
        .map_err(error)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("{path} is not in this lazer skin")})),
        ));
    }
    if !response.status().is_success() {
        return Err(error(format!(
            "Lazer library answered {} for skin file {path}",
            response.status()
        )));
    }
    response.bytes().await.map_err(error)
}

/// Paths reported by the library must stay inside lazer's file store.
fn store_path(root: &FsPath, path: Option<&str>) -> Option<PathBuf> {
    let path = FsPath::new(path?).canonicalize().ok()?;
    path.starts_with(root).then_some(path)
}

async fn lazer_map(app: &App, data_dir: &FsPath, hash: &str) -> Result<Option<MapFiles>, Error> {
    if let Some(found) = app.lazer_maps.lock().await.get(hash) {
        return Ok(Some(found.clone()));
    }
    let Some(entry) = lazer_get(app, &format!("v1/beatmaps/by-md5/{hash}")).await? else {
        return Ok(None);
    };
    let root = data_dir.join("files").canonicalize().map_err(error)?;
    let osu = store_path(&root, entry["osu_path"].as_str())
        .ok_or_else(|| error("Lazer library returned a beatmap outside lazer's file store"))?;
    let bytes = tokio::fs::read(&osu).await.map_err(error)?;
    if format!("{:x}", Md5::digest(&bytes)) != hash {
        return Err(error(
            "Lazer library returned a beatmap with a different MD5",
        ));
    }
    let files = entry["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| {
            Some((
                lazer_name(file["name"].as_str()?),
                store_path(&root, file["path"].as_str())?,
            ))
        })
        .collect();
    let found = MapFiles::Lazer { osu, files };
    app.lazer_maps
        .lock()
        .await
        .insert(hash.to_owned(), found.clone());
    Ok(Some(found))
}

async fn stable_map(app: &App, songs: &str, hash: &str) -> Result<Option<PathBuf>, Error> {
    let mut maps = app.maps.lock().await;
    let cache = app
        .env
        .cache_dir
        .join(format!("maps-{:x}.json", Md5::digest(songs.as_bytes())));
    if maps.is_empty()
        && let Ok(bytes) = tokio::fs::read(&cache).await
        && let Ok(cached) = serde_json::from_slice::<BTreeMap<String, PathBuf>>(&bytes)
    {
        maps.extend(cached);
    }
    if let Some(path) = maps.get(hash).filter(|p| p.starts_with(songs))
        && let Ok(bytes) = tokio::fs::read(path).await
        && format!("{:x}", Md5::digest(bytes)) == hash
    {
        return Ok(Some(path.clone()));
    }
    let root = songs.to_owned();
    let found = tokio::task::spawn_blocking(move || {
        let mut result = BTreeMap::new();
        for entry in walkdir::WalkDir::new(root)
            .max_depth(3)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file()
                && entry.path().extension().is_some_and(|s| s == "osu")
                && let Ok(bytes) = std::fs::read(entry.path())
            {
                result.insert(format!("{:x}", Md5::digest(bytes)), entry.into_path());
            }
        }
        result
    })
    .await
    .map_err(error)?;
    *maps = found;
    let temporary = cache.with_extension("json.new");
    tokio::fs::write(&temporary, serde_json::to_vec(&*maps).map_err(error)?)
        .await
        .map_err(error)?;
    tokio::fs::rename(temporary, cache).await.map_err(error)?;
    Ok(maps.get(hash).cloned())
}

/// Finds a replay's beatmap by MD5: stable Songs first, then lazer. A miss is
/// a 404 naming the MD5 and every place searched.
pub(super) async fn find_map(app: &App, hash: &str) -> Result<MapFiles, Error> {
    let hash = valid_md5(hash)?;
    let context = host_context(app).await?;
    let mut searched = Vec::new();
    match context["stable_songs_dir"].as_str() {
        Some(songs) => {
            if let Some(path) = stable_map(app, songs, &hash).await? {
                return Ok(MapFiles::Stable(path));
            }
            searched.push(format!("stable Songs ({songs})"));
        }
        _ => searched.push("stable Songs: no stable installation is selected".into()),
    }
    let lazer = lazer(app).await;
    if let Lazer::Ready { data_dir } = &lazer
        && let Some(found) = lazer_map(app, data_dir, &hash).await?
    {
        return Ok(found);
    }
    searched.push(lazer.describe());
    Err(map_missing(&hash, &searched))
}

pub(super) fn map_missing(hash: &str, searched: &[String]) -> Error {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": format!(
                "This replay's map is not installed. Beatmap MD5 {hash} was not found in: {}. Install the exact difficulty in osu! (stable or lazer), then add the replay again.",
                searched.join("; ")
            ),
            "code": "map_missing",
            "md5": hash,
            "searched": searched,
        })),
    )
}

// ── replays ─────────────────────────────────────────────────────────────

/// Fields read from an `.osr` header without decoding frames.
#[derive(Debug, PartialEq, Serialize)]
pub(super) struct Header {
    pub mode: u8,
    pub md5: String,
    pub player: String,
    pub score: u32,
    pub combo: u16,
    pub mods: u32,
}

/// Parses the leading header fields of an `.osr`.
pub(super) fn header(bytes: &[u8]) -> Option<Header> {
    fn string(bytes: &[u8], at: &mut usize) -> Option<String> {
        let marker = *bytes.get(*at)?;
        *at += 1;
        if marker == 0 {
            return Some(String::new());
        }
        if marker != 0x0b {
            return None;
        }
        let (mut length, mut shift) = (0usize, 0);
        loop {
            let byte = *bytes.get(*at)?;
            *at += 1;
            length |= ((byte & 0x7f) as usize) << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
            if shift > 28 {
                return None;
            }
        }
        let text = std::str::from_utf8(bytes.get(*at..*at + length)?).ok()?;
        *at += length;
        Some(text.to_owned())
    }
    let mode = *bytes.first()?;
    if mode > 3 {
        return None;
    }
    let mut at = 5;
    let md5 = string(bytes, &mut at)?;
    let player = string(bytes, &mut at)?;
    string(bytes, &mut at)?;
    at += 12;
    let score = u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?);
    let combo = u16::from_le_bytes(bytes.get(at + 4..at + 6)?.try_into().ok()?);
    let mods = u32::from_le_bytes(bytes.get(at + 7..at + 11)?.try_into().ok()?);
    (md5.len() == 32).then_some(Header {
        mode,
        md5: md5.to_ascii_lowercase(),
        player,
        score,
        combo,
        mods,
    })
}

/// lazer's data folder: the attached lazer client's, the library tool's, or
/// the platform default (following a `storage.ini` custom path).
async fn lazer_base(app: &App, context: &Value) -> Option<PathBuf> {
    if let Some(files) = context["lazer_files_dir"].as_str() {
        return FsPath::new(files).parent().map(FsPath::to_path_buf);
    }
    if let Lazer::Ready { data_dir } = lazer(app).await {
        return Some(data_dir);
    }
    let default = if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?).join("osu")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?
            .join("osu")
    };
    let custom = std::fs::read_to_string(default.join("storage.ini"))
        .ok()
        .and_then(|ini| {
            ini.lines().find_map(|line| {
                let (key, value) = line.split_once('=')?;
                (key.trim() == "FullPath").then(|| PathBuf::from(value.trim()))
            })
        });
    Some(custom.unwrap_or(default))
}

/// Replay folders that exist right now, by source id.
pub(super) async fn replay_dirs(app: &App) -> Result<Vec<(&'static str, PathBuf)>, Error> {
    let context = host_context(app).await?;
    let mut dirs = Vec::new();
    if let Some(osu) = context["osu_dir"].as_str() {
        dirs.push(("stable", FsPath::new(osu).join("Replays")));
    }
    if let Some(base) = lazer_base(app, &context).await {
        dirs.push(("lazer-export", base.join("exports")));
    }
    dirs.retain(|(_, dir)| dir.is_dir());
    Ok(dirs)
}

fn list_folder(source: &str, dir: &FsPath, md5: Option<&str>) -> Vec<Value> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("osr"))
        {
            continue;
        }
        let mut head = vec![0u8; 512];
        let read = std::fs::File::open(&path)
            .and_then(|mut file| std::io::Read::read(&mut file, &mut head))
            .unwrap_or(0);
        let Some(header) = header(&head[..read]) else {
            continue;
        };
        if md5.is_some_and(|wanted| wanted != header.md5) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        found.push(json!({
            "source": source,
            "id": entry.file_name().to_string_lossy(),
            "name": path.file_stem().map(|s| s.to_string_lossy()),
            "player": header.player,
            "md5": header.md5,
            "mode": header.mode,
            "score": header.score,
            "combo": header.combo,
            "mods": header.mods,
            "date": modified,
        }));
    }
    found
}

/// `GET /v1/replays[?md5=]`: local replays, newest first; with `md5`, only
/// that map's, including lazer scores from the library.
pub(super) async fn list(
    State(app): State<App>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<Value>, Error> {
    let md5 = query.get("md5").map(|h| valid_md5(h)).transpose()?;
    let dirs = replay_dirs(&app).await?;
    let sources = dirs
        .iter()
        .map(|(source, dir)| json!({"source":source,"folder":dir}))
        .collect::<Vec<_>>();
    let filter = md5.clone();
    let mut replays = tokio::task::spawn_blocking(move || {
        dirs.iter()
            .flat_map(|(source, dir)| list_folder(source, dir, filter.as_deref()))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(error)?;
    let lazer = lazer(&app).await;
    let mut lazer_scores = Value::Null;
    if let Some(hash) = &md5 {
        lazer_scores = match &lazer {
            Lazer::Ready { .. } => match lazer_get(&app, &format!("v1/scores/by-beatmap/{hash}"))
                .await
            {
                Ok(Some(value)) => {
                    for score in value["scores"].as_array().into_iter().flatten() {
                        if score["replay_path"].is_string() || score["replay_hash"].is_string() {
                            replays.push(json!({
                                "source": "lazer-score",
                                "id": score["id"],
                                "name": null,
                                "player": score["username"],
                                "md5": hash,
                                "mode": score["ruleset"],
                                "score": score["total_score"],
                                "mods": score["mods"],
                                "date": score["date"],
                            }));
                        }
                    }
                    json!("available")
                }
                Ok(None) => json!("the Lazer library does not list scores"),
                Err(e) => e.1.0["error"].clone(),
            },
            other => json!(other.describe()),
        };
    }
    replays.sort_by_key(|entry| std::cmp::Reverse(date_key(entry)));
    Ok(Json(json!({
        "replays": replays,
        "sources": sources,
        "lazer": lazer.describe(),
        "lazer_scores": lazer_scores,
    })))
}

fn date_key(entry: &Value) -> u64 {
    match &entry["date"] {
        Value::Number(n) => n.as_u64().unwrap_or(0),
        Value::String(s) => iso_millis(s).unwrap_or(0),
        _ => 0,
    }
}

/// Epoch milliseconds of an ISO-8601 timestamp such as lazer's
/// `2026-05-30T12:34:56.789+00:00` (offset honoured, `Z` accepted).
fn iso_millis(text: &str) -> Option<u64> {
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        millis = format!("{:0<3}", &fraction[..digits.min(3)]).parse().ok()?;
        rest = &fraction[digits..];
    }
    let offset = match rest.as_bytes().first() {
        Some(sign @ (b'+' | b'-')) => {
            let minutes =
                rest.get(1..3)?.parse::<i64>().ok()? * 60 + rest.get(4..6)?.parse::<i64>().ok()?;
            if *sign == b'+' { minutes } else { -minutes }
        }
        _ => 0,
    };
    // Days from 1970-01-01 (Howard Hinnant's civil-from-days inverse).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset * 60;
    u64::try_from(seconds * 1000 + millis).ok()
}

/// Reads a replay file chosen from [`list`].
pub(super) async fn read(
    app: &App,
    source: &str,
    id: &str,
    md5: Option<&str>,
) -> Result<Bytes, Error> {
    let path = match source {
        "lazer-score" => {
            let hash = valid_md5(md5.ok_or_else(|| error("Missing beatmap md5"))?)?;
            let Lazer::Ready { data_dir } = lazer(app).await else {
                return Err(error("The Lazer library tool is unavailable"));
            };
            let scores = lazer_get(app, &format!("v1/scores/by-beatmap/{hash}"))
                .await?
                .ok_or_else(|| error("The Lazer library does not list scores"))?;
            let score = scores["scores"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| s["id"].to_string().trim_matches('"') == id)
                .ok_or_else(|| error("Score not found in the lazer library"))?;
            let root = data_dir.join("files").canonicalize().map_err(error)?;
            store_path(&root, score["replay_path"].as_str())
                .ok_or_else(|| error("This lazer score has no replay file"))?
        }
        _ => {
            let (_, dir) = replay_dirs(app)
                .await?
                .into_iter()
                .find(|(name, _)| *name == source)
                .ok_or_else(|| error(format!("No {source} replay folder is available")))?;
            confined(&dir, id)?
        }
    };
    Ok(tokio::fs::read(path).await.map_err(error)?.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn osr(mode: u8, md5: &str, player: &str) -> Vec<u8> {
        let mut out = vec![mode];
        out.extend(20240101u32.to_le_bytes());
        for text in [md5, player, "0123456789abcdef0123456789abcdef"] {
            out.push(0x0b);
            out.push(text.len() as u8);
            out.extend(text.as_bytes());
        }
        out.extend([1u8, 0].repeat(6));
        out.extend(987654u32.to_le_bytes());
        out.extend(321u16.to_le_bytes());
        out.push(1);
        out.extend(72u32.to_le_bytes());
        out
    }
    #[test]
    fn header_reads_identity_and_score() {
        let md5 = "B3FE0E7B107DECD6BCABD1F473AF8538";
        let parsed = header(&osr(1, md5, "sxlvia")).unwrap();
        assert_eq!(
            parsed,
            Header {
                mode: 1,
                md5: md5.to_ascii_lowercase(),
                player: "sxlvia".into(),
                score: 987654,
                combo: 321,
                mods: 72,
            }
        );
        assert!(header(&osr(7, md5, "x")).is_none());
        assert!(header(&osr(1, "short", "x")).is_none());
        assert!(header(&[1, 0, 0]).is_none());
    }
    #[test]
    fn lazer_assets_match_case_and_separators() {
        let map = MapFiles::Lazer {
            osu: "/store/a".into(),
            files: BTreeMap::from([("bg/back.jpg".into(), PathBuf::from("/store/b"))]),
        };
        assert_eq!(
            map.asset("BG\\Back.JPG").unwrap(),
            PathBuf::from("/store/b")
        );
        assert!(map.asset("audio.mp3").is_err());
    }
    #[test]
    fn missing_map_names_md5_and_sources() {
        let (status, Json(body)) = map_missing(
            "0123456789abcdef0123456789abcdef",
            &["stable Songs (/s)".into(), "lazer library (/l)".into()],
        );
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "map_missing");
        assert_eq!(body["md5"], "0123456789abcdef0123456789abcdef");
        let message = body["error"].as_str().unwrap();
        assert!(message.contains("0123456789abcdef0123456789abcdef"));
        assert!(message.contains("stable Songs (/s)") && message.contains("lazer library (/l)"));
    }
    #[test]
    fn iso_dates_sort_with_offsets() {
        assert_eq!(iso_millis("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(
            iso_millis("2026-05-30T12:00:00.5+02:00"),
            iso_millis("2026-05-30T10:00:00.500Z")
        );
        assert_eq!(iso_millis("2000-03-01T00:00:00"), Some(951_868_800_000));
        assert_eq!(iso_millis("not a date"), None);
    }

    /// A lazer data folder with one beatmap in the hashed file store, one
    /// exported replay, and one score replay.
    struct LazerFixture {
        base: PathBuf,
        md5: String,
        osu: PathBuf,
        audio: PathBuf,
        score_replay: PathBuf,
    }
    fn lazer_fixture() -> LazerFixture {
        let base = std::env::temp_dir().join(format!("vosu-lazer-test-{}", uuid::Uuid::new_v4()));
        let store = |name: &str, bytes: &[u8]| {
            let path = base
                .join("files/ab")
                .join(format!("ab{name}"))
                .join(format!("ab{name}hash"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
            path
        };
        let text = b"osu file format v14\n[General]\nAudioFilename: Audio.MP3\n";
        let md5 = format!("{:x}", Md5::digest(text));
        let osu = store("1", text);
        let audio = store("2", b"mp3");
        let score_replay = store("3", &osr(3, &md5, "lazer player"));
        std::fs::create_dir_all(base.join("exports")).unwrap();
        std::fs::write(base.join("exports/export.osr"), osr(3, &md5, "exporter")).unwrap();
        std::fs::write(
            base.join("exports/other.osr"),
            osr(3, "ffffffffffffffffffffffffffffffff", "elsewhere"),
        )
        .unwrap();
        LazerFixture {
            base,
            md5,
            osu,
            audio,
            score_replay,
        }
    }
    /// Stand-in vosu: host context for an attached lazer client, tool
    /// settings, and (optionally) the `lazer-library` v1 API.
    async fn fake_vosu(
        fixture: &LazerFixture,
        library: bool,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use axum::routing::get;
        let files = fixture.base.join("files");
        let base = fixture.base.clone();
        let (md5, osu, audio, replay) = (
            fixture.md5.clone(),
            fixture.osu.clone(),
            fixture.audio.clone(),
            fixture.score_replay.clone(),
        );
        let mut router = Router::new()
            .route(
                "/tools/_host/v1/context",
                get(move || {
                    let files = files.clone();
                    async move {
                        Json(json!({"client":"lazer","songs_dir":files,"osu_dir":null,"beatmap":null,"skin":null}))
                    }
                }),
            )
            .route("/tools/_host/v1/settings", get(|| async { Json(json!({})) }));
        if library {
            let wanted = md5.clone();
            router = router
                .route(
                    "/tools/lazer-library/api/v1/status",
                    get(move || {
                        let base = base.clone();
                        async move { Json(json!({"available":true,"data_dir":base,"realm_schema":51,"refreshed_at":null,"error":null})) }
                    }),
                )
                .route(
                    "/tools/lazer-library/api/v1/beatmaps/by-md5/{md5}",
                    get(move |Path(hash): Path<String>| {
                        let (wanted, osu, audio) = (wanted.clone(), osu.clone(), audio.clone());
                        async move {
                            if hash != wanted {
                                return Err(StatusCode::NOT_FOUND);
                            }
                            Ok(Json(json!({"md5":hash,"beatmap_id":42,"beatmapset_id":7,"ruleset":"mania",
                                "files":[{"name":"map.osu","hash":"ab1hash","path":osu},{"name":"audio.mp3","hash":"ab2hash","path":audio}],
                                "osu_path":osu,"audio_path":audio,"background_path":null})))
                        }
                    }),
                )
                .route(
                    "/tools/lazer-library/api/v1/scores/by-beatmap/{md5}",
                    get(move |Path(hash): Path<String>| {
                        let replay = replay.clone();
                        async move {
                            Json(json!({"scores":[{"id":"9c1f","beatmap_md5":hash,"username":"lazer player","ruleset":"mania",
                                "mods":"[]","total_score":900000,"date":"2026-05-30T12:00:00+00:00","replay_hash":"ab3hash","replay_path":replay}]}))
                        }
                    }),
                )
                .route(
                    "/tools/lazer-library/api/v1/skins",
                    get(|| async {
                        Json(json!({"skins":[
                            {"id":"argon","name":"osu! (argon)","creator":"team osu!","builtin":"argon","files":0},
                            {"id":"5d3a-77","name":"zeta","creator":"me","builtin":null,"files":3},
                            {"id":"a1b2-c3","name":"Alpha","creator":null,"builtin":null,"files":9},
                            {"id":"../bad","name":"bad","creator":null,"builtin":null,"files":1}]}))
                    }),
                )
                .route(
                    "/tools/lazer-library/api/v1/skins/{id}/file/{*name}",
                    get(|Path((id, name)): Path<(String, String)>| async move {
                        if id == "a1b2-c3" && name.eq_ignore_ascii_case("mania-key1@2x.png") {
                            Ok(Bytes::from_static(b"key"))
                        } else {
                            Err(StatusCode::NOT_FOUND)
                        }
                    }),
                )
                .route(
                    "/tools/_host/v1/overlays",
                    get(|| async {
                        Json(json!({"overlays":[
                            {"id":"accuracy by sxlvia","name":"accuracy","nickname":null,"alias":null,"author":"sxlvia","version":"1.0.0",
                             "folder":"/static/accuracy by sxlvia","width":180,"height":80},
                            {"id":"iq-display","name":"IQ Display","nickname":"Brain","alias":"iq","author":null,"version":null,
                             "folder":"/static/iq-display","width":null,"height":null}]}))
                    }),
                );
        }
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
    #[tokio::test]
    async fn lazer_maps_and_replays_resolve_through_the_library() {
        let fixture = lazer_fixture();
        let (url, server) = fake_vosu(&fixture, true).await;
        let app = app_for(url, fixture.base.join("tool"));
        let map = find_map(&app, &fixture.md5.to_uppercase()).await.unwrap();
        assert_eq!(map.osu(), fixture.osu.canonicalize().unwrap());
        let audio = crate::asset(
            State(app.clone()),
            Query(BTreeMap::from([
                ("kind".into(), "map-asset".into()),
                ("hash".into(), fixture.md5.clone()),
                ("path".into(), "Audio.MP3".into()),
            ])),
        )
        .await
        .unwrap();
        assert_eq!(&audio[..], b"mp3");
        let listed = list(
            State(app.clone()),
            Query(BTreeMap::from([("md5".into(), fixture.md5.clone())])),
        )
        .await
        .unwrap()
        .0;
        let sources = listed["replays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["source"].as_str().unwrap(), r["player"].as_str().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(sources.len(), 2, "{listed}");
        assert!(sources.contains(&("lazer-export", "exporter")));
        assert!(sources.contains(&("lazer-score", "lazer player")));
        assert_eq!(listed["lazer_scores"], "available");
        let all = list(State(app.clone()), Query(BTreeMap::new()))
            .await
            .unwrap()
            .0;
        assert_eq!(all["replays"].as_array().unwrap().len(), 2);
        let score = read(&app, "lazer-score", "9c1f", Some(&fixture.md5))
            .await
            .unwrap();
        assert_eq!(header(&score).unwrap().player, "lazer player");
        let export = read(&app, "lazer-export", "export.osr", None)
            .await
            .unwrap();
        assert_eq!(header(&export).unwrap().player, "exporter");
        assert!(
            read(&app, "lazer-export", "../files/ab/ab1/ab1hash", None)
                .await
                .is_err()
        );
        let (status, Json(body)) = find_map(&app, "ffffffffffffffffffffffffffffffff")
            .await
            .unwrap_err();
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["md5"], "ffffffffffffffffffffffffffffffff");
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("no stable installation")
        );
        server.abort();
        std::fs::remove_dir_all(fixture.base).unwrap();
    }
    #[tokio::test]
    async fn missing_library_tool_is_named_in_the_miss() {
        let fixture = lazer_fixture();
        let (url, server) = fake_vosu(&fixture, false).await;
        let app = app_for(url, fixture.base.join("tool"));
        let (status, Json(body)) = find_map(&app, &fixture.md5).await.unwrap_err();
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("Lazer library tool is not installed or not running"),
            "{body}"
        );
        // Exported lazer replays still list without the library tool.
        let listed = list(State(app), Query(BTreeMap::new())).await.unwrap().0;
        assert_eq!(listed["replays"].as_array().unwrap().len(), 2);
        server.abort();
        std::fs::remove_dir_all(fixture.base).unwrap();
    }
    #[tokio::test]
    async fn lazer_skins_list_and_serve_files() {
        let fixture = lazer_fixture();
        let (url, server) = fake_vosu(&fixture, true).await;
        let app = app_for(url, fixture.base.join("tool"));
        let skins = lazer_skins(&app).await;
        // Built-in looks and unsafe ids are left out; names sort case-insensitively.
        assert_eq!(
            skins,
            vec![
                json!({"id":"a1b2-c3","name":"Alpha","creator":null}),
                json!({"id":"5d3a-77","name":"zeta","creator":"me"}),
            ]
        );
        let file = crate::asset(
            State(app.clone()),
            Query(BTreeMap::from([
                ("kind".into(), "skin".into()),
                ("skin".into(), "lazer/a1b2-c3".into()),
                ("path".into(), "Mania-Key1@2x.png".into()),
            ])),
        )
        .await
        .unwrap();
        assert_eq!(&file[..], b"key");
        let missing = lazer_skin_file(&app, "a1b2-c3", "cursor.png")
            .await
            .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
        assert!(lazer_skin_file(&app, "../x", "cursor.png").await.is_err());
        assert!(
            lazer_skin_file(&app, "a1b2-c3", "../client.realm")
                .await
                .is_err()
        );
        let drawn = crate::asset(
            State(app),
            Query(BTreeMap::from([
                ("kind".into(), "skin".into()),
                ("skin".into(), "builtin/argon".into()),
                ("path".into(), "skin.ini".into()),
            ])),
        )
        .await;
        assert!(drawn.is_err());
        server.abort();
        std::fs::remove_dir_all(fixture.base).unwrap();
    }
    #[tokio::test]
    async fn installed_overlays_use_nicknames_metadata_and_remembered_sizes() {
        let fixture = lazer_fixture();
        let (url, server) = fake_vosu(&fixture, true).await;
        let app = app_for(url, fixture.base.join("tool"));
        std::fs::create_dir_all(&app.env.data_dir).unwrap();
        let listed = crate::output::installed_overlays(State(app.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(listed["available"], true);
        assert_eq!(
            listed["overlays"],
            json!([
                {"id":"accuracy by sxlvia","name":"accuracy","nickname":null,"author":"sxlvia","folder":"/static/accuracy by sxlvia","width":180,"height":80},
                {"id":"iq-display","name":"IQ Display","nickname":"Brain","author":null,"folder":"/static/iq-display","width":null,"height":null},
            ])
        );
        let stored = crate::output::set_overlay_size(
            State(app.clone()),
            Json(
                serde_json::from_value(json!({"id":"iq-display","width":300,"height":120}))
                    .unwrap(),
            ),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            json!(stored)["overlays"]["iq-display"],
            json!({"width":300,"height":120})
        );
        let listed = crate::output::installed_overlays(State(app.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(listed["overlays"][1]["width"], 300);
        assert_eq!(listed["overlays"][1]["height"], 120);
        assert!(
            crate::output::set_overlay_size(
                State(app.clone()),
                Json(
                    serde_json::from_value(json!({"id":"iq-display","width":8,"height":120}))
                        .unwrap()
                ),
            )
            .await
            .is_err()
        );
        server.abort();
        // Without the host route the studio falls back to custom folders.
        let (url, server) = fake_vosu(&fixture, false).await;
        let app = app_for(url, fixture.base.join("tool"));
        let listed = crate::output::installed_overlays(State(app))
            .await
            .unwrap()
            .0;
        assert_eq!(listed, json!({"available": false, "overlays": []}));
        server.abort();
        std::fs::remove_dir_all(fixture.base).unwrap();
    }
}
