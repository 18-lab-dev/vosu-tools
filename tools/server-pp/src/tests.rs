use crate::engine::*;
use std::sync::Arc;
const MAP: &[u8] = include_bytes!("../tests/fixtures/reference.osu");
#[test]
fn pinned_server_libraries_are_reference_oracles() {
    // Expected values are produced independently by each pinned server library,
    // with the public service's stable scoring dispatch, never upstream rosu-pp.
    for mode in 0..4 {
        let source = String::from_utf8(MAP.to_vec())
            .unwrap()
            .replace("Mode: 0", &format!("Mode: {mode}"));
        let map = Map::parse(source.as_bytes()).unwrap();
        for server in ["akatsuki", "mamestagram"] {
            for bits in [0u32, 8, 64, 128, 8192] {
                if (bits == 128 && (mode == 3 || server == "mamestagram"))
                    || (bits == 8192 && (mode != 0 || server == "mamestagram"))
                {
                    continue;
                }
                let input = Input {
                    server: server.into(),
                    mods: bits.to_string(),
                    acc: Some(85.0),
                    combo: Some(12),
                    misses: 1,
                    ..Input::default()
                };
                let expected = if server == "mamestagram" {
                    mamestagram::Beatmap::from_bytes(source.as_bytes())
                        .unwrap()
                        .performance()
                        .mods(bits)
                        .lazer(false)
                        .combo(12)
                        .misses(1)
                        .accuracy(85.0)
                        .calculate()
                        .pp()
                } else if bits == 128 && mode == 0 {
                    akatsuki::osu_2019::OsuPP::from_map(
                        &akatsuki::Beatmap::from_bytes(source.as_bytes()).unwrap(),
                    )
                    .mods(bits)
                    .combo(12)
                    .misses(1)
                    .accuracy(85.0)
                    .calculate()
                    .pp
                } else {
                    akatsuki::Beatmap::from_bytes(source.as_bytes())
                        .unwrap()
                        .performance()
                        .mods(bits)
                        .lazer(false)
                        .combo(12)
                        .misses(1)
                        .accuracy(85.0)
                        .calculate()
                        .pp()
                };
                let actual = calculate(&map, &input, Profile::Builtin).unwrap()["current"]
                    .as_f64()
                    .unwrap();
                assert!(
                    (actual - expected).abs() < 1e-10,
                    "{server} mode={mode} mods={bits}: {actual} != {expected}"
                );
            }
        }
    }
}
#[test]
fn rejects_unverified_and_conflicting_mods() {
    let map = Map::parse(MAP).unwrap();
    for (server, mods) in [
        ("ripple", "NM"),
        ("mamestagram", "RX"),
        ("mamestagram", "AP"),
        ("akatsuki", "V2"),
        ("akatsuki", "RXAP"),
        ("akatsuki", "DTHT"),
        ("akatsuki", "HR EZ"),
        ("akatsuki", "MR"),
    ] {
        assert!(
            calculate(
                &map,
                &Input {
                    server: server.into(),
                    mods: mods.into(),
                    ..Input::default()
                },
                Profile::Builtin,
            )
            .is_err()
        );
    }
    assert_eq!(mods("HDDTRX").unwrap(), 8 | 64 | 128);
    assert_eq!(mods("NC").unwrap(), 512 | 64);
}
#[test]
fn cache_partitions_and_evicts_lru() {
    let map = Arc::new(Map::parse(MAP).unwrap());
    let mut cache = Cache::default();
    cache.insert("akatsuki", 128, map.clone());
    assert!(cache.get("akatsuki", &map.checksum, 0).is_none());
    assert!(cache.get("mamestagram", &map.checksum, 128).is_none());
    assert!(Arc::ptr_eq(
        &map,
        &cache.get("akatsuki", &map.checksum, 128).unwrap()
    ));
    for n in 0..33 {
        cache.insert("akatsuki", n, map.clone())
    }
    assert!(cache.get("akatsuki", &map.checksum, 0).is_none());
    assert!(cache.get("akatsuki", &map.checksum, 32).is_some());
}
#[test]
fn judgement_live_and_fc_are_distinct() {
    let map = Map::parse(MAP).unwrap();
    for server in ["akatsuki", "mamestagram"] {
        let i = Input {
            server: server.into(),
            n300: Some(8),
            n100: Some(1),
            n50: Some(0),
            misses: 1,
            combo: Some(5),
            passed_objects: Some(10),
            ..Input::default()
        };
        let r = calculate(&map, &i, Profile::Builtin).unwrap();
        assert!(r["if_fc"].as_f64().unwrap() > r["current"].as_f64().unwrap());
        let mut conflicting = i;
        conflicting.acc = Some(99.0);
        assert!(calculate(&map, &conflicting, Profile::Builtin).is_err());
    }
}

#[tokio::test]
async fn live_host_mapping_and_official_query() {
    use axum::{
        Json, Router,
        extract::{Query, State},
        routing::get,
    };
    use serde_json::json;
    use std::collections::HashMap;
    let checksum = format!("{:x}", md5::compute(MAP));
    let host = Router::new()
        .route("/files/beatmap/file", get(|| async { MAP }))
        .route(
            "/json/v2",
            get(move || {
                let checksum = checksum.clone();
                async move {
                    Json(json!({
                        "beatmap":{"checksum":checksum},
                        "play":{"mode":{"number":0},"mods":{"number":0},"combo":{"current":5},
                        "hits":{"300":8,"100":1,"50":0,"0":1,"geki":2,"katu":1}}
                    }))
                }
            }),
        )
        .route(
            "/api/calculate/pp",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                assert_eq!(q.get("nMisses").unwrap(), "1");
                assert_eq!(q.get("passedObjects").unwrap(), "10");
                assert_eq!(q.get("n300").unwrap(), "8");
                assert!(q.contains_key("nGeki"));
                Json(json!({"pp":42.0}))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let host = tokio::spawn(async move { axum::serve(listener, host).await.unwrap() });
    let dir = std::env::temp_dir().join(format!("vosu-server-pp-test-{}", std::process::id()));
    let env = vosu_tool_sdk::ToolEnv {
        id: "server-pp".into(),
        token: "test".into(),
        vosu_url: url,
        data_dir: dir.clone(),
        cache_dir: dir.clone(),
        interface: vosu_tool_sdk::Interface::Service,
    };
    let app = crate::App::new(env.client(), &env);
    let Json(result) = crate::current(
        State(app),
        Query(Input {
            server: "akatsuki".into(),
            ..Input::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(result["official"]["result"]["pp"], 42.0);
    assert!(result["if_fc"].as_f64().unwrap() > result["current"].as_f64().unwrap());
    host.abort();
    tokio::fs::remove_dir_all(dir).await.unwrap();
}

#[test]
fn legacy_rx_unrepresentable_accuracy_returns_error_not_panic() {
    let map = Map::parse(MAP).unwrap();
    for acc in [0.0, 98.5] {
        assert!(
            calculate(
                &map,
                &Input {
                    server: "akatsuki".into(),
                    mods: "RX".into(),
                    acc: Some(acc),
                    misses: 1,
                    ..Input::default()
                },
                Profile::Builtin,
            )
            .is_err()
        );
    }
}
