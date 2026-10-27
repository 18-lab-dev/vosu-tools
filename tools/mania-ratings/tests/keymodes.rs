//! Prism, Interlude patterns, LN statistics, the 7K view and the 7K dan
//! estimate: present exactly where they apply, with reasons elsewhere.
use rosu_map::Beatmap;
use serde_json::Value;
use vosu_mania_ratings::{
    DAN7K_NAMES, Params, Scope, analysis::timeline, calculate, estimate_dan_7k, ln, support,
};

fn demo(keys: u32) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/demo/mania-{keys}k.osu",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn chart(keys: u8, objects: &str) -> Vec<u8> {
    format!("osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:{keys}\nOverallDifficulty:8\n[HitObjects]\n{objects}").into_bytes()
}

#[test]
fn systems_apply_per_key_count() {
    for keys in 1..=10 {
        let d = calculate(&demo(keys), Params::new(1.0, None).unwrap()).unwrap();
        let has = |system: &str, present: bool| {
            assert_eq!(present, support(system, keys).is_ok(), "{keys}K {system}");
            if !present {
                assert!(d.unrated.contains_key(system), "{keys}K {system} reason");
            }
        };
        has("prism", d.prism.is_some());
        has("patterns", d.patterns.is_some());
        has("view7k", d.view7k.is_some());
        assert!(d.ln.is_some(), "{keys}K LN statistics");
        if keys == 7 {
            // The demo phrase is far easier than the 0th Dan course.
            assert!(d.dan7k.is_none());
            assert_eq!(d.unrated["dan7k"].scope, Scope::Estimate);
            let view = d.view7k.as_ref().unwrap();
            let ids: Vec<&str> = view.categories.iter().map(|c| c.id.as_str()).collect();
            assert_eq!(
                ids,
                [
                    "jack",
                    "chordjack",
                    "stream",
                    "chordstream",
                    "bracket",
                    "tech"
                ]
            );
            assert!(
                view.categories
                    .iter()
                    .all(|c| (0.0..=1.0).contains(&c.coverage))
            );
            assert!(view.categories[5].msd.is_none());
        } else {
            assert_eq!(d.unrated["dan7k"].scope, Scope::Keys);
        }
        for system in ["prism", "ln"] {
            let t = timeline(
                &demo(keys),
                Params::new(1.0, None).unwrap(),
                system,
                4.0,
                1.0,
            );
            match support(system, keys) {
                Ok(()) => {
                    let t = t.unwrap();
                    assert!(
                        t["points"].as_array().unwrap().len() > 10,
                        "{keys}K {system}"
                    );
                }
                Err(reason) => assert_eq!(t.unwrap_err(), reason),
            }
        }
    }
}

#[test]
fn prism_is_on_the_rate_curve_inputs() {
    let slow = calculate(&demo(7), Params::new(1.0, None).unwrap()).unwrap();
    let fast = calculate(&demo(7), Params::new(1.5, None).unwrap()).unwrap();
    assert!(fast.prism.unwrap().overall > slow.prism.unwrap().overall);
}

/// Re-derives the held-out error recorded in calibration-7k-sources.json.
#[test]
fn dan7k_calibration_and_held_out_error() {
    let anchors: Vec<f32> = serde_json::from_str(include_str!("../calibration-7k.json")).unwrap();
    let sources: Value =
        serde_json::from_str(include_str!("../calibration-7k-sources.json")).unwrap();
    assert_eq!(anchors.len(), DAN7K_NAMES.len());
    assert!(
        anchors.windows(2).all(|w| w[0] < w[1]),
        "course MSD must increase"
    );
    let charts = sources["charts"].as_array().unwrap();
    for (i, c) in charts.iter().enumerate() {
        assert_eq!(c["dan"].as_str().unwrap(), DAN7K_NAMES[i]);
        assert_eq!(c["msd_7k_1x"].as_f64().unwrap() as f32, anchors[i]);
        assert_eq!(c["md5"].as_str().unwrap().len(), 32);
    }
    let errors: Vec<f32> = (1..anchors.len() - 1)
        .map(|i| {
            let (a, b) = (anchors[i - 1], anchors[i + 1]);
            (i - 1) as f32 + (anchors[i] - a) / (b - a) * 2.0 - i as f32
        })
        .collect();
    let max = errors.iter().fold(0.0_f32, |m, e| m.max(e.abs()));
    let rmse = (errors.iter().map(|e| e * e).sum::<f32>() / errors.len() as f32).sqrt();
    let held = &sources["held_out"];
    assert!(
        (max - held["max"].as_f64().unwrap() as f32).abs() < 0.001,
        "{max}"
    );
    assert!(
        (rmse - held["rmse"].as_f64().unwrap() as f32).abs() < 0.001,
        "{rmse}"
    );
    assert!(held["uncertainty_shown"].as_f64().unwrap() as f32 >= max - 0.03);
    for (i, &a) in anchors.iter().enumerate() {
        let d = estimate_dan_7k(a).unwrap();
        assert!((d.value - i as f32).abs() < 1e-4);
        assert_eq!(d.label, format!("≈ {} Dan", DAN7K_NAMES[i]));
        assert!(d.uncertainty.is_some() && d.experimental);
    }
    assert!(estimate_dan_7k(anchors[0] - 0.01).is_none());
    assert!(estimate_dan_7k(anchors[13] + 0.01).is_none());
    assert!(estimate_dan_7k(f32::NAN).is_none());
}

