mod index;
mod schema;

use axum::{
    Json, Router,
    extract::{Path as RoutePath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
pub use index::{Index, LibraryFile, LoadError, release_allocator_pages};
use serde::Serialize;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
};
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
        .route("/v1/scores/recent", get(recent_scores))
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
    Json(i.score_list(&md5)).into_response()
}
#[derive(serde::Deserialize)]
struct Recent {
    ruleset: Option<String>,
    limit: Option<usize>,
}
/// `GET /v1/scores/recent[?ruleset=mania&limit=N]`: the newest local scores
/// with replays (at most 50).
async fn recent_scores(State(s): State<Shared>, Query(q): Query<Recent>) -> Response {
    let Some(i) = current(&s) else {
        return unavailable();
    };
    Json(i.recent_scores(q.ruleset.as_deref(), q.limit.unwrap_or(1).min(50))).into_response()
}
async fn skin_files(State(s): State<Shared>, RoutePath(id): RoutePath<String>) -> Response {
    let Some(i) = current(&s) else {
        return unavailable();
    };
    let Some(files) = i.skin_files(&id) else {
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
    let Some(f) = i.skin_file(&id, &name) else {
        return not_found();
    };
    let Ok(path) = tokio::fs::canonicalize(&f.path).await else {
        return not_found();
    };
    let Ok(root) = tokio::fs::canonicalize(i.data_dir().join("files")).await else {
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
    use serde_json::Value;
    use std::path::Path;
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
        let scores = i.score_list("0123456789abcdef0123456789abcdef");
        let score = &scores["scores"][0];
        assert_eq!(score["username"], "Fixture player");
        assert_eq!(score["mods"], "[{\"acronym\":\"DT\"}]");
        assert_eq!(score["date"], "2023-11-14T22:13:20.123456000Z");
        assert!(
            Path::new(b["osu_path"].as_str().unwrap())
                .ends_with(Path::new("a").join("aa").join("a".repeat(64)))
        );
        assert!(!i.contains_md5("../secret"));
        // The fixture's score has no replay file: not a recent play.
        assert!(
            i.recent_scores(None, 5)["scores"]
                .as_array()
                .unwrap()
                .is_empty()
        );
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
        let asset = index
            .skin_file("00000000-0000-0000-0000-000000000003", "skin.ini")
            .unwrap()
            .path;
        std::fs::create_dir_all(asset.parent().unwrap()).unwrap();
        std::fs::write(&asset, b"[General]\nName: synthetic\n").unwrap();
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
