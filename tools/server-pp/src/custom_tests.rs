use crate::{
    custom::{self, Calculator, Calculators, Limits, Resolved, Settings, abi},
    engine::{Input, Map, Profile, calculate},
};
use serde_json::{Value, json};
use std::{
    fmt::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

const REFERENCE: &[u8] = include_bytes!("../tests/fixtures/calculators/rosu_reference.wasm");
const RUST_EXAMPLE: &[u8] = include_bytes!("../tests/fixtures/calculators/rust_example.wasm");
const AS_EXAMPLE: &[u8] =
    include_bytes!("../tests/fixtures/calculators/assemblyscript_example.wasm");

/// A deterministic original map with streams, jumps, repeating sliders, an SV
/// change and spinners (columns and holds for mania, kats for taiko).
fn generated_map(mode: u8) -> String {
    let keys = if mode == 3 { 7 } else { 4 };
    let mut text = format!(
        "osu file format v14\n\n[General]\nAudioFilename: audio.mp3\nMode: {mode}\n\n\
         [Metadata]\nTitle:Pattern study\nArtist:server-pp tests\nCreator:server-pp\n\
         Version:Mode {mode}\nBeatmapID:4242\nBeatmapSetID:2121\n\n[Difficulty]\n\
         HPDrainRate:6\nCircleSize:{keys}\nOverallDifficulty:8.5\nApproachRate:9.3\n\
         SliderMultiplier:1.6\nSliderTickRate:2\n\n[TimingPoints]\n\
         0,333.333333333333,4,2,1,60,1,0\n30000,-75,4,2,1,60,0,0\n\n[HitObjects]\n"
    );
    let beat = 1000.0 / 3.0;
    let mut time = 1000.0_f64;
    let mut seed = 0x2545_f491_u32;
    let mut next = |range: u32| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed % range
    };
    for i in 0..360_u32 {
        let (x, y) = (32 + next(448), 32 + next(320));
        let t = time.round() as u32;
        if mode == 3 {
            let column = next(7) * 512 / 7 + 36;
            if i % 5 == 0 {
                writeln!(text, "{column},192,{t},128,0,{}:0:0:0:0:", t + 400).unwrap();
            } else {
                writeln!(text, "{column},192,{t},1,0,0:0:0:0:").unwrap();
            }
            time += beat / 4.0 * f64::from(1 + i % 2);
            continue;
        }
        match i % 12 {
            6..=8 => {
                let (x2, y2) = (32 + next(448), 32 + next(320));
                let repeats = 1 + i % 2;
                writeln!(text, "{x},{y},{t},2,0,B|{x2}:{y}|{x2}:{y2},{repeats},140").unwrap();
                let velocity = if time >= 30000.0 { 100.0 / 75.0 } else { 1.0 };
                time += 140.0 / (160.0 * velocity) * beat * f64::from(repeats) + beat / 2.0;
            }
            11 if i % 48 == 47 => {
                writeln!(text, "256,192,{t},12,0,{}", t + 1500).unwrap();
                time += 2000.0;
            }
            _ => {
                let sound = if mode == 1 && i % 3 == 0 { 2 } else { 0 };
                writeln!(text, "{x},{y},{t},1,{sound},0:0:0:0:").unwrap();
                time += if i % 24 < 8 { beat / 4.0 } else { beat / 2.0 };
            }
        }
    }
    text
}

fn resolved(bytes: &[u8], limits: Limits) -> Resolved {
    Resolved {
        id: "test".into(),
        name: "test".into(),
        calculator: Arc::new(Calculator::load(&custom::engine(), bytes, limits).unwrap()),
        limits,
    }
}

fn input(mods: &str) -> Input {
    Input {
        server: "test".into(),
        mods: mods.into(),
        ..Input::default()
    }
}

