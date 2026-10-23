use osu_file::{
    map::{self, Options},
    mods,
};
const MANIA: &str = include_str!("fixtures/mania.osu");
fn options(mods: &[&str]) -> Options {
    Options {
        mods: mods.iter().map(|m| (*m).into()).collect(),
        seed: 1,
        ..Default::default()
    }
}
#[test]
fn native_mania_golden() {
    for (id, expected) in [
        ("IN", include_str!("fixtures/mania-in.osu")),
        ("HO", include_str!("fixtures/mania-ho.osu")),
        ("MR", include_str!("fixtures/mania-mr.osu")),
        ("RD", include_str!("fixtures/mania-rd.osu")),
    ] {
        assert_eq!(
            mods::apply(MANIA, &options(&[id])).unwrap(),
            expected,
            "{id}"
        );
    }
}
#[test]
fn compatible_combination_and_incompatibilities() {
    let o = Options {
        rate: 0.9,
        ..options(&["IN", "MR"])
    };
    let output = map::transform(MANIA, &o, "output.ogg").unwrap().text;
    assert!(output.contains("448,192,1111,128,0,2083:"));
    assert!(output.contains("BeatmapID:0"));
    assert!(output.contains("+IN+MR seed1"));
    assert!(mods::apply(MANIA, &options(&["IN", "HO"])).is_err());
    assert!(mods::apply(MANIA, &options(&["SW"])).is_err());
    assert!(mods::apply(MANIA, &options(&["DS"])).is_err());
}
#[test]
fn invert_duplicates_and_terminal_notes() {
    let text = MANIA.replace("[HitObjects]\n", "[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n");
    let output = mods::apply(&text, &options(&["IN"])).unwrap();
    assert!(output.contains("1000,128,0,1000:"));
    assert_eq!(mods::summary(&output).unwrap().0, 3);
}
#[test]
fn taiko_swap_and_lazer_seeded_values() {
    let source = MANIA
        .replace("Mode: 3", "Mode: 1")
        .replace("[HitObjects]\n", "[HitObjects]\n256,192,500,8,0,900\n");
    let output = mods::apply(&source, &options(&["SW"])).unwrap();
    assert!(output.contains("64,192,1000,1,8,"));
    assert!(output.contains("256,192,500,8,0,900"));
    let output = mods::apply(&source, &options(&["RD"])).unwrap();
    assert!(output.contains("64,192,1000,1,0,"));
    assert!(output.contains("192,192,1100,1,0,"));
    assert!(output.contains("320,192,1200,1,0,"));
    assert!(output.contains("448,192,1300,1,8,"));
}
#[test]
fn osu_mirror_slider_geometry() {
    let source = MANIA.replace("Mode: 3", "Mode: 0").replace(
        "[HitObjects]\n",
        "[HitObjects]\n50,60,500,2,0,B|100:110|200:210,1,180\n",
    );
    let output = mods::apply(
        &source,
        &Options {
            mirror: "both".into(),
            ..options(&["MR"])
        },
    )
    .unwrap();
    assert!(output.contains("462,324,500,2,0,B|412:274|312:174,1,180"));
    assert_eq!(
        mods::apply(
            &output,
            &Options {
                mirror: "both".into(),
                ..options(&["MR"])
            }
        )
        .unwrap(),
        source
    );
}
#[test]
fn all_signed_seeds_are_deterministic() {
    for seed in [i32::MIN, -1, 0, 1, i32::MAX] {
        let o = Options {
            seed,
            ..options(&["RD"])
        };
        assert_eq!(
            mods::apply(MANIA, &o).unwrap(),
            mods::apply(MANIA, &o).unwrap()
        );
    }
}
#[test]
fn rate_defaults_and_settings() {
    for (id, rate) in [("HT", 0.75), ("DC", 0.75), ("DT", 1.5), ("NC", 1.5)] {
        assert_eq!(map::effective(&options(&[id]), MANIA).unwrap().rate, rate);
    }
    assert!(map::effective(&options(&["HT", "DT"]), MANIA).is_err());
    assert!(
        map::effective(
            &Options {
                cs: Some(7.0),
                ..Default::default()
            },
            MANIA
        )
        .is_err()
    );
}

#[test]
fn hold_off_scroll_compensation_when_common_bpm_changes() {
    let source = MANIA
        .replace(
            "0,500,4,2,1,70,1,0",
            "0,500,4,2,1,70,1,0\n1500,250,4,2,1,70,1,0\n1600,-50,4,2,1,70,0,0",
        )
        .replace("2400:0:0:0:0:", "5000:0:0:0:0:");
    // Before HO: 250 ms occupies 3500 ms; after: 500 ms occupies 1500 ms.
    // Compensation ratio = 250/500 = 0.5, so inherited -50 becomes -100.
    let output = mods::apply(&source, &options(&["HO"])).unwrap();
    assert!(output.contains("0,-200,4,2,1,70,0,0"));
    assert!(output.contains("1500,-200,4,2,1,70,0,0"));
    assert!(output.contains("1600,-100,4,2,1,70,0,0"));
    assert!(output.contains("64,192,2000,1,0,0:0:0:0:"));
}

#[test]
fn audio_lead_in_and_preview_sentinels() {
    let source = MANIA.replace(
        "AudioFilename: audio.ogg",
        "AudioFilename: audio.ogg\nAudioLeadIn: 3000\nPreviewTime: -1",
    );
    let output = map::transform(
        &source,
        &Options {
            rate: 1.5,
            ..Default::default()
        },
        "out.ogg",
    )
    .unwrap()
    .text;
    assert!(output.contains("AudioLeadIn:2000"));
    assert!(output.contains("PreviewTime:-1"));
}

#[test]
fn difficulty_name_rounds_bpm_to_one_decimal() {
    // 60000 / 353.9091 ms = 169.535… BPM: the name shows 169.5, not 169.535004.
    let source = MANIA.replace("0,500,4,2,1,70,1,0", "0,353.9091,4,2,1,70,1,0");
    let name = |rate: f64| {
        let out = map::transform(
            &source,
            &Options {
                rate,
                ..Default::default()
            },
            "out.ogg",
        )
        .unwrap()
        .text;
        map::value(&out, "[Metadata]", "Version").unwrap()
    };
    assert!(
        name(1.0).starts_with("[Native] 1x (169.5bpm)"),
        "{}",
        name(1.0)
    );
    // 120 BPM sources stay integral.
    let out = map::transform(
        MANIA,
        &Options {
            rate: 1.5,
            ..Default::default()
        },
        "out.ogg",
    )
    .unwrap()
    .text;
    assert!(
        map::value(&out, "[Metadata]", "Version")
            .unwrap()
            .starts_with("[Native] 1.5x (180bpm)")
    );
}
