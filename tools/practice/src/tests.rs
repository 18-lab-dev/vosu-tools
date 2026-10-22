use super::*;
use std::{fs, sync::atomic::AtomicBool};
const INPUT: &str = include_str!("../tests/fixtures/all.osu");
#[test]
fn all_sections_golden() {
    let options = map::Options {
        rate: 2.0,
        lock_ar: true,
        lock_od: true,
        ..Default::default()
    };
    assert_eq!(
        map::transform(INPUT, &options, "output.ogg").unwrap().text,
        include_str!("../tests/fixtures/all-2x.osu")
    );
    for mode in 0..4 {
        let s = INPUT.replace("Mode: 3", &format!("Mode: {mode}"));
        let out = map::transform(&s, &options, "output.ogg").unwrap().text;
        assert!(out.contains("448,192,3000,128,0,4000:"));
    }
}
#[test]
fn bpm_and_rate() {
    assert_eq!(map::bpm(INPUT).unwrap(), 120.0);
    assert_eq!(map::rate_from_bpm(120.0, 180.0).unwrap(), 1.5);
    assert!(map::rate_from_bpm(120.0, 300.0).is_err());
    assert!(
        map::effective(
            &map::Options {
                rate: f64::NAN,
                ..Default::default()
            },
            INPUT
        )
        .is_err()
    );
}
#[test]
fn ar_od_formulas() {
    assert_eq!(map::ar_ms(0.0), 1800.0);
    assert_eq!(map::ar_ms(5.0), 1200.0);
    assert_eq!(map::ar_ms(10.0), 450.0);
    assert!((map::ms_ar(map::ar_ms(9.0) / 1.5) - 10.333333333).abs() < 1e-8);
    let s = INPUT.replace("Mode: 3", "Mode: 0");
    let out = map::transform(
        &s,
        &map::Options {
            rate: 1.5,
            ..Default::default()
        },
        "out.ogg",
    )
    .unwrap()
    .text;
    assert_eq!(
        map::value(&out, "[Difficulty]", "ApproachRate").unwrap(),
        "10"
    );
    let od: f64 = map::value(&out, "[Difficulty]", "OverallDifficulty")
        .unwrap()
        .parse()
        .unwrap();
    assert!((od - (80.0 - (80.0 - 6.0 * 8.0) / 1.5) / 6.0).abs() < 1e-6);
    let out = map::transform(
        &s,
        &map::Options {
            rate: 1.5,
            lock_ar: true,
            lock_od: true,
            ..Default::default()
        },
        "out.ogg",
    )
    .unwrap()
    .text;
    assert_eq!(
        map::value(&out, "[Difficulty]", "ApproachRate").unwrap(),
        "9"
    );
    assert_eq!(
        map::value(&out, "[Difficulty]", "OverallDifficulty").unwrap(),
        "8"
    );
}
#[test]
fn deterministic_audio_naming() {
    let o = map::Options::default();
    let a = store::audio_name(b"sound", &o, &[]);
    assert_eq!(a, store::audio_name(b"sound", &o, &[]));
    assert!(a.ends_with("-1-stretch.ogg"));
    assert_ne!(a, store::audio_name(b"other", &o, &[]));
    assert_ne!(
        a,
        store::audio_name(
            b"sound",
            &map::Options {
                pitch_preserving: false,
                ..o.clone()
            },
            &[]
        )
    );
    // Different cuts of the same audio never share a file.
    let window = |start: f64| osu_file::trim::Window {
        source_start: start,
        source_end: start + 1000.0,
        output_start: 0.0,
    };
    let cut = store::audio_name(b"sound", &o, &[window(0.0)]);
    assert!(cut.contains("-cut"));
    assert_ne!(cut, store::audio_name(b"sound", &o, &[window(500.0)]));
    assert_ne!(
        cut,
        store::audio_name(
            b"sound",
            &map::Options { fade_ms: 50.0, ..o },
            &[window(0.0)]
        )
    );
}
fn tone() -> audio::Audio {
    audio::Audio {
        sample_rate: 44100,
        channels: vec![
            (0..88200)
                .map(|i| (i as f32 * std::f32::consts::TAU * 440.0 / 44100.0).sin() * 0.3)
                .collect(),
        ],
    }
}
fn frequency(a: &audio::Audio) -> f64 {
    let v = &a.channels[0];
    let start = a.sample_rate as usize / 4;
    let end = v.len() - start;
    let count = v[start..end]
        .windows(2)
        .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
        .count();
    count as f64 * a.sample_rate as f64 / (end - start) as f64
}
#[test]
fn audio_length_pitch_and_codec() {
    let cancel = AtomicBool::new(false);
    let source = tone();
    let dir = tempfile::tempdir().unwrap();
    for rate in [0.8, 1.3] {
        for preserve in [false, true] {
            let out = audio::change(&source, rate, preserve, &cancel, |_| {}).unwrap();
            assert!((out.channels[0].len() as f64 - 88200.0 / rate).abs() <= 1.0);
            let expected = if preserve { 440.0 } else { 440.0 * rate };
            assert!(
                (frequency(&out) - expected).abs() < 3.0,
                "{} vs {expected}",
                frequency(&out)
            );
            let path = dir.path().join(format!("{rate}-{preserve}.ogg"));
            audio::encode(&out, &path, &cancel).unwrap();
            let decoded = audio::decode(&path, &cancel).unwrap();
            assert!(
                (decoded.channels[0].len() as f64 - out.channels[0].len() as f64).abs() < 100.0
            );
        }
    }
}