/// Played scores covering accuracy generation, explicit judgements, combo
/// breaks and partial plays.
fn scores(mods: &str) -> Vec<Input> {
    vec![
        Input {
            acc: Some(100.0),
            ..input(mods)
        },
        Input {
            acc: Some(96.5),
            misses: 3,
            combo: Some(150),
            ..input(mods)
        },
        Input {
            n300: Some(200),
            n100: Some(20),
            n50: Some(3),
            n_geki: Some(40),
            n_katu: Some(10),
            misses: 2,
            combo: Some(120),
            ..input(mods)
        },
        Input {
            n300: Some(100),
            n100: Some(10),
            misses: 2,
            combo: Some(60),
            passed_objects: Some(120),
            ..input(mods)
        },
    ]
}

fn relative(a: f64, b: f64) -> f64 {
    (a - b).abs() / b.abs().max(1e-12)
}

#[test]
fn reference_module_reproduces_rosu_pp_stable_formulas() {
    let reference = resolved(REFERENCE, Limits::default());
    let (mut checked, mut worst) = (0, 0.0_f64);
    for (native, mode) in [
        (0, None),
        (1, None),
        (2, None),
        (3, None),
        (0, Some(1)),
        (0, Some(2)),
        (0, Some(3)),
    ] {
        let map = Map::parse(generated_map(native).as_bytes()).unwrap();
        for mods in [
            "NM", "HD", "HR", "DT", "NC", "HT", "EZ", "FL", "HDFL", "HDDT", "HDHR", "NF", "SO",
            "RX", "AP", "TD", "HRDTFL", "EZHT",
        ] {
            for mut score in scores(mods) {
                score.mode = mode.map(|m: u8| m.to_string());
                let result = calculate(&map, &score, Profile::Custom(&reference))
                    .unwrap_or_else(|e| panic!("mode {native}->{mode:?} {mods}: {e}"));
                for (pp, base) in [
                    (&result["current"], &result["base"]["current"]),
                    (&result["if_fc"], &result["base"]["if_fc"]),
                ] {
                    let (pp, base) = (pp.as_f64().unwrap(), base.as_f64().unwrap());
                    let difference = relative(pp, base);
                    assert!(
                        difference <= 1e-12,
                        "mode {native}->{mode:?} {mods} {score:?}: module {pp} != rosu-pp {base}"
                    );
                    worst = worst.max(difference);
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 7 * 18 * 4 * 2);
    eprintln!("{checked} values match rosu-pp 4.0.1; worst relative difference {worst:e}");
}

#[test]
fn reference_breakdown_and_context_slots() {
    let reference = resolved(REFERENCE, Limits::default());
    let map = Map::parse(generated_map(0).as_bytes()).unwrap();
    assert_eq!(
        (map.beatmap_id, map.beatmapset_id),
        (Some(4242), Some(2121))
    );
    let result = calculate(
        &map,
        &Input {
            acc: Some(98.0),
            misses: 1,
            ..input("HDFL")
        },
        Profile::Custom(&reference),
    )
    .unwrap();
    assert_eq!(result["kind"], "custom");
    assert_eq!(result["attributes"], "rosu-pp 4.0.1");
    let breakdown = result["breakdown"].as_object().unwrap();
    assert_eq!(
        breakdown.keys().collect::<Vec<_>>(),
        [
            "accuracy",
            "aim",
            "effective_miss_count",
            "flashlight",
            "speed"
        ]
    );
    assert!(breakdown["flashlight"].as_f64().unwrap() > 0.0);
    assert!(result["fuel"].as_u64().unwrap() > 1000);
    // Catch declares no breakdown.
    let catch = Map::parse(generated_map(2).as_bytes()).unwrap();
    let result = calculate(&catch, &input("NM"), Profile::Custom(&reference)).unwrap();
    assert_eq!(result["breakdown"], json!({}));
}

#[test]
fn rust_example_handles_rulesets_relax_and_errors() {
    let example = resolved(RUST_EXAMPLE, Limits::default());
    let info = &example.calculator.info;
    assert_eq!(info.name.as_deref(), Some("Rust example"));
    assert_eq!(info.rulesets, [true, false, false, false]);
    let map = Map::parse(generated_map(0).as_bytes()).unwrap();
    let vanilla = calculate(&map, &input("HD"), Profile::Custom(&example)).unwrap();
    assert!(vanilla["current"].as_f64().unwrap() > 0.0);
    let relax = calculate(&map, &input("RX"), Profile::Custom(&example)).unwrap();
    assert_eq!(relax["breakdown"]["speed"], 0.0);
    assert_eq!(relax["breakdown"]["accuracy"], 0.0);
    assert!(relax["breakdown"]["aim"].as_f64().unwrap() > 0.0);
    let v2 = calculate(&map, &input("V2"), Profile::Custom(&example)).unwrap_err();
    assert_eq!(
        v2,
        "unsupported mods (status 2): this example has no ScoreV2 rules"
    );
    let taiko = Map::parse(generated_map(1).as_bytes()).unwrap();
    let error = calculate(&taiko, &input("NM"), Profile::Custom(&example)).unwrap_err();
    assert_eq!(error, "test does not support taiko");
}

#[test]
fn assemblyscript_example_scores_mania_only() {
    let example = resolved(AS_EXAMPLE, Limits::default());
    assert_eq!(
        example.calculator.info.name.as_deref(),
        Some("AssemblyScript example")
    );
    let mania = Map::parse(generated_map(3).as_bytes()).unwrap();
    let result = calculate(
        &mania,
        &Input {
            acc: Some(97.0),
            ..input("NM")
        },
        Profile::Custom(&example),
    )
    .unwrap();
    assert!(result["current"].as_f64().unwrap() > 0.0);
    assert!(result["breakdown"]["hold_bonus"].as_f64().unwrap() > 1.0);
    let easy = calculate(
        &mania,
        &Input {
            acc: Some(97.0),
            ..input("EZ")
        },
        Profile::Custom(&example),
    )
    .unwrap();
    assert!(easy["current"].as_f64().unwrap() < result["current"].as_f64().unwrap());
    // Bypass the host's declared-ruleset check to see the module's own error.
    let mut slots = [0.0; abi::INPUT_SLOTS];
    slots[abi::input::ABI] = 1.0;
    let error = example
        .calculator
        .run(&slots, Limits::default())
        .err()
        .unwrap();
    assert_eq!(
        error,
        "unsupported ruleset (status 1): this example scores osu!mania only"
    );
}

/// An ABI v1 module whose calculate body and extra items are given in WAT.
fn wat_module(memory_pages: u32, calculate: &str, extra: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module
            (memory (export "memory") {memory_pages})
            (func (export "vosu_pp_abi_version") (result i32) i32.const 1)
            (func (export "vosu_pp_input") (result i32) i32.const 0)
            (func (export "vosu_pp_output") (result i32) i32.const 512)
            (func (export "vosu_pp_calculate") (result i32) {calculate})
            {extra})"#
    ))
    .unwrap()
}

