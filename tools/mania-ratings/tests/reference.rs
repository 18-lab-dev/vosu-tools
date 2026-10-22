use rosu_map::Beatmap;
use serde_json::Value;
use vosu_mania_ratings::{Params, analysis, calculate, interlude, quaver, rows};
#[test]
fn upstream_reference_values_and_strain_arrays() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/reference.json")).unwrap();
    for f in fixtures {
        let bytes = std::fs::read(format!(
            "{}/tests/fixtures/{}",
            env!("CARGO_MANIFEST_DIR"),
            f["chart"].as_str().unwrap()
        ))
        .unwrap();
        let map = Beatmap::from_bytes(&bytes).unwrap();
        let rate = f["rate"].as_f64().unwrap() as f32;
        let (rating, series) = if f["system"] == "quaver" {
            quaver::calculate(&map, rate)
        } else {
            interlude::calculate(
                &rows(&map, map.circle_size as u32).unwrap(),
                map.circle_size as usize,
                rate,
            )
        };
        let expected = f["rating"].as_f64().unwrap() as f32;
        assert!(
            (rating - expected).abs() < 0.0002,
            "{} {} {rate}: {rating} != {expected}",
            f["system"],
            f["chart"]
        );
        let golden = f["series"].as_array().unwrap();
        assert_eq!(series.len(), golden.len(), "{} {}", f["system"], f["chart"]);
        for ((time, value), expected) in series.iter().zip(golden) {
            assert!((*time - expected[0].as_f64().unwrap() as f32).abs() < 0.0001);
            // Row stores seconds as f32 for the shared native ABI; ms round-trips
            // introduce tiny strain drift. Bound it to 0.003 absolute (<0.01% here).
            assert!(
                (*value - expected[1].as_f64().unwrap() as f32).abs() < 0.003,
                "{} {} {rate}: {value} != {}",
                f["system"],
                f["chart"],
                expected[1]
            );
        }
    }
}
#[test]
fn whole_map_sections_and_rate_steps() {
    let bytes = include_bytes!("fixtures/cyclic.osu");
    let p = Params::new(1.0, None).unwrap();
    let full = calculate(bytes, p).unwrap();
    let section = analysis::section(bytes, p, 0.0, 24001.0).unwrap();
    let part: vosu_mania_ratings::Difficulty =
        serde_json::from_value(section["rating"].clone()).unwrap();
    assert_eq!(full.msd.unwrap().overall, part.msd.unwrap().overall);
    assert_eq!(full.interlude, part.interlude);
    assert_eq!(full.quaver, part.quaver);
    assert_eq!(full.stars, part.stars);
    assert_eq!(
        analysis::rate_ticks(0.05).unwrap(),
        (10..=40).collect::<Vec<_>>()
    );
    assert!(analysis::rate_ticks(0.07).is_err());
    for system in [
        "etterna",
        "etterna-native",
        "quaver",
        "interlude",
        "osu",
        "nps",
    ] {
        let t = analysis::timeline(bytes, p, system, 1.0, 0.25).unwrap();
        assert!(
            t["points"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p["value"].as_f64().unwrap().is_finite())
        );
        assert_eq!(t["hop"], 0.25);
    }
}

#[test]
fn local_msd_is_an_actual_independent_window_calculation() {
    let bytes = include_bytes!("fixtures/cyclic.osu");
    let map = Beatmap::from_bytes(bytes).unwrap();
    let all_rows = rows(&map, 4).unwrap();
    for rate in [0.75, 1.0, 1.5] {
        let params = Params::new(rate, None).unwrap();
        let timeline = analysis::timeline(bytes, params, "etterna", 12.0, 1.0).unwrap();
        assert_eq!(timeline["mode"], "local_msd");
        assert_eq!(timeline["units"], "local MSD");
        assert_eq!(
            timeline["overall"],
            minacalc::calculate(&all_rows, 4, rate, None).unwrap()[0]
        );
        for point in timeline["points"].as_array().unwrap().iter().step_by(13) {
            let start = point["start"].as_f64().unwrap() as f32;
            let end = point["end"].as_f64().unwrap() as f32;
            let clipped = all_rows
                .iter()
                .filter(|r| r.seconds >= start && r.seconds < end)
                .map(|r| vosu_mania_ratings::Row {
                    notes: r.notes,
                    seconds: r.seconds - start,
                })
                .collect::<Vec<_>>();
            let expected = minacalc::calculate(&clipped, 4, rate, None).unwrap();
            let skills: [f32; 8] = serde_json::from_value(point["skills"].clone()).unwrap();
            assert_eq!(skills, expected);
            assert_eq!(point["value"], expected[0]);
        }
    }
}