#[test]
fn nightcore_daycore_custom_rates_hold_default_pitch() {
    let cancel = AtomicBool::new(false);
    let source = tone();
    for (id, rate, pitch) in [("NC", 1.2, 1.5), ("DC", 0.9, 0.75)] {
        let options = map::Options {
            rate,
            mods: vec![id.into()],
            ..Default::default()
        };
        let output = audio::change_options(&source, &options, &cancel, |_| {}).unwrap();
        assert!((output.channels[0].len() as f64 - 88200.0 / rate).abs() <= 2.0);
        assert!((frequency(&output) - 440.0 * pitch).abs() < 3.0);
        assert!(
            store::audio_name(b"sound", &options, &[]).contains(if id == "NC" {
                "nightcore"
            } else {
                "daycore"
            })
        );
    }
}
#[test]
fn generated_idempotence_and_delete_safety() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("Songs");
    let folder = songs.join("test");
    fs::create_dir_all(&folder).unwrap();
    let file = folder.join("original.osu");
    fs::write(&file, INPUT).unwrap();
    let audio = folder.join("tone.wav");
    let mut wav = hound::WavWriter::create(
        &audio,
        hound::WavSpec {
            channels: 1,
            sample_rate: 44100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .unwrap();
    for sample in &tone().channels[0] {
        wav.write_sample((sample * 32767.0) as i16).unwrap();
    }
    wav.finalize().unwrap();
    let data = temp.path().join("data");
    fs::create_dir(&data).unwrap();
    let context = vosu_tool_sdk::Context {
        client: Some("stable".into()),
        songs_dir: Some(songs),
        beatmap: Some(vosu_tool_sdk::BeatmapContext {
            checksum: "test".into(),
            mode: "mania".into(),
            folder: folder.clone(),
            file: file.clone(),
            audio: Some(audio.clone()),
            background: None,
        }),
    };
    let cancel = AtomicBool::new(false);
    let options = map::Options {
        rate: 1.3,
        ..Default::default()
    };
    let a = store::generate(&data, None, &context, &options, &cancel, |_, _| {}).unwrap();
    let b = store::generate(&data, None, &context, &options, &cancel, |_, _| {}).unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(store::load(&data).unwrap().maps.len(), 1);
    assert!(store::delete(&data, "../../original.osu").is_err());
    assert!(store::confined(&folder, &data.join("index.json")).is_err());
    let mut index = store::load(&data).unwrap();
    index.maps[0].files.push(store::OwnedFile {
        path: file.clone(),
        hash: "wrong".into(),
    });
    store::save(&data, &index).unwrap();
    assert!(store::delete(&data, &a.id).is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), INPUT);
    index.maps[0].files.pop();
    store::save(&data, &index).unwrap();
    let variant = store::generate(
        &data,
        None,
        &context,
        &map::Options {
            hp: Some(7.0),
            ..options.clone()
        },
        &cancel,
        |_, _| {},
    )
    .unwrap();
    assert_eq!(a.files[1].path, variant.files[1].path);
    store::delete(&data, &a.id).unwrap();
    assert!(file.exists());
    assert!(audio.exists());
    assert!(!a.files[0].path.exists());
    assert!(a.files[1].path.exists());
    store::delete(&data, &variant.id).unwrap();
    assert!(!a.files[1].path.exists());
    let lazer = vosu_tool_sdk::Context {
        client: Some("lazer".into()),
        ..context
    };
    let export = store::generate(&data, None, &lazer, &options, &cancel, |_, _| {}).unwrap();
    assert!(export.export);
    assert!(!export.warnings.is_empty());
    let mut archive = zip::ZipArchive::new(fs::File::open(&export.files[0].path).unwrap()).unwrap();
    assert!(
        archive
            .by_name(&store::audio_name(
                &fs::read(&audio).unwrap(),
                &options,
                &[]
            ))
            .is_ok()
    );
    drop(archive);
    store::delete(&data, &export.id).unwrap();
    assert!(file.exists());
    assert!(audio.exists());
}