fn load(bytes: &[u8], limits: Limits) -> Result<Calculator, String> {
    Calculator::load(&custom::engine(), bytes, limits)
}

fn slots(ruleset: f64) -> [f64; abi::INPUT_SLOTS] {
    let mut slots = [0.0; abi::INPUT_SLOTS];
    slots[abi::input::ABI] = 1.0;
    slots[abi::input::RULESET] = ruleset;
    slots
}

#[test]
fn fuel_limit_stops_runaway_modules_and_instances_recover() {
    // Loops forever when the ruleset slot is 1, otherwise returns 42 pp.
    let module = wat_module(
        1,
        "(if (f64.eq (f64.load (i32.const 8)) (f64.const 1)) (then (loop $l (br $l))))
         (f64.store (i32.const 512) (f64.const 42))
         i32.const 0",
        "",
    );
    let limits = Limits {
        fuel: 1_000_000,
        ..Limits::default()
    };
    let calculator = load(&module, limits).unwrap();
    assert_eq!(
        calculator.run(&slots(0.0), limits).ok().unwrap().values[0],
        42.0
    );
    let started = Instant::now();
    let error = calculator.run(&slots(1.0), limits).err().unwrap();
    assert_eq!(
        error,
        "exceeded its fuel budget of 1000000 instructions (setting calculators.fuel)"
    );
    assert!(started.elapsed().as_secs_f64() < 1.0);
    assert_eq!(
        calculator.run(&slots(0.0), limits).ok().unwrap().values[0],
        42.0
    );
}

