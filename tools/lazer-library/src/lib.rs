mod schema;

use axum::{
    Json, Router,
    extract::{Path as RoutePath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

fn text(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_owned()
}
fn key(v: &Value) -> Cow<'_, str> {
    v.as_str()
        .map(Cow::Borrowed)
        .unwrap_or_else(|| Cow::Owned(v.to_string()))
}
fn normalized_md5(md5: &str) -> Cow<'_, str> {
    if md5.bytes().any(|b| b.is_ascii_uppercase()) {
        Cow::Owned(md5.to_ascii_lowercase())
    } else {
        Cow::Borrowed(md5)
    }
}
fn positive(v: &Value) -> Value {
    v.as_i64()
        .filter(|n| *n > 0)
        .map_or(Value::Null, Value::from)
}
fn deleted(v: &Value) -> bool {
    v["DeletePending"].as_bool() == Some(true)
}
#[derive(Clone, Debug, Serialize)]
pub struct LibraryFile {
    pub name: String,
    pub hash: String,
    pub path: PathBuf,
}
fn store_path(base: &Path, hash: &str) -> Option<PathBuf> {
    (hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit())).then(|| {
        base.join("files")
            .join(&hash[..1])
            .join(&hash[..2])
            .join(hash)
    })
}
fn files(base: &Path, v: &Value) -> Vec<LibraryFile> {
    v["Files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let hash = text(f, "File");
            Some(LibraryFile {
                name: text(f, "Filename"),
                path: store_path(base, &hash)?,
                hash,
            })
        })
        .collect()
}
#[derive(Default)]
pub struct Index {
    pub schema: i64,
    pub beatmaps: HashMap<String, Value>,
    pub sets: HashMap<String, Value>,
    pub set_files: HashMap<String, Vec<LibraryFile>>,
    pub skins: HashMap<String, Value>,
    pub skin_files: HashMap<String, Vec<LibraryFile>>,
    pub scores: HashMap<String, Vec<Value>>,
    pub metadata: HashMap<String, Value>,
    pub online_ids: Vec<i64>,
    pub counts: [usize; 4],
    pub missing_properties: Vec<String>,
}