#[test]
fn trimmed_generation_cuts_audio_and_honours_export_folder() {
    let temp = tempfile::tempdir().unwrap();
    let songs = temp.path().join("Songs");
    let folder = songs.join("test");
    fs::create_dir_all(&folder).unwrap();
    let file = folder.join("original.osu");
    fs::write(&file, INPUT).unwrap();
    let audio = folder.join("tone.wav");
    let mut wav = hound::WavWriter::create(
        &audio,
        hound::WavSpec {
            channels: 1,
            sample_rate: 44100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .unwrap();
    for sample in &tone().channels[0] {
        wav.write_sample((sample * 32767.0) as i16).unwrap();
    }
    wav.finalize().unwrap();
    let data = temp.path().join("data");
    let exports = temp.path().join("exports");
    fs::create_dir_all(&exports).unwrap();
    let context = vosu_tool_sdk::Context {
        client: Some("stable".into()),
        songs_dir: Some(songs),
        beatmap: Some(vosu_tool_sdk::BeatmapContext {
            checksum: "test".into(),
            mode: "mania".into(),
            folder: folder.clone(),
            file: file.clone(),
            audio: Some(audio.clone()),
            background: None,
        }),
    };
    let cancel = AtomicBool::new(false);
    // Keep the circle at 1000: window 0..2000 (lead-in clamps at 0, lead-out 1 s).
    let options = map::Options {
        rate: 1.25,
        trims: vec![osu_file::trim::Range {
            start_ms: 900.0,
            end_ms: 1100.0,
        }],
        lead_in_ms: 2000.0,
        lead_out_ms: 1000.0,
        fade_ms: 20.0,
        ..Default::default()
    };
    let entry = store::generate(&data, None, &context, &options, &cancel, |_, _| {}).unwrap();
    let osu = fs::read_to_string(&entry.files[0].path).unwrap();
    assert!(
        osu.contains("64,192,800,5,0,0:0:0:0:"),
        "1000 → 1000 / 1.25"
    );
    assert!(
        !osu.contains("448,192,"),
        "objects outside the trim are gone"
    );
    assert!(entry.warnings.iter().any(|w| w.contains("storyboard")));
    let decoded = audio::decode(&entry.files[1].path, &cancel).unwrap();
    let expected = 2000.0 * 44.1 / 1.25;
    assert!(
        (decoded.channels[0].len() as f64 - expected).abs() <= 2.0,
        "audio is the 2 s window at 1.25×: {} samples",
        decoded.channels[0].len()
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), INPUT);
    // Lazer exports land in the configured folder.
    let lazer = vosu_tool_sdk::Context {
        client: Some("lazer".into()),
        ..context
    };
    let export =
        store::generate(&data, Some(&exports), &lazer, &options, &cancel, |_, _| {}).unwrap();
    assert!(
        export.files[0]
            .path
            .starts_with(exports.canonicalize().unwrap())
    );
    store::delete(&data, &export.id).unwrap();
    store::delete(&data, &entry.id).unwrap();
    assert!(file.exists() && audio.exists());
}

#[test]
fn fractional_rate_integer_timestamps_and_old_maps() {
    let source = INPUT
        .replace("BeatmapID:123\n", "")
        .replace("ApproachRate:9\n", "")
        .replace("Bookmarks: 1000,2000,4000", "Bookmarks:");
    let out = map::transform(
        &source,
        &map::Options {
            rate: 1.3,
            ..Default::default()
        },
        "out.ogg",
    )
    .unwrap()
    .text;
    assert!(out.contains("BeatmapID:0"));
    assert!(out.contains("ApproachRate:"));
    assert!(out.contains("64,192,769,1"));
    assert!(out.contains("448,192,4615,128,0,6154:"));
    assert!(out.contains("0,384.615385,4"));
    let crlf = map::transform(
        &INPUT.replace('\n', "\r\n"),
        &map::Options::default(),
        "out.ogg",
    )
    .unwrap()
    .text;
    assert!(crlf.ends_with("\r\n"));
    assert!(!crlf.replace("\r\n", "").contains('\n'));
}

#[test]
fn external_storyboard_offsets_and_asset_paths() {
    let storyboard = "[Events]\nSprite,Foreground,Centre,\"SB\\test.png\",320,240\n L,1000,2\n  F,0,500,1500,0,1\n3,1000,255,255,255\n";
    let out = map::storyboard(storyboard, 2.0).unwrap();
    assert!(out.contains(" L,500,2"));
    assert!(out.contains("  F,0,250,750,0,1"));
    assert!(out.contains("3,500,255,255,255"));
    assert_eq!(map::referenced_assets(storyboard), vec!["SB/test.png"]);
    let variable = "[Variables]\n$t=1000\n[Events]\n F,0,$t,2000,0,1\nAnimation,Foreground,Centre,\"anim.png\",320,240,2,100,LoopForever\n";
    let out = map::storyboard(variable, 2.0).unwrap();
    assert!(out.contains(" F,0,500,1000,0,1"));
    assert_eq!(
        map::referenced_assets(variable),
        vec!["anim0.png", "anim1.png"]
    );
}