#[test]
fn memory_limit_caps_initial_and_grown_memory() {
    let limits = Limits {
        memory_bytes: 16 << 20,
        ..Limits::default()
    };
    // 512 pages = 32 MiB initial memory.
    let error = load(&wat_module(512, "i32.const 0", ""), limits)
        .err()
        .unwrap();
    assert!(error.starts_with("instantiation failed"), "{error}");
    // Growing by 64 MiB fails inside the module (memory.grow returns -1).
    let grow = wat_module(
        1,
        "(if (i32.eq (memory.grow (i32.const 1024)) (i32.const -1)) (then (return (i32.const 7))))
         i32.const 0",
        "",
    );
    let calculator = load(&grow, limits).unwrap();
    assert_eq!(
        calculator.run(&slots(0.0), limits).err().unwrap(),
        "calculation failed (status 7)"
    );
    // A larger limit allows it.
    let generous = Limits {
        memory_bytes: 128 << 20,
        ..limits
    };
    assert!(calculator.run(&slots(0.0), generous).is_ok());
}

#[test]
fn malformed_modules_are_rejected_with_reasons() {
    let limits = Limits::default();
    let cases: [(Vec<u8>, &str); 7] = [
        (b"not wasm".to_vec(), "invalid WebAssembly module"),
        (
            wat::parse_str(
                r#"(module (import "env" "abort" (func (param i32 i32 i32 i32))) (memory (export "memory") 1))"#,
            )
            .unwrap(),
            "modules must not import anything (found env::abort)",
        ),
        (
            wat::parse_str(r#"(module (memory (export "memory") 1))"#).unwrap(),
            "missing export vosu_pp_abi_version",
        ),
        (
            wat::parse_str(
                r#"(module (memory (export "memory") 1)
                (func (export "vosu_pp_abi_version") (result i32) i32.const 2)
                (func (export "vosu_pp_input") (result i32) i32.const 0)
                (func (export "vosu_pp_output") (result i32) i32.const 512)
                (func (export "vosu_pp_calculate") (result i32) i32.const 0))"#,
            )
            .unwrap(),
            "module implements ABI version 2; this server-pp supports 1",
        ),
        (
            wat::parse_str(
                r#"(module (memory (export "memory") 1)
                (func (export "vosu_pp_abi_version") (result i32) i32.const 1)
                (func (export "vosu_pp_input") (result i32) i32.const 0)
                (func (export "vosu_pp_output") (result i32) i32.const 65530)
                (func (export "vosu_pp_calculate") (result i32) i32.const 0))"#,
            )
            .unwrap(),
            "vosu_pp_output points outside linear memory",
        ),
        (
            wat_module(
                1,
                "i32.const 0",
                r#"(func (export "vosu_pp_info") (result i32) i32.const 1024)
                   (data (i32.const 1024) "[1,2]\00")"#,
            ),
            "vosu_pp_info must be a JSON object",
        ),
        (
            wat_module(1, "i32.const 0", r#"(func (export "vosu_pp_info") (param i32) (result i32) i32.const 0)"#),
            "export vosu_pp_info must have type () -> i32",
        ),
    ];
    for (bytes, expected) in cases {
        let error = load(&bytes, limits).err().unwrap();
        assert!(error.starts_with(expected), "{error:?} vs {expected:?}");
    }
}