/// With VOSU_JINJIN_DIR pointing at the 14 course charts (any file names),
/// MinaCalc reproduces every calibration anchor.
#[test]
fn dan7k_courses_reproduce_calibration() {
    let Ok(dir) = std::env::var("VOSU_JINJIN_DIR") else {
        return;
    };
    let sources: Value =
        serde_json::from_str(include_str!("../calibration-7k-sources.json")).unwrap();
    let mut by_md5 = std::collections::HashMap::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        by_md5.insert(vosu_mania_ratings::checksum(&bytes), bytes);
    }
    for c in sources["charts"].as_array().unwrap() {
        let bytes = &by_md5[c["md5"].as_str().unwrap()];
        let d = calculate(bytes, Params::new(1.0, None).unwrap()).unwrap();
        let msd = d.msd.unwrap().overall;
        assert!(
            (f64::from(msd) - c["msd_7k_1x"].as_f64().unwrap()).abs() < 1e-5,
            "{}",
            c["dan"]
        );
        let dan = d.dan7k.unwrap();
        assert_eq!(dan.label, format!("≈ {} Dan", c["dan"].as_str().unwrap()));
    }
}

#[test]
fn ln_statistics_and_indicators() {
    // 4K inverse layout: each column holds until 50 ms before its next head.
    let mut objects = String::new();
    for i in 0..40 {
        let column = i % 4;
        let start = 1000 + i * 250;
        objects.push_str(&format!(
            "{},192,{start},128,0,{}:0:0:0:0:\n",
            64 + column * 128,
            start + 950
        ));
    }
    let map = Beatmap::from_bytes(&chart(4, &objects)).unwrap();
    let s = ln::stats(&map, 4, 1.0);
    assert_eq!((s.notes, s.holds), (40, 40));
    assert_eq!(s.ln_share, 1.0);
    assert!(s.inverse_share.unwrap() >= 0.9 && s.coverage > 0.8); // the last four holds have no next note
    assert!(
        s.indicators.contains(&"full LN".to_owned())
            && s.indicators.contains(&"inverse".to_owned())
    );
    // Rice: no holds, no per-hold shares, no indicators.
    let rice = Beatmap::from_bytes(&chart(4, "64,192,1000,1,0\n192,192,1100,1,0\n")).unwrap();
    let s = ln::stats(&rice, 4, 1.0);
    assert!(s.inverse_share.is_none() && s.offbeat_release_share.is_none());
    assert!(s.indicators.is_empty() && s.ln_share == 0.0);
    // Playback rate scales release density.
    let fast = ln::stats(&map, 4, 1.5);
    let slow = ln::stats(&map, 4, 1.0);
    assert!((fast.releases_per_second / slow.releases_per_second - 1.5).abs() < 0.01);
}

#[test]
fn seven_key_view_finds_brackets() {
    // 7K: alternating 4- and 3-note chords without jacks, 1/4 at 150 BPM.
    let a = [0u32, 2, 4, 6];
    let b = [1u32, 3, 5];
    let mut objects = String::new();
    for i in 0..64 {
        let t = 1000 + i * 100;
        for &c in if i % 2 == 0 { &a[..] } else { &b[..] } {
            objects.push_str(&format!("{},192,{t},1,0\n", c * 73 + 36));
        }
    }
    let d = calculate(&chart(7, &objects), Params::new(1.0, None).unwrap()).unwrap();
    let view = d.view7k.unwrap();
    let bracket = view.categories.iter().find(|c| c.id == "bracket").unwrap();
    assert!(bracket.coverage > 0.5, "{bracket:?}");
    assert_eq!(bracket.main_bpm, Some(150)); // a row every 100 ms = 1/16 notes at 150 BPM
    assert_eq!(bracket.msd_source, "MinaCalc Bracketing");
    assert!(bracket.msd.is_some());
}
