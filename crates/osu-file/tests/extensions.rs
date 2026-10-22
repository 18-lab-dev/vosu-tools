use osu_file::{map::Options, mods};
const TAIKO: &str = include_str!("fixtures/taiko-cs.osu");
const RANDOM: &str = include_str!("fixtures/osu-random.osu");
fn options(id: &str) -> Options {
    Options {
        mods: vec![id.into()],
        ..Default::default()
    }
}
#[test]
fn constant_scroll_golden_keeps_every_non_sv_field() {
    assert_eq!(
        mods::apply(TAIKO, &options("CS")).unwrap(),
        include_str!("fixtures/taiko-cs-expected.osu")
    );
    let mania = include_str!("fixtures/mania-cs.osu");
    assert_eq!(
        mods::apply(mania, &options("CS")).unwrap(),
        include_str!("fixtures/mania-cs-expected.osu")
    );
}
// Independent legacy roll-duration model, retaining the operation order in
// TaikoBeatmapConverter.shouldConvertSliderToHits (ppy/osu recorded revision).
fn rolls(text: &str) -> Vec<(i64, usize)> {
    let mut points = Vec::<(f64, f64)>::new();
    let mut objects = Vec::new();
    let mut section = "";
    for line in text.lines() {
        if line.starts_with('[') {
            section = line;
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let p: Vec<_> = line.split(',').collect();
        if section == "[TimingPoints]" {
            points.push((p[0].parse().unwrap(), p[1].parse().unwrap()));
        }
        if section == "[HitObjects]" && p[3].parse::<u32>().unwrap() & 2 != 0 {
            objects.push(p);
        }
    }
    objects
        .into_iter()
        .map(|p| {
            let time = p[2].parse::<f64>().unwrap();
            let mut beat = 500.0;
            let mut factor = 1.0;
            for &(offset, value) in &points {
                if offset > time {
                    break;
                }
                if value > 0.0 {
                    beat = value;
                    factor = 1.0;
                } else {
                    factor = f64::from((-value as f32).clamp(10.0, 10000.0)) / 100.0;
                }
            }
            let mut distance = p[7].parse::<f64>().unwrap() * 1.4;
            distance *= p[6].parse::<f64>().unwrap();
            let scoring = 100.0 * (1.4 * 1.4) / 1.0;
            let duration = (distance / (scoring * 1.0) * (beat * factor)) as i64;
            let spacing = beat / 4.0;
            let ticks = ((duration as f64 + spacing / 2.0) / spacing).ceil() as usize;
            (duration, ticks)
        })
        .collect()
}
#[test]
fn constant_scroll_preserves_roll_duration_and_ticks_across_sv_bpm_changes() {
    let output = mods::apply(TAIKO, &options("CS")).unwrap();
    assert_eq!(rolls(TAIKO), rolls(&output));
    assert_eq!(
        rolls(&output),
        vec![(2000, 17), (1000, 9), (250, 5), (1000, 5), (1000, 5)]
    );
    assert_eq!(
        mods::summary(TAIKO).unwrap(),
        mods::summary(&output).unwrap()
    );
}
#[test]
fn constant_scroll_is_constant_and_idempotent() {
    let output = mods::apply(TAIKO, &options("CS")).unwrap();
    let mut beat = 500.0;
    let mut active = false;
    for line in output.lines() {
        if line.starts_with('[') {
            active = line == "[TimingPoints]";
            continue;
        }
        if !active || line.is_empty() {
            continue;
        }
        let p: Vec<_> = line.split(',').collect();
        let value = p[1].parse::<f64>().unwrap();
        if value > 0.0 {
            beat = value;
        } else {
            assert!((60000.0 / beat * (-100.0 / value) - 240.0).abs() < 1e-9);
        }
    }
    assert_eq!(mods::apply(&output, &options("CS")).unwrap(), output);
}
#[test]
fn osu_random_matches_executed_csharp_lazer_helper_vectors() {
    for (seed, sharpness, expected) in [
        (1, 7.0, include_str!("fixtures/osu-random-1-7.osu")),
        (1337, 1.0, include_str!("fixtures/osu-random-1337-1.osu")),
        (-42, 10.0, include_str!("fixtures/osu-random--42-10.osu")),
    ] {
        let o = Options {
            seed,
            angle_sharpness: sharpness,
            ..options("RD")
        };
        assert_eq!(
            mods::apply(RANDOM, &o).unwrap(),
            expected,
            "seed {seed} sharpness {sharpness}"
        );
    }
}
#[test]
fn catch_mirror_reflects_fruit_and_slider_path_not_banana_shower() {
    let source = RANDOM.replace("Mode: 0", "Mode: 2");
    let output = mods::apply(&source, &options("MR")).unwrap();
    assert!(output.contains("482,30,1000,5,"));
    assert!(output.contains("412,200,1750,2,0,L|92:200,2,320"));
    assert!(output.contains("250,192,4500,8,0,4800"));
    assert_eq!(mods::apply(&output, &options("MR")).unwrap(), source);
}

#[test]
fn constant_scroll_preserves_fractional_legacy_roll_boundaries() {
    for green in [-17.3, -113.7, -499.1, -3917.3] {
        let source = TAIKO
            .replace("0,-200,", &format!("0,{green},"))
            .replace("0,500,", "0,500.3,")
            .replace("2000,250,", "2000,250.8,");
        let output = mods::apply(&source, &options("CS")).unwrap();
        assert_eq!(rolls(&source), rolls(&output), "{green}");
    }
}

#[test]
fn random_curved_slider_paths_parse_and_remain_seeded() {
    for curve in [
        "B|200:60|320:200",
        "P|260:40|420:200",
        "C|160:100|300:250|420:200",
    ] {
        let source = RANDOM.replace("L|420:200", curve);
        let o = Options {
            seed: 912,
            ..options("RD")
        };
        let first = mods::apply(&source, &o).unwrap();
        assert_eq!(first, mods::apply(&source, &o).unwrap());
        let parsed = rosu_map::Beatmap::from_bytes(first.as_bytes()).unwrap();
        assert_eq!(parsed.hit_objects.len(), 18);
        assert_ne!(
            first,
            mods::apply(&source, &Options { seed: 913, ..o }).unwrap()
        );
    }
}