#[test]
fn traps_status_messages_and_invalid_pp_are_reported() {
    let limits = Limits::default();
    let trap = load(&wat_module(1, "unreachable", ""), limits).unwrap();
    let error = trap.run(&slots(0.0), limits).err().unwrap();
    assert!(error.starts_with("trapped:"), "{error}");
    let status = load(
        &wat_module(
            1,
            "i32.const 2",
            r#"(func (export "vosu_pp_error") (result i32) i32.const 2048)
               (data (i32.const 2048) "HR is banned here\00")"#,
        ),
        limits,
    )
    .unwrap();
    assert_eq!(
        status.run(&slots(0.0), limits).err().unwrap(),
        "unsupported mods (status 2): HR is banned here"
    );
    let nan = Resolved {
        id: "nan".into(),
        name: "nan".into(),
        calculator: Arc::new(
            load(
                &wat_module(
                    1,
                    "(f64.store (i32.const 512) (f64.const nan)) i32.const 0",
                    "",
                ),
                limits,
            )
            .unwrap(),
        ),
        limits,
    };
    let map = Map::parse(generated_map(0).as_bytes()).unwrap();
    let error = calculate(&map, &input("NM"), Profile::Custom(&nan)).unwrap_err();
    assert_eq!(error, "nan returned an invalid pp value (NaN)");
}

