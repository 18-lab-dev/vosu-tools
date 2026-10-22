use crate::{
    model::{Id, Mapset, Search},
    store::Store,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::Mutex;
#[derive(Default)]
pub struct Library {
    pub maps: HashMap<String, osu_db::Beatmap>,
    pub scores: Vec<osu_db::Score>,
    pub collections: Vec<osu_db::Collection>,
    pub warnings: Vec<String>,
    pub owned: osu_db::Owned,
}
#[derive(Clone)]
pub struct Discovery {
    pub store: Store,
    pub host: vosu_tool_sdk::Client,
    pub library: Arc<Mutex<Library>>,
}
impl Discovery {
    pub async fn refresh(&self) -> Result<Value, String> {
        let context: Value = self
            .host
            .host("context")
            .await
            .map_err(|_| "cannot read vosu context")?;
        let mut lib = Library::default();
        if context["client"].as_str() == Some("stable") {
            let root = context["osu_dir"]
                .as_str()
                .map(PathBuf::from)
                .or_else(|| {
                    context["songs_dir"]
                        .as_str()
                        .and_then(|p| std::path::Path::new(p).parent().map(PathBuf::from))
                })
                .ok_or("stable install directory unavailable")?;
            let temp =
                tempfile::tempdir().map_err(|_| "cannot create database snapshot directory")?;
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
                        .push(format!("{name}: {e}; ownership/history may be incomplete"));
                }
            }
            lib.owned = osu_db::Owned::from_maps(&lib.maps);
        } else if context["client"].as_str() == Some("lazer") {
            lib.warnings.push("Lazer has no supported local library-enumeration API. Internal Realm files are never opened; ownership is unknown. Tool download history is not proof of ownership.".into());
        } else {
            lib.warnings.push("No osu! client is selected in vosu. Ownership and play history are unknown; attach stable and refresh to load a read-only snapshot.".into());
        }
        let result = json!({"maps":lib.maps.len(),"scores":lib.scores.len(),"collections":lib.collections,"warnings":lib.warnings,"context":context});
        *self.library.lock().await = lib;
        Ok(result)
    }
    async fn mirror(&self, path: &str, params: &[(String, String)]) -> Result<Value, String> {
        let source = self.store.settings.lock().await.source(None)?;
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
        let s = self.store.settings.lock().await.clone();
        self.store.network.official(path, params, &s).await
    }
    async fn set(&self, id: u32, official: bool) -> Result<Mapset, String> {
        let v = if official {
            self.api(&format!("beatmapsets/{id}"), &[]).await?
        } else {
            self.mirror(&format!("/api/v2/s/{id}"), &[]).await?
        };
        serde_json::from_value(v).map_err(|_| "invalid mapset response".into())
    }
    async fn current(&self, official: bool) -> Result<Mapset, String> {
        let c: Value = self
            .host
            .host("context")
            .await
            .map_err(|_| "cannot read selected beatmap")?;
        let hash = c["beatmap"]["checksum"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("select a beatmap in osu! first")?;
        let v = if official {
            let b = self
                .api("beatmaps/lookup", &[("checksum".into(), hash.into())])
                .await?;
            return self
                .set(
                    b["beatmapset_id"].as_u64().ok_or("beatmapset ID missing")? as u32,
                    true,
                )
                .await;
        } else {
            self.mirror(&format!("/api/v2/md5/{hash}/set"), &[]).await?
        };
        serde_json::from_value(v).map_err(|_| "invalid current-map response".into())
    }
    pub async fn search(&self, mut query: Search) -> Result<Value, String> {
        query.validate()?;
        let official = query.provider == "official";
        if !official && query.provider != "mirror" {
            return Err("provider must be mirror or official".into());
        }
        let mut notices = Vec::new();
        let mut cursor = Value::Null;
        let mut sets = Vec::new();
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
                    return Err("no stable play history loaded; refresh library first".into());
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
                    let current = self.current(official).await?;
                    if query.discovery == "mapper" {
                        query.mapper = current.creator;
                    } else {
                        let c: Value = self
                            .host
                            .host("context")
                            .await
                            .map_err(|_| "context unavailable")?;
                        let d = current
                            .beatmaps
                            .iter()
                            .find(|m| m.checksum.as_deref() == c["beatmap"]["checksum"].as_str())
                            .ok_or("current map difficulty metadata missing")?;
                        query.mode = Some(d.mode_int);
                        query.min_stars = Some((d.difficulty_rating - 1.0).max(0.0));
                        query.max_stars = Some(d.difficulty_rating + 1.0);
                        notices.push("Similarity uses selected difficulty ±1 star. MSD cannot be inferred from star ratings; remote maps need actual rating analysis.".into());
                    }
                }
                (sets, cursor) = self.remote_search(&query, official).await?;
                if query.discovery == "similar-msd" {
                    let rating = self
                        .host
                        .tool_json::<Value>("mania-ratings", "v1/beatmap/current?rate=1")
                        .await
                        .ok();
                    if let Some(overall) =
                        rating.as_ref().and_then(|r| r["msd"]["overall"].as_f64())
                    {
                        let mut matching = Vec::new();
                        let mut unknown = 0;
                        for set in sets {
                            let mut similar = false;
                            for d in &set.beatmaps {
                                if d.mode_int != 3 {
                                    continue;
                                }
                                if let Some(hash) = d.checksum.as_ref().filter(|h| {
                                    h.len() == 32 && h.bytes().all(|b| b.is_ascii_hexdigit())
                                }) {
                                    match self
                                        .host
                                        .tool_json::<Value>(
                                            "ratings",
                                            &format!("v1/beatmap/{hash}?rate=1"),
                                        )
                                        .await
                                    {
                                        Ok(v) => {
                                            if let Some(msd) = v["msd"]["overall"].as_f64() {
                                                if (msd - overall).abs() <= 2.0 {
                                                    similar = true;
                                                }
                                            } else {
                                                unknown += 1;
                                            }
                                        }
                                        Err(_) => unknown += 1,
                                    }
                                } else {
                                    unknown += 1;
                                }
                            }
                            if similar {
                                matching.push(set);
                            }
                        }
                        sets = matching;
                        notices.push(format!("Cached mania MSD similarity: current {overall:.2} ±2 overall, within the ±1-star candidate window. {unknown} uncached/unsupported difficulties excluded; no missing rating is fabricated."));
                    } else {
                        notices.push("Mania ratings is not installed, current map is not cached, or MSD is unavailable; using ±1 star instead. No hard ratings dependency is required.".into());
                    }
                }
            }
            _ => return Err("unknown discovery mode".into()),
        }
        let lib = self.library.lock().await;
        let mut seen = HashSet::new();
        for s in &mut sets {
            s.owned = lib.owned.contains(
                s.id,
                &s.beatmaps
                    .iter()
                    .filter_map(|m| m.checksum.clone())
                    .collect::<Vec<_>>(),
            );
        }
        sets.retain(|s| {
            s.id > 0 && seen.insert(s.id) && (!query.hide_owned || !s.owned) && query.matches(s)
        });
        sets.truncate(query.limit);
        notices.extend(lib.warnings.clone());
        Ok(
            json!({"beatmapsets":sets,"cursor_string":cursor,"query":query,"notices":notices,"filter_scope":"Numeric, creator and date filters are also applied locally to this result page. Empty page does not mean no further matches; increase offset or use the next cursor."}),
        )
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
