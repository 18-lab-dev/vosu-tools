use rosu_map::Beatmap;
use vosu_mania_ratings::{
    Params, Scope, analysis::timeline, calculate, checksum, estimate_dan, rows, support,
};
fn chart(mode: u8, keys: u8, objects: &str) -> Vec<u8> {
    format!("osu file format v14\n[General]\nMode:{mode}\n[Difficulty]\nCircleSize:{keys}\n[HitObjects]\n{objects}").into_bytes()
}
#[test]
fn four_key_rows_merge_and_hold_heads_only() {
    let b = chart(
        3,
        4,
        "0,192,1000,1,0\n127,192,1000,1,0\n128,192,1000,1,0\n256,192,2000,128,0,4000:0:0:0:0:\n512,192,3000,1,0\n",
    );
    let r = rows(&Beatmap::from_bytes(&b).unwrap(), 4).unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[0].notes, 3);
    assert_eq!(r[1].notes, 4);
    assert_eq!(r[2].notes, 8);
    assert_eq!(r[1].seconds, 2.0);
}
#[test]
fn seven_key_column_mapping() {
    let b = chart(
        3,
        7,
        "0,192,1000,1,0\n73,192,1100,1,0\n74,192,1200,1,0\n256,192,1300,1,0\n511,192,1400,1,0\n",
    );
    let r = rows(&Beatmap::from_bytes(&b).unwrap(), 7).unwrap();
    assert_eq!(
        r.iter().map(|r| r.notes).collect::<Vec<_>>(),
        [1, 1, 2, 8, 64]
    );
}
#[test]
fn rate_validation_and_keying() {
    for r in [f32::NAN, f32::INFINITY, 0.49, 2.01] {
        assert!(Params::new(r, None).is_err());
    }
    for s in [f32::NAN, -0.01, 1.01] {
        assert!(Params::new(1.0, Some(s)).is_err());
    }
    let p = Params::new(1.024, None).unwrap();
    assert_eq!(p.rate(), 1.0);
    assert_eq!(Params::new(1.026, None).unwrap().rate(), 1.05);
    assert_eq!(p.key("a"), Params::new(1.0, None).unwrap().key("a"));
    assert_ne!(p.key("a"), p.key("b"));
    assert_ne!(p.key("a"), Params::new(1.05, None).unwrap().key("a"));
    assert_ne!(p.key("a"), Params::new(1.0, Some(0.93)).unwrap().key("a"));
    assert_ne!(
        Params::new(1.0, Some(0.94)).unwrap().key("a"),
        Params::new(1.0, Some(0.93)).unwrap().key("a")
    );
    assert_eq!(checksum(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
}
#[test]
fn unsupported_modes_and_key_counts() {
    for (mode, keys) in [(0, 4), (1, 4), (2, 4), (3, 0), (3, 19)] {
        let d = calculate(&chart(mode, keys, ""), Params::new(1.0, None).unwrap()).unwrap();
        assert!(d.unsupported.is_some(), "{mode} {keys}K");
        assert!(d.msd.is_none() && d.ssr.is_none() && d.dan.is_none() && d.stars.is_none());
    }
    let fractional = String::from_utf8(chart(3, 4, ""))
        .unwrap()
        .replace("CircleSize:4", "CircleSize:4.5");
    let d = calculate(fractional.as_bytes(), Params::new(1.0, None).unwrap()).unwrap();
    assert!(d.unsupported.is_some());
}

fn demo(keys: u32) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/demo/mania-{keys}k.osu",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

/// Every calculator either rates a key count or names its own limit; nothing
/// borrows another key count's model, skill names or values.
#[test]
fn demo_maps_rate_per_calculator_for_every_key_count() {
    for keys in 1..=10 {
        let d = calculate(&demo(keys), Params::new(1.0, None).unwrap()).unwrap();
        assert_eq!(d.keys, keys);
        assert!(d.unsupported.is_none(), "{keys}K");
        assert!(d.stars.is_some_and(|s| s > 0.0), "{keys}K osu!mania stars");
        let expect = |system: &str, present: bool| {
            let supported = support(system, keys).is_ok();
            assert_eq!(present, supported, "{keys}K {system}");
            if !supported {
                let why = &d.unrated[system];
                assert_eq!(why.scope, Scope::Keys);
                assert!(
                    why.reason.starts_with(&format!("Not rated for {keys}K")),
                    "{}",
                    why.reason
                );
            }
        };
        expect("etterna", d.msd.is_some());
        expect("quaver", d.quaver.is_some());
        expect("interlude", d.interlude.is_some());
        assert_eq!(
            d.msd.as_ref().map(|m| m.technical.is_some()),
            d.msd.as_ref().map(|_| keys == 4),
            "{keys}K technical"
        );
        if keys != 4 {
            assert!(d.dan.is_none() && d.unrated["reform"].reason.contains("4K only"));
        }
        for system in [
            "etterna",
            "etterna-native",
            "quaver",
            "interlude",
            "osu",
            "nps",
        ] {
            let t = timeline(
                &demo(keys),
                Params::new(1.0, None).unwrap(),
                system,
                4.0,
                1.0,
            );
            match support(system, keys) {
                Ok(()) => assert!(t.is_ok(), "{keys}K {system}: {t:?}"),
                Err(reason) => assert_eq!(t.unwrap_err(), reason),
            }
        }
    }
    assert_eq!(
        (
            support("etterna", 7),
            support("quaver", 10),
            support("interlude", 2)
        ),
        (
            Ok(()),
            Ok(()),
            Err("Not rated for 2K: Interlude's hand layout covers 3K–10K only.".into())
        )
    );
}

/// Every 0.05× step of the rate curve returns a value or a reason, never an error.
#[test]
fn rate_curve_never_fails_on_demo_maps() {
    for keys in [4, 5, 6, 7, 8, 9, 10] {
        for tick in 10..=40 {
            let d = calculate(
                &demo(keys),
                Params {
                    rate_tick: tick,
                    score: None,
                },
            )
            .unwrap();
            assert!(
                d.msd.is_some() || d.unrated.contains_key("etterna"),
                "{keys}K {tick}"
            );
        }
    }
}

/// Dense 7K chord stream: MinaCalc 527 passes its search limit at high rates
/// (upstream returns 0 Handstream and NaN Stamina). That is reported as no
/// rating with the reason instead of failing the whole response.
#[test]
fn minacalc_ceiling_is_a_reason_not_an_error() {
    // Same chord rotation as the minacalc crate's unit test: 24 three-note rows/s for 60 s.
    let chords: [&[u32]; 4] = [&[0, 2, 4], &[1, 4, 6], &[0, 3, 5], &[1, 3, 6]];
    let mut objects = String::new();
    for i in 0..1440 {
        for column in chords[i % 4] {
            objects.push_str(&format!("{},192,{},1,0\n", column * 73 + 36, i * 1000 / 24));
        }
    }
    let bytes = chart(3, 7, &objects);
    let low = calculate(&bytes, Params::new(0.5, None).unwrap()).unwrap();
    assert!(low.msd.is_some());
    let high = calculate(&bytes, Params::new(2.0, None).unwrap()).unwrap();
    assert!(high.msd.is_none());
    assert_eq!(high.unrated["etterna"].scope, Scope::Rate);
    assert!(
        high.unrated["etterna"]
            .reason
            .starts_with("Beyond MinaCalc 527's 7K range")
    );
    assert!(high.quaver.is_some() && high.interlude.is_some() && high.stars.is_some());
    let local = timeline(
        &bytes,
        Params::new(2.0, None).unwrap(),
        "etterna",
        12.0,
        6.0,
    )
    .unwrap();
    assert!(local["overall"].is_null() && local["unrated"].is_string());
    assert!(
        local["points"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["value"].is_null())
    );
}
#[test]
fn reference_golden_and_ssr() {
    let d = calculate(
        include_bytes!("fixtures/cyclic.osu"),
        Params::new(1.0, Some(0.93)).unwrap(),
    )
    .unwrap();
    assert!((d.msd.unwrap().overall - 6.11).abs() < 0.0001);
    assert!(d.ssr.unwrap().overall.is_finite());
    assert_eq!(d.notes, 1200);
}
#[test]
fn dan_interpolation_is_calibrated_and_not_extrapolated() {
    assert_eq!(estimate_dan(15.5289).unwrap().value, 1.0);
    assert_eq!(estimate_dan(26.4069).unwrap().value, 10.0);
    assert!((estimate_dan((15.5289 + 17.0718) / 2.0).unwrap().value - 1.5).abs() < 0.00001);
    assert!(estimate_dan(0.0).is_none());
    assert!(estimate_dan(40.0).is_none());
}

#[test]
fn nonempty_six_and_seven_key_calculation_and_score_endpoints() {
    for keys in [4, 6, 7] {
        let source = include_str!("fixtures/cyclic.osu")
            .replace("CircleSize:4", &format!("CircleSize:{keys}"));
        for score in [0.0, 0.93, 1.0] {
            let result =
                calculate(source.as_bytes(), Params::new(1.0, Some(score)).unwrap()).unwrap();
            assert!(result.msd.unwrap().overall > 0.0);
            assert!(result.ssr.unwrap().overall.is_finite());
            if keys != 4 {
                assert!(result.dan.is_none());
            }
        }
    }
}