#[test]
fn settings_parse_defaults_lists_and_limits() {
    let data = Path::new("/data");
    assert_eq!(
        Settings::from_values(&json!({}), data).unwrap(),
        Settings::defaults(data)
    );
    let settings = Settings::from_values(
        &json!({
            "calculators.folder": "/modules",
            "calculators.files": "# comment\n/abs/one.wasm\nrelax = relative/two.wasm\n",
            "calculators.enabled": "one\nrelax",
            "calculators.names": "relax = Relax server",
            "calculators.fuel": "2.5",
            "calculators.memory_mib": 32,
        }),
        data,
    )
    .unwrap();
    assert_eq!(settings.folder, PathBuf::from("/modules"));
    assert_eq!(
        settings.files,
        [
            (None, PathBuf::from("/abs/one.wasm")),
            (
                Some("relax".into()),
                PathBuf::from("/modules/relative/two.wasm")
            ),
        ]
    );
    assert_eq!(settings.enabled, Some(vec!["one".into(), "relax".into()]));
    assert_eq!(settings.names["relax"], "Relax server");
    assert_eq!(
        settings.limits,
        Limits {
            fuel: 2_500_000,
            memory_bytes: 32 << 20
        }
    );
    let all = Settings::from_values(&json!({"calculators.enabled": "*\nignored"}), data).unwrap();
    assert_eq!(all.enabled, None);
    for bad in [
        json!({"calculators.fuel": "lots"}),
        json!({"calculators.fuel": 0}),
        json!({"calculators.memory_mib": 4096}),
        json!({"calculators.names": "no separator"}),
    ] {
        assert!(Settings::from_values(&bad, data).is_err(), "{bad}");
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "vosu-server-pp-{name}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn registry_discovers_validates_disables_and_reloads() {
    let dir = temp_dir("registry");
    let folder = dir.join("calculators");
    let calculators = Calculators::new(&dir);
    assert!(folder.is_dir(), "default folder is created");
    std::fs::write(folder.join("Rust Example.wasm"), RUST_EXAMPLE).unwrap();
    std::fs::write(folder.join("broken.wasm"), b"\0asm garbage").unwrap();
    std::fs::write(folder.join("akatsuki.wasm"), RUST_EXAMPLE).unwrap();
    std::fs::write(folder.join("notes.txt"), b"ignored").unwrap();
    let extra = dir.join("mania.wasm");
    std::fs::write(&extra, AS_EXAMPLE).unwrap();
    calculators.refresh(Ok(json!({
        "calculators.files": format!("mania-lab = {}\nrust-example = {}", extra.display(), folder.join("Rust Example.wasm").display()),
        "calculators.names": "mania-lab = Mania lab",
    })));
    let (servers, config) = calculators.describe();
    let by_id = |id: &str| servers.iter().find(|s| s["id"] == id).unwrap().clone();
    assert_eq!(servers.len(), 5);
    assert_eq!(by_id("akatsuki")["status"], "error");
    assert!(
        by_id("akatsuki")["error"]
            .as_str()
            .unwrap()
            .contains("reserved")
    );
    assert_eq!(by_id("broken")["status"], "error");
    assert_eq!(by_id("rust-example")["status"], "ready");
    assert_eq!(by_id("rust-example")["name"], "Rust example");
    assert_eq!(by_id("rust-example")["rulesets"], json!(["osu"]));
    assert_eq!(by_id("mania-lab")["name"], "Mania lab");
    assert_eq!(
        by_id("mania-lab")["breakdown"],
        json!({"mania": ["difficulty", "accuracy_factor", "hold_bonus"]})
    );
    // The same file listed twice under one id is a duplicate.
    let duplicates = servers.iter().filter(|s| s["id"] == "rust-example").count();
    assert_eq!(duplicates, 2);
    assert!(servers.iter().any(|s| {
        s["error"]
            .as_str()
            .is_some_and(|e| e.starts_with("duplicate id"))
    }));
    assert!(calculators.resolve("rust-example").is_ok());
    assert_eq!(config["folder"], json!(folder));
    assert!(config["settings_error"].is_null());

    // Disabling via the enabled list.
    calculators.refresh(Ok(json!({"calculators.enabled": "mania-lab"})));
    let error = calculators.resolve("rust-example").err().unwrap();
    assert!(error.contains("is disabled"), "{error}");
    assert!(
        calculators
            .resolve("unknown")
            .err()
            .unwrap()
            .contains("unsupported server")
    );

    // Unreadable settings keep the previous configuration.
    calculators.refresh(Err("host unavailable".into()));
    assert_eq!(
        calculators.describe().1["settings_error"],
        "host unavailable"
    );
    assert!(calculators.resolve("rust-example").is_err());

    // Replacing a file reloads it.
    calculators.refresh(Ok(json!({})));
    let before = calculators
        .resolve("rust-example")
        .ok()
        .unwrap()
        .calculator
        .md5
        .clone();
    std::fs::write(folder.join("Rust Example.wasm"), REFERENCE).unwrap();
    calculators.refresh(Ok(json!({})));
    let after = calculators.resolve("rust-example").ok().unwrap();
    assert_ne!(after.calculator.md5, before);
    assert_eq!(after.name, "rosu-pp 4.0.1 reference");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn api_lists_and_runs_custom_calculators() {
    use axum::{
        Json, Router,
        body::Body,
        http::{Request, StatusCode},
        routing::get,
    };
    use tower::ServiceExt;
    let dir = temp_dir("api");
    std::fs::create_dir_all(dir.join("calculators")).unwrap();
    std::fs::write(dir.join("calculators/reference.wasm"), REFERENCE).unwrap();
    let host = Router::new().route(
        "/tools/_host/v1/settings",
        get(|| async { Json(json!({"calculators.fuel": 5})) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let host = tokio::spawn(async move { axum::serve(listener, host).await.unwrap() });
    let env = vosu_tool_sdk::ToolEnv {
        id: "server-pp".into(),
        token: "test".into(),
        vosu_url: url,
        data_dir: dir.clone(),
        cache_dir: dir.clone(),
        interface: vosu_tool_sdk::Interface::Service,
    };
    let router = crate::router(crate::App::new(env.client(), &env));
    let body = |response: axum::response::Response| async move {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice::<Value>(&bytes).unwrap()
    };
    let response = router
        .clone()
        .oneshot(Request::get("/v1/servers").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let servers = body(response).await;
    let custom = servers["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["kind"] == "custom")
        .unwrap()
        .clone();
    assert_eq!(custom["id"], "reference");
    assert_eq!(custom["status"], "ready");
    assert_eq!(servers["calculators"]["fuel"], 5_000_000);
    assert_eq!(servers["servers"][0]["kind"], "builtin");

    let response = router
        .clone()
        .oneshot(
            Request::post("/v1/calculate?server=reference&mods=HD&acc=98&mode=mania")
                .body(Body::from(generated_map(0)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result = body(response).await;
    assert_eq!(result["kind"], "custom");
    assert_eq!(result["mode"], 3);
    assert_eq!(result["official"]["available"], false);
    assert!(
        relative(
            result["current"].as_f64().unwrap(),
            result["base"]["current"].as_f64().unwrap()
        ) <= 1e-12
    );

    // Built-in profiles still refuse conversions.
    let response = router
        .oneshot(
            Request::post("/v1/calculate?server=akatsuki&mode=mania")
                .body(Body::from(generated_map(0)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    host.abort();
    std::fs::remove_dir_all(dir).unwrap();
}

/// Per-call latency. Run with
/// `cargo test --release -p vosu-server-pp -- --ignored --nocapture per_call`.
#[test]
#[ignore = "benchmark"]
fn per_call_latency() {
    const CALLS: u32 = 20_000;
    let limits = Limits::default();
    for (label, bytes, mode) in [
        ("rosu-pp reference (osu)", REFERENCE, 0_u8),
        ("Rust example (osu)", RUST_EXAMPLE, 0),
        ("AssemblyScript example (mania)", AS_EXAMPLE, 3),
    ] {
        let started = Instant::now();
        let calculator = load(bytes, limits).unwrap();
        let load_time = started.elapsed();
        let resolved = Resolved {
            id: "bench".into(),
            name: "bench".into(),
            calculator: Arc::new(calculator),
            limits,
        };
        let map = Map::parse(generated_map(mode).as_bytes()).unwrap();
        let score = Input {
            acc: Some(97.5),
            misses: 2,
            combo: Some(200),
            ..input("HDDT")
        };
        // Capture the exact slots one evaluation sends, then time the module alone.
        let result = calculate(&map, &score, Profile::Custom(&resolved)).unwrap();
        let fuel = result["fuel"].as_u64().unwrap();
        let mut slots = [0.0; abi::INPUT_SLOTS];
        slots[abi::input::ABI] = 1.0;
        slots[abi::input::RULESET] = f64::from(mode);
        slots[abi::input::STARS] = result["stars"].as_f64().unwrap();
        slots[abi::input::N300] = 300.0;
        slots[abi::input::N_GEKI] = 200.0;
        slots[abi::input::MAX_COMBO] = 400.0;
        slots[abi::input::COMBO] = 200.0;
        slots[abi::osu::GREAT_HIT_WINDOW] = 30.0;
        slots[abi::osu::OK_HIT_WINDOW] = 70.0;
        slots[abi::osu::MEH_HIT_WINDOW] = 110.0;
        slots[abi::osu::AIM] = 3.0;
        slots[abi::osu::SPEED] = 2.8;
        slots[abi::osu::SPEED_NOTE_COUNT] = 250.0;
        slots[abi::osu::AIM_DIFFICULT_STRAIN_COUNT] = 120.0;
        slots[abi::osu::SPEED_DIFFICULT_STRAIN_COUNT] = 90.0;
        slots[abi::osu::N_CIRCLES] = 300.0;
        slots[abi::mania::N_OBJECTS] = 360.0;
        for _ in 0..1000 {
            resolved.calculator.run(&slots, limits).ok().unwrap();
        }
        let started = Instant::now();
        for _ in 0..CALLS {
            resolved.calculator.run(&slots, limits).ok().unwrap();
        }
        let module_call = started.elapsed() / CALLS;
        // Fresh map: rosu-pp difficulty for the full map, then both calls.
        let started = Instant::now();
        for _ in 0..50 {
            let fresh = Map::parse(map.bytes.as_ref()).unwrap();
            calculate(&fresh, &score, Profile::Custom(&resolved)).unwrap();
        }
        let cold = started.elapsed() / 50;
        // Cached map: difficulty reused, two module calls (current + if-FC).
        let started = Instant::now();
        for _ in 0..CALLS {
            calculate(&map, &score, Profile::Custom(&resolved)).unwrap();
        }
        let warm = started.elapsed() / CALLS;
        // Live partial play: difficulty of the passed part each time.
        let partial = Input {
            n300: Some(140),
            n100: Some(8),
            misses: 2,
            combo: Some(90),
            passed_objects: Some(150),
            ..input("HDDT")
        };
        let started = Instant::now();
        for _ in 0..200 {
            calculate(&map, &partial, Profile::Custom(&resolved)).unwrap();
        }
        let live = started.elapsed() / 200;
        println!(
            "{label}: load {load_time:?}; module call {module_call:?} ({fuel} fuel); \
             request on a new map {cold:?}, cached map {warm:?}, partial live play {live:?}"
        );
    }
    // Worst case: a module that never returns runs until the default budget
    // is exhausted.
    let spin = load(&wat_module(1, "(loop $l (br $l)) i32.const 0", ""), limits).unwrap();
    let started = Instant::now();
    assert!(spin.run(&slots(0.0), limits).is_err());
    println!(
        "runaway module stopped after {:?} (default budget, {} fuel)",
        started.elapsed(),
        limits.fuel
    );
}

/// Fidelity over real maps: `SERVER_PP_FIDELITY_DIR=<Songs folder>` (read
/// only), optional `SERVER_PP_FIDELITY_LIMIT` (default 200 maps).
#[test]
#[ignore = "needs a local Songs folder"]
fn reference_module_matches_rosu_pp_on_real_maps() {
    let Ok(root) = std::env::var("SERVER_PP_FIDELITY_DIR") else {
        panic!("set SERVER_PP_FIDELITY_DIR");
    };
    let limit: usize = std::env::var("SERVER_PP_FIDELITY_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);
    let mut files = Vec::new();
    let mut stack = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "osu") {
                files.push(path);
            }
        }
    }
    files.sort();
    let reference = resolved(REFERENCE, Limits::default());
    let (mut maps, mut values, mut worst, mut per_mode) = (0, 0, 0.0_f64, [0; 4]);
    for path in files {
        if maps == limit {
            break;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(map) = Map::parse(&bytes) else {
            continue;
        };
        // The scores below need room for 5 misses and a broken combo.
        if map.akatsuki.hit_objects.len() < 20 {
            continue;
        }
        maps += 1;
        per_mode[map.akatsuki.mode as usize] += 1;
        for mods in ["NM", "HD", "HR", "DT", "HDDTHR", "EZHT", "FL"] {
            for score in [
                Input {
                    acc: Some(99.0),
                    ..input(mods)
                },
                Input {
                    acc: Some(94.0),
                    misses: 5,
                    combo: Some(map.akatsuki.hit_objects.len() as u32 / 3),
                    ..input(mods)
                },
            ] {
                let result = calculate(&map, &score, Profile::Custom(&reference))
                    .unwrap_or_else(|e| panic!("{}: {mods}: {e}", path.display()));
                for (pp, base) in [
                    (&result["current"], &result["base"]["current"]),
                    (&result["if_fc"], &result["base"]["if_fc"]),
                ] {
                    let (pp, base) = (pp.as_f64().unwrap(), base.as_f64().unwrap());
                    let difference = relative(pp, base);
                    assert!(
                        difference <= 1e-12,
                        "{} {mods}: module {pp} != rosu-pp {base}",
                        path.display()
                    );
                    worst = worst.max(difference);
                    values += 1;
                }
            }
        }
    }
    println!(
        "{maps} real maps (osu/taiko/catch/mania {per_mode:?}), {values} values match rosu-pp 4.0.1; worst relative difference {worst:e}"
    );
}
