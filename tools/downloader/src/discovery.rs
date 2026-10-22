use crate::{
    model::{Id, Mapset, Search},
    store::Store,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Mutex, time::Instant};

/// A snapshot older than this, or taken for another client, is refreshed
/// before the next search.
const LIBRARY_TTL: Duration = Duration::from_secs(600);
/// Optional provider of lazer's Realm library (read-only).
const LAZER_LIBRARY: &str = "lazer-library";

#[derive(Default)]
pub struct Library {
    /// Client the snapshot was taken for (`stable`, `lazer`, or none).
    pub client: Option<String>,
    pub refreshed: Option<Instant>,
    /// Songs folder vosu reported for that client, offered as import target.
    pub songs_dir: Option<String>,
    pub refreshed_at: Option<u64>,
    /// Where ownership came from: `stable`, `lazer-library`, or `none`.
    pub source: &'static str,
    pub maps: HashMap<String, osu_db::Beatmap>,
    pub scores: Vec<osu_db::Score>,
    pub collections: Vec<osu_db::Collection>,
    pub warnings: Vec<String>,
    pub owned: osu_db::Owned,
    pub lazer_sets: HashSet<u32>,
}
impl Library {
    pub fn owns(&self, set: &Mapset) -> bool {
        self.lazer_sets.contains(&set.id)
            || self.owned.contains(
                set.id,
                &set.beatmaps
                    .iter()
                    .filter_map(|m| m.checksum.clone())
                    .collect::<Vec<_>>(),
            )
    }
    pub fn summary(&self) -> Value {
        json!({
            "client": self.client,
            "source": if self.refreshed.is_some() { self.source } else { "none" },
            "loaded": self.refreshed.is_some(),
            "refreshed_at": self.refreshed_at,
            "owned_sets": self.owned.set_ids.len() + self.lazer_sets.len(),
            "songs_dir": self.songs_dir,
            "maps": self.maps.len(),
            "scores": self.scores.len(),
            "collections": self.collections,
            "warnings": self.warnings,
        })
    }
}
#[derive(Clone)]
pub struct Discovery {
    pub store: Store,
    pub host: vosu_tool_sdk::Client,
    pub library: Arc<Mutex<Library>>,
}
impl Discovery {
    async fn context(&self) -> Result<Value, String> {
        self.host
            .host("context")
            .await
            .map_err(|e| format!("cannot read vosu context: {e}"))
    }
    /// Refreshes the snapshot when it is missing, stale, or for another client.
    pub async fn ensure_library(&self) -> Result<(), String> {
        let context = self.context().await?;
        let client = context["client"].as_str().map(str::to_owned);
        let stale = {
            let lib = self.library.lock().await;
            // The Lazer library tool keeps its own snapshot and answers from
            // memory, so lazer ownership is re-read on every search; stable
            // databases are copied and parsed, so that snapshot is reused.
            lib.client != client
                || client.as_deref() == Some("lazer")
                || lib.refreshed.is_none_or(|t| t.elapsed() > LIBRARY_TTL)
        };
        if stale {
            self.load_library(context).await;
        }
        Ok(())
    }
    pub async fn refresh(&self) -> Result<Value, String> {
        let context = self.context().await?;
        let summary = self.load_library(context.clone()).await;
        Ok(json!({"library":summary,"context":context}))
    }
    async fn load_library(&self, context: Value) -> Value {
        let mut lib = Library {
            client: context["client"].as_str().map(str::to_owned),
            songs_dir: context["songs_dir"].as_str().map(str::to_owned),
            source: "none",
            ..Library::default()
        };
        match lib.client.as_deref() {
            Some("stable") => self.load_stable(&context, &mut lib),
            Some("lazer") => self.load_lazer(&mut lib).await,
            _ => lib.warnings.push("No osu! client is attached to vosu, so sets you already have cannot be hidden. Start osu! and refresh.".into()),
        }
        lib.refreshed = Some(Instant::now());
        lib.refreshed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs());
        let summary = lib.summary();
        *self.library.lock().await = lib;
        summary
    }
    fn load_stable(&self, context: &Value, lib: &mut Library) {
        let Some(root) = context["osu_dir"].as_str().map(PathBuf::from).or_else(|| {
            context["songs_dir"]
                .as_str()
                .and_then(|p| std::path::Path::new(p).parent().map(PathBuf::from))
        }) else {
            lib.warnings
                .push("Stable install directory unavailable; ownership is unknown.".into());
            return;
        };
        let temp = match tempfile::tempdir() {
            Ok(t) => t,
            Err(_) => {
                lib.warnings
                    .push("Cannot create a database snapshot directory.".into());
                return;
            }
        };
        for name in ["osu!.db", "scores.db", "collection.db"] {
            let path = temp.path().join(name);
            let parsed = (|| {
                let source = root.join(name);
                let size = std::fs::metadata(&source).map_err(|e| e.to_string())?.len();
                if size > 512 * 1024 * 1024 {
                    return Err("database exceeds 512 MiB".into());
                }
                std::fs::copy(&source, &path).map_err(|e| e.to_string())?;
                let b = osu_db::read_copy(&path)?;
                match name {
                    "osu!.db" => lib.maps = osu_db::maps(&b)?,
                    "scores.db" => lib.scores = osu_db::scores(&b)?,
                    _ => lib.collections = osu_db::collections(&b)?,
                };
                Ok::<_, String>(())
            })();
            if let Err(e) = parsed {
                lib.warnings
                    .push(format!("{name}: {e}; ownership/history may be incomplete."));
            }
        }
        lib.owned = osu_db::Owned::from_maps(&lib.maps);
        lib.source = "stable";
    }
    async fn load_lazer(&self, lib: &mut Library) {
        let status = match self
            .host
            .tool_json::<Value>(LAZER_LIBRARY, "v1/status")
            .await
        {
            Ok(s) => s,
            Err(vosu_tool_sdk::Error::Status { status: 404, .. }) => {
                lib.warnings.push("Lazer ownership needs the Lazer library tool. Install it from vosu Tools → Available; until then, sets you have in lazer are not hidden.".into());
                return;
            }
            Err(e) => {
                lib.warnings.push(format!(
                    "Lazer library tool unavailable ({e}); sets you have in lazer are not hidden."
                ));
                return;
            }
        };
        if status["available"].as_bool() != Some(true) {
            lib.warnings.push(format!(
                "Lazer library tool cannot read lazer's library: {}. Sets you have in lazer are not hidden.",
                status["error"].as_str().unwrap_or("not available")
            ));
            return;
        }
        match self
            .host
            .tool_json::<Value>(LAZER_LIBRARY, "v1/beatmapsets/online-ids")
            .await
        {
            Ok(v) => match v["ids"].as_array() {
                Some(ids) => {
                    lib.lazer_sets = ids
                        .iter()
                        .filter_map(Value::as_u64)
                        .filter_map(|n| u32::try_from(n).ok())
                        .filter(|n| *n > 0)
                        .collect();
                    lib.source = "lazer-library";
                }
                None => lib
                    .warnings
                    .push("Lazer library tool returned no set list.".into()),
            },
            Err(e) => lib.warnings.push(format!(
                "Lazer library tool could not list sets ({e}); sets you have in lazer are not hidden."
            )),
        }
    }
    async fn mirror(&self, path: &str, params: &[(String, String)]) -> Result<Value, String> {
        let source = self.store.config().await?.source(None)?;
        let mut u = reqwest::Url::parse(&format!("{}{path}", source.base.trim_end_matches('/')))
            .map_err(|_| "invalid mirror URL")?;
        u.query_pairs_mut()
            .extend_pairs(params.iter().map(|(k, v)| (k, v)));
        self.store
            .network
            .json(u.as_str(), &source.base, source.interval_ms, None)
            .await
    }
    async fn api(&self, path: &str, params: &[(String, String)]) -> Result<Value, String> {
        let config = self.store.config().await?;
        self.store.network.official(path, params, &config).await
    }
    async fn set(&self, id: u32, official: bool) -> Result<Mapset, String> {
        let v = if official {
            self.api(&format!("beatmapsets/{id}"), &[]).await?
        } else {
            self.mirror(&format!("/api/v2/s/{id}"), &[]).await?
        };
        serde_json::from_value(v).map_err(|_| "invalid mapset response".into())
    }
    /// The set containing the difficulty with this `.osu` MD5.
    pub async fn by_md5(&self, hash: &str, official: bool) -> Result<Mapset, String> {
        if hash.len() != 32 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("MD5 must be 32 hexadecimal characters".into());
        }
        let hash = hash.to_ascii_lowercase();
        if official {
            let b = self
                .api("beatmaps/lookup", &[("checksum".into(), hash)])
                .await?;
            return self
                .set(
                    b["beatmapset_id"].as_u64().ok_or("beatmapset ID missing")? as u32,
                    true,
                )
                .await;
        }
        let v = self
            .mirror(&format!("/api/v2/md5/{hash}/set"), &[])
            .await
            .map_err(|e| {
                if e.contains("HTTP 404") {
                    "no set with this MD5 on the mirror (it may be unsubmitted or updated)".into()
                } else {
                    e
                }
            })?;
        serde_json::from_value(v).map_err(|_| "invalid MD5 lookup response".into())
    }
    /// Marks library ownership and this tool's completed downloads.
    pub async fn mark(&self, sets: &mut [Mapset]) {
        let downloaded = self
            .store
            .queue
            .lock()
            .await
            .jobs
            .iter()
            .filter(|j| j.state == "done")
            .map(|j| j.set.id)
            .collect::<HashSet<_>>();
        let lib = self.library.lock().await;
        for s in sets {
            s.owned = lib.owns(s);
            s.downloaded = downloaded.contains(&s.id);
        }
    }
    pub async fn lookup(&self, hash: &str) -> Result<Value, String> {
        let _ = self.ensure_library().await;
        let mut set = [self.by_md5(hash, false).await?];
        self.mark(&mut set).await;
        let [set] = set;
        Ok(json!({"beatmapset":set,"library":self.library.lock().await.summary()}))
    }
    pub async fn search(&self, mut query: Search) -> Result<Value, String> {
        query.validate()?;
        let official = query.provider == "official";
        if !official && query.provider != "mirror" {
            return Err("provider must be mirror or official".into());
        }
        let mut notices = Vec::new();
        if let Err(e) = self.ensure_library().await {
            notices.push(format!("Library not refreshed: {e}"));
        }
        let mut cursor = Value::Null;
        let mut sets = Vec::new();
        let mut based_on = Value::Null;
        match query.discovery.as_str() {
            "ids" => {
                for id in crate::model::parse_ids(&query.ids)?
                    .into_iter()
                    .take(query.limit)
                {
                    let set = match id {
                        Id::Set(id) => self.set(id, official).await?,
                        Id::Map(id) => {
                            let v = if official {
                                self.api(&format!("beatmaps/{id}"), &[]).await?
                            } else {
                                self.mirror(&format!("/api/v2/b/{id}"), &[]).await?
                            };
                            self.set(
                                v["beatmapset_id"].as_u64().ok_or("beatmapset ID missing")? as u32,
                                official,
                            )
                            .await?
                        }
                        Id::Md5(hash) => self.by_md5(&hash, official).await?,
                    };
                    sets.push(set);
                }
            }
            "packs" => {
                if query.pack.is_empty() {
                    return self
                        .api("beatmaps/packs", &[("type".into(), "standard".into())])
                        .await;
                }
                if !query
                    .pack
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || query.pack.len() > 32
                {
                    return Err("invalid pack tag".into());
                }
                let p = self
                    .api(&format!("beatmaps/packs/{}", query.pack), &[])
                    .await?;
                let entries: Vec<Mapset> = serde_json::from_value(p["beatmapsets"].clone())
                    .map_err(|_| "pack does not provide mapsets")?;
                // Pack entries are compact and may omit difficulties/checksums.
                // Hydrate a bounded page before filters or archive validation.
                for entry in entries.into_iter().skip(query.offset).take(query.limit) {
                    sets.push(self.set(entry.id, official).await?);
                }
                notices.push("Pack discovery uses official API metadata. Individual selected sets use the chosen permitted mirror; pack archive URLs are never scraped.".into());
            }
            "history" => {
                let creators = {
                    let lib = self.library.lock().await;
                    let mut plays = lib.scores.iter().collect::<Vec<_>>();
                    plays.sort_by_key(|s| std::cmp::Reverse(s.timestamp_ticks));
                    let mut creators = Vec::new();
                    for p in plays {
                        if let Some(m) = lib.maps.get(&p.checksum) {
                            if !creators.contains(&m.creator) {
                                creators.push(m.creator.clone());
                            }
                            if creators.len() == 3 {
                                break;
                            }
                        }
                    }
                    creators
                };
                if creators.is_empty() {
                    return Err(
                        "no stable play history found; history discovery reads stable's scores.db"
                            .into(),
                    );
                }
                for creator in creators {
                    let mut q = query.clone();
                    q.mapper = creator;
                    q.discovery = "search".into();
                    let (s, _) = self.remote_search(&q, official).await?;
                    sets.extend(s);
                }
                notices.push("History discovery searches the mappers of your three most recently played stable maps.".into());
            }
            "search" | "mapper" | "similar" | "similar-msd" => {
                if query.discovery != "search" {
                    let c = self.context().await?;
                    let hash = c["beatmap"]["checksum"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("select a beatmap in osu! first")?
                        .to_owned();
                    let current = self.by_md5(&hash, official).await?;
                    let d = current
                        .beatmaps
                        .iter()
                        .find(|m| m.checksum.as_deref() == Some(hash.as_str()))
                        .ok_or("current map difficulty metadata missing")?;
                    based_on = json!({
                        "checksum": hash,
                        "set": current.id,
                        "artist": current.artist,
                        "title": current.title,
                        "creator": current.creator,
                        "version": d.version,
                        "stars": d.difficulty_rating,
                        "mode": d.mode_int,
                    });
                    if query.discovery == "mapper" {
                        query.mapper = current.creator.clone();
                    } else {
                        query.mode = Some(d.mode_int);
                        query.min_stars = Some((d.difficulty_rating - 1.0).max(0.0));
                        query.max_stars = Some(d.difficulty_rating + 1.0);
                        notices.push("Similarity uses the selected difficulty ±1 star.".into());
                    }
                }
                (sets, cursor) = self.remote_search(&query, official).await?;
                if query.discovery == "similar-msd" {
                    self.msd_filter(&mut sets, &mut notices).await;
                }
            }
            _ => return Err("unknown discovery mode".into()),
        }
        self.mark(&mut sets).await;
        let mut seen = HashSet::new();
        let mut hidden = 0;
        sets.retain(|s| {
            if s.id == 0 || !seen.insert(s.id) || !query.matches(s) {
                return false;
            }
            if query.hide_owned && (s.owned || s.downloaded) {
                hidden += 1;
                return false;
            }
            true
        });
        sets.truncate(query.limit);
        let library = self.library.lock().await.summary();
        if let Some(w) = library["warnings"].as_array() {
            notices.extend(w.iter().filter_map(|w| w.as_str().map(str::to_owned)));
        }
        Ok(json!({
            "beatmapsets": sets,
            "cursor_string": cursor,
            "query": query,
            "based_on": based_on,
            "hidden": hidden,
            "library": library,
            "notices": notices,
            "filter_scope": "Numeric, creator and date filters are also applied locally to this result page. An empty page does not mean there are no further matches; use the next page.",
        }))
    }
    async fn msd_filter(&self, sets: &mut Vec<Mapset>, notices: &mut Vec<String>) {
        let rating = self
            .host
            .tool_json::<Value>("mania-ratings", "v1/beatmap/current?rate=1")
            .await
            .ok();
        let Some(overall) = rating.as_ref().and_then(|r| r["msd"]["overall"].as_f64()) else {
            notices.push("Mania ratings is not installed, the current map is not cached, or MSD is unavailable; using ±1 star instead. No hard Mania ratings dependency is required.".into());
            return;
        };
        let mut matching = Vec::new();
        let mut unknown = 0;
        for set in sets.drain(..) {
            let mut similar = false;
            for d in &set.beatmaps {
                if d.mode_int != 3 {
                    continue;
                }
                let Some(hash) = d
                    .checksum
                    .as_ref()
                    .filter(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_hexdigit()))
                else {
                    unknown += 1;
                    continue;
                };
                match self
                    .host
                    .tool_json::<Value>("mania-ratings", &format!("v1/beatmap/{hash}?rate=1"))
                    .await
                {
                    Ok(v) => match v["msd"]["overall"].as_f64() {
                        Some(msd) if (msd - overall).abs() <= 2.0 => similar = true,
                        Some(_) => {}
                        None => unknown += 1,
                    },
                    Err(_) => unknown += 1,
                }
            }
            if similar {
                matching.push(set);
            }
        }
        *sets = matching;
        notices.push(format!("Cached mania MSD similarity: current {overall:.2} ±2 overall, within the ±1-star candidate window. {unknown} uncached/unsupported difficulties excluded; no missing rating is fabricated."));
    }
    async fn remote_search(
        &self,
        q: &Search,
        official: bool,
    ) -> Result<(Vec<Mapset>, Value), String> {
        let (v, cursor) = if official {
            let v = self.api("beatmapsets/search", &q.official_params()).await?;
            let cursor = v["cursor_string"].clone();
            (v["beatmapsets"].clone(), cursor)
        } else {
            let mut p = vec![
                (
                    "q".into(),
                    if q.mapper.is_empty() {
                        q.query.clone()
                    } else {
                        format!("{} {}", q.query, q.mapper).trim().to_owned()
                    },
                ),
                ("amount".into(), q.limit.to_string()),
                ("offset".into(), q.offset.to_string()),
            ];
            if let Some(mode) = q.mode {
                p.push(("mode".into(), mode.to_string()));
            }
            let status = match q.status.as_str() {
                "graveyard" => Some(-2),
                "wip" => Some(-1),
                "pending" => Some(0),
                "ranked" => Some(1),
                "approved" => Some(2),
                "qualified" => Some(3),
                "loved" => Some(4),
                _ => None,
            };
            if let Some(status) = status {
                p.push(("status".into(), status.to_string()));
            }
            (self.mirror("/api/v2/search", &p).await?, Value::Null)
        };
        Ok((
            serde_json::from_value(v).map_err(|_| "invalid search response")?,
            cursor,
        ))
    }
}