#[derive(Debug)]
pub struct LoadError {
    pub schema: Option<i64>,
    pub missing_properties: Vec<String>,
    pub message: String,
}
impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for LoadError {}
impl Index {
    pub fn load(base: &Path) -> Result<Self, LoadError> {
        let mut tables = realm_reader::read(&base.join("client.realm"))
            .map_err(|e| LoadError {
                schema: None,
                missing_properties: vec![],
                message: e.to_string(),
            })?
            .rows;
        let version = tables
            .get("metadata")
            .and_then(|r| r.first())
            .and_then(|v| v["version"].as_i64());
        let compatibility = schema::inspect(
            tables
                .get("__schema")
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        if !compatibility.errors.is_empty() {
            return Err(LoadError {
                schema: version,
                missing_properties: compatibility.missing,
                message: format!(
                    "Incompatible Realm properties: {}",
                    compatibility.errors.join("; ")
                ),
            });
        }
        let schema = version.ok_or_else(|| LoadError {
            schema: None,
            missing_properties: vec!["metadata.version".into()],
            message: "metadata.version: missing schema version value".into(),
        })?;
        compatibility.project(&mut tables);
        let mut index = Self {
            schema,
            missing_properties: compatibility.missing,
            ..Self::default()
        };
        for v in tables.remove("class_BeatmapMetadata").unwrap_or_default() {
            index.metadata.insert(key(&v["_key"]).into_owned(), v);
        }
        let mut owned = BTreeSet::new();
        for v in tables.remove("class_BeatmapSet").unwrap_or_default() {
            if deleted(&v) {
                continue;
            }
            let id = key(&v["ID"]).into_owned();
            if let Some(n) = v["OnlineID"].as_i64().filter(|n| *n > 0) {
                owned.insert(n);
            }
            index.set_files.insert(id.clone(), files(base, &v));
            index.sets.insert(id, v);
        }
        index.online_ids = owned.into_iter().collect();
        let mut hash_to_md5 = HashMap::new();
        for mut v in tables.remove("class_Beatmap").unwrap_or_default() {
            if !index.sets.contains_key(key(&v["BeatmapSet"]).as_ref()) {
                continue;
            }
            let md5 = text(&v, "MD5Hash").to_ascii_lowercase();
            if md5.len() != 32 || !md5.bytes().all(|c| c.is_ascii_hexdigit()) {
                continue;
            }
            let ruleset = text(&v, "Ruleset");
            if !["osu", "taiko", "fruits", "mania"].contains(&ruleset.as_str()) {
                continue;
            }
            hash_to_md5.insert(text(&v, "Hash"), md5.clone());
            // Discard unrelated difficulty/user settings; shared set files stay indexed once.
            if let Some(o) = v.as_object_mut() {
                o.retain(|k, _| {
                    [
                        "ID",
                        "MD5Hash",
                        "Hash",
                        "BeatmapSet",
                        "Metadata",
                        "Ruleset",
                        "DifficultyName",
                        "OnlineID",
                    ]
                    .contains(&k.as_str())
                });
            }
            index.beatmaps.insert(md5, v);
        }
        for v in tables.remove("class_Skin").unwrap_or_default() {
            if deleted(&v) {
                continue;
            }
            let id = key(&v["ID"]).into_owned();
            index.skin_files.insert(id.clone(), files(base, &v));
            index.skins.insert(id, v);
        }
        let mut scores = 0;
        for v in tables.remove("class_Score").unwrap_or_default() {
            if deleted(&v) {
                continue;
            }
            scores += 1;
            let Some(md5) = hash_to_md5.get(&text(&v, "BeatmapHash")) else {
                continue;
            };
            let fs = files(base, &v);
            let replay = fs
                .iter()
                .find(|f| f.name.to_ascii_lowercase().ends_with(".osr"));
            let date = v["Date"]
                .as_str()
                .map(|s| format!("{}Z", s.replacen(' ', "T", 1)));
            index.scores.entry(md5.clone()).or_default().push(json!({
                "id": v["ID"], "beatmap_md5": md5,
                "username": v["User"]["Username"], "ruleset": v["Ruleset"],
                "mods": v["Mods"], "total_score": v["TotalScore"], "date": date,
                "replay_hash": replay.map(|r| &r.hash),
                "replay_path": replay.map(|r| &r.path)
            }));
        }
        index.counts = [
            index.sets.len(),
            index.beatmaps.len(),
            index.skins.len(),
            scores,
        ];
        Ok(index)
    }
    pub fn beatmap(&self, md5: &str) -> Option<Value> {
        let v = self.beatmaps.get(normalized_md5(md5).as_ref())?;
        let set_id = key(&v["BeatmapSet"]);
        let set = self.sets.get(set_id.as_ref())?;
        let fs = self.set_files.get(set_id.as_ref())?;
        let hash = v["Hash"].as_str().unwrap_or_default();
        let osu = fs.iter().find(|f| f.hash == hash)?;
        let metadata = self
            .metadata
            .get(key(&v["Metadata"]).as_ref())
            .unwrap_or(&Value::Null);
        let named = |name: &str| {
            fs.iter()
                .find(|f| unicase::UniCase::new(f.name.as_str()) == unicase::UniCase::new(name))
                .map(|f| f.path.clone())
        };
        Some(
            json!({"md5":text(v,"MD5Hash").to_ascii_lowercase(),"beatmap_id":positive(&v["OnlineID"]),"beatmapset_id":positive(&set["OnlineID"]),"ruleset":v["Ruleset"],"difficulty_name":v["DifficultyName"],"artist":metadata["Artist"],"title":metadata["Title"],"creator":metadata["Author"]["Username"],"files":fs,"osu_path":osu.path,"audio_path":named(&text(metadata,"AudioFile")),"background_path":named(&text(metadata,"BackgroundFile"))}),
        )
    }
    pub fn skin_list(&self) -> Value {
        let mut skins: Vec<_> = self.skins.iter().map(|(id, v)| {
            let builtin = match id.to_ascii_lowercase().as_str() {
                "2991cfd8-2140-469a-bcb9-2ec23fbce4ad" => Some("triangles"),
                "cffa69de-b3e3-4dee-8563-3c4f425c05d0" => Some("argon"),
                "9fc9cf5d-0f16-4c71-8256-98868321ac43" => Some("argon-pro"),
                "81f02cd3-eec6-4865-ac23-fae26a386187" => Some("legacy"),
                "0555c76a-cc6b-4bb4-9548-df76ba72ef25" => Some("retro"),
                _ => None,
            };
            json!({"id":id,"name":v["Name"],"creator":v["Creator"],"builtin":builtin,"files":self.skin_files[id].len()})
        }).collect();
        skins.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        json!({"skins":skins})
    }
}
#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub available: bool,
    pub data_dir: Option<PathBuf>,
    pub realm_schema: Option<i64>,
    pub refreshed_at: Option<String>,
    pub error: Option<String>,
    pub missing_properties: Vec<String>,
}
#[derive(Default)]
pub struct Library {
    pub status: Status,
    pub index: Option<Arc<Index>>,
}
pub type Shared = Arc<RwLock<Library>>;
fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"lazer library unavailable; inspect /v1/status"})),
    )
        .into_response()
}
fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response()
}
fn current(state: &Shared) -> Option<Arc<Index>> {
    state.read().ok()?.index.clone()
}
pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/v1/status", get(status))
        .route("/v1/beatmaps/by-md5/{md5}", get(beatmap))
        .route("/v1/beatmapsets/online-ids", get(online_ids))
        .route("/v1/skins", get(skins))
        .route("/v1/skins/{id}/files", get(skin_files))
        .route("/v1/skins/{id}/file/{*name}", get(skin_file))
        .route("/v1/scores/by-beatmap/{md5}", get(scores))
        .with_state(state)
}
async fn status(State(s): State<Shared>) -> Json<Status> {
    Json(s.read().unwrap().status.clone())
}
async fn beatmap(State(s): State<Shared>, RoutePath(md5): RoutePath<String>) -> Response {
    let Some(i) = current(&s) else {
        return unavailable();
    };
    i.beatmap(&md5)
        .map_or_else(not_found, |v| Json(v).into_response())
}
async fn online_ids(State(s): State<Shared>) -> Response {
    let Some(i) = current(&s) else {
        return unavailable();
    };
    Json(json!({"ids": i.online_ids})).into_response()
}
async fn skins(State(s): State<Shared>) -> Response {
    let Some(i) = current(&s) else {
        return unavailable();
    };
    Json(i.skin_list()).into_response()
}
async fn scores(State(s): State<Shared>, RoutePath(md5): RoutePath<String>) -> Response {
    let Some(i) = current(&s) else {
        return unavailable();
    };
    Json(
        json!({"scores": i.scores.get(normalized_md5(&md5).as_ref()).cloned().unwrap_or_default()}),
    )
    .into_response()
}
async fn skin_files(State(s): State<Shared>, RoutePath(id): RoutePath<String>) -> Response {
    let Some(i) = current(&s) else {
        return unavailable();
    };
    let Some(files) = i.skin_files.get(&id) else {
        return not_found();
    };
    let mut list = Vec::with_capacity(files.len());
    for file in files {
        let size = tokio::fs::metadata(&file.path).await.ok().map(|m| m.len());
        list.push(json!({"name":file.name, "hash":file.hash, "size":size}));
    }
    Json(json!({"files":list})).into_response()
}
async fn skin_file(
    State(s): State<Shared>,
    RoutePath((id, name)): RoutePath<(String, String)>,
) -> Response {
    let Some(i) = current(&s) else {
        return unavailable();
    };
    let Some(f) = i.skin_files.get(&id).and_then(|fs| {
        fs.iter().find(|f| {
            unicase::UniCase::new(f.name.as_str()) == unicase::UniCase::new(name.as_str())
        })
    }) else {
        return not_found();
    };
    let Ok(path) = tokio::fs::canonicalize(&f.path).await else {
        return not_found();
    };
    let base = s
        .read()
        .unwrap()
        .status
        .data_dir
        .clone()
        .unwrap_or_default();
    let Ok(root) = tokio::fs::canonicalize(base.join("files")).await else {
        return not_found();
    };
    if !path.starts_with(root) {
        return not_found();
    }
    match tokio::fs::metadata(&path).await {
        Ok(m) if m.len() <= 128 * 1024 * 1024 => {}
        _ => return (StatusCode::PAYLOAD_TOO_LARGE, "skin file exceeds 128 MiB").into_response(),
    }
    match tokio::fs::read(path).await {
        Ok(bytes) => (
            [
                ("content-type", "application/octet-stream"),
                ("x-content-type-options", "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => not_found(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schema_compatible_future_and_older_versions() {
        for variant in [1, -1001] {
            let dir = tempfile::tempdir().unwrap();
            realm_reader::fixture_schema(&dir.path().join("client.realm"), false, variant).unwrap();
            let index = Index::load(dir.path()).unwrap();
            assert_eq!(index.schema, i64::from(1052 + variant));
            assert!(index.beatmap("0123456789abcdef0123456789abcdef").is_some());
        }
    }
    #[test]
    fn schema_missing_optional_degrades_to_null() {
        let dir = tempfile::tempdir().unwrap();
        realm_reader::fixture_schema(&dir.path().join("client.realm"), false, 2).unwrap();
        let index = Index::load(dir.path()).unwrap();
        assert_eq!(index.schema, 1054);
        assert!(
            index
                .missing_properties
                .iter()
                .any(|p| p == "class_BeatmapMetadata.Artist")
        );
        let map = index.beatmap("0123456789abcdef0123456789abcdef").unwrap();
        assert!(map["artist"].is_null());
        assert_eq!(map["title"], "Fixture title");
    }
    #[test]
    fn schema_missing_or_changed_required_is_named() {
        for variant in [3, 4] {
            let dir = tempfile::tempdir().unwrap();
            realm_reader::fixture_schema(&dir.path().join("client.realm"), false, variant).unwrap();
            let error = Index::load(dir.path())
                .err()
                .expect("incompatible required property");
            assert_eq!(error.schema, Some(i64::from(1052 + variant)));
            assert!(error.message.contains("class_Beatmap.MD5Hash"));
            assert!(
                error
                    .missing_properties
                    .iter()
                    .any(|p| p == "class_Beatmap.MD5Hash")
            );
            let status = Status {
                available: false,
                realm_schema: error.schema,
                error: Some(error.message),
                missing_properties: error.missing_properties,
                ..Status::default()
            };
            let value = serde_json::to_value(status).unwrap();
            assert_eq!(value["realm_schema"], 1052 + variant);
            assert!(
                value["error"]
                    .as_str()
                    .unwrap()
                    .contains("class_Beatmap.MD5Hash")
            );
        }
    }
    #[test]
    fn synthetic_api() {
        let d = tempfile::tempdir().unwrap();
        realm_reader::fixture(&d.path().join("client.realm"), false).unwrap();
        let i = Index::load(d.path()).unwrap();
        assert_eq!(i.online_ids, vec![123]);
        let b = i.beatmap("0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(b["ruleset"], "mania");
        assert_eq!(b["artist"], "Fixture artist");
        assert_eq!(b["title"], "Fixture title");
        assert_eq!(b["creator"], "Fixture creator");
        assert_eq!(b["files"].as_array().unwrap().len(), 3);
        assert!(b["audio_path"].as_str().unwrap().ends_with(&"b".repeat(64)));
        assert!(
            b["background_path"]
                .as_str()
                .unwrap()
                .ends_with(&"c".repeat(64))
        );
        let score = &i.scores["0123456789abcdef0123456789abcdef"][0];
        assert_eq!(score["username"], "Fixture player");
        assert_eq!(score["mods"], "[{\"acronym\":\"DT\"}]");
        assert_eq!(score["date"], "2023-11-14T22:13:20.123456000Z");
        assert!(
            Path::new(b["osu_path"].as_str().unwrap())
                .ends_with(Path::new("a").join("aa").join("a".repeat(64)))
        );
        assert!(store_path(d.path(), "../secret").is_none());
    }
    #[tokio::test]
    async fn http_contract() {
        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        realm_reader::fixture(&dir.path().join("client.realm"), false).unwrap();
        let index = Index::load(dir.path()).unwrap();
        let asset = &index.skin_files["00000000-0000-0000-0000-000000000003"][0].path;
        std::fs::create_dir_all(asset.parent().unwrap()).unwrap();
        std::fs::write(asset, b"[General]\nName: synthetic\n").unwrap();
        let shared = Arc::new(RwLock::new(Library {
            status: Status {
                available: true,
                data_dir: Some(dir.path().to_owned()),
                realm_schema: Some(52),
                ..Status::default()
            },
            index: Some(Arc::new(index)),
        }));
        let app = router(shared.clone());
        for route in [
            "/v1/status",
            "/v1/beatmaps/by-md5/0123456789ABCDEF0123456789ABCDEF",
            "/v1/beatmapsets/online-ids",
            "/v1/skins",
            "/v1/skins/00000000-0000-0000-0000-000000000003/files",
            "/v1/scores/by-beatmap/0123456789abcdef0123456789abcdef",
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(route).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{route}");
            let value: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                    .unwrap();
            assert!(value.is_object());
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/skins/00000000-0000-0000-0000-000000000003/file/sKiN.iNi")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            &to_bytes(response.into_body(), 1024).await.unwrap()[..],
            b"[General]\nName: synthetic\n"
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/beatmaps/by-md5/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        shared.write().unwrap().index = None;
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/skins")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
