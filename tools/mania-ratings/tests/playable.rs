//! Slider and spinner objects in native mania charts are converted as osu!
//! (lazer) plays them (tests/reference/lazer/generate.py), and every system
//! then rates the chart.
use rosu_map::{Beatmap, section::hit_objects::HitObjectKind};
use serde_json::Value;
use vosu_mania_ratings::{Params, calculate, checksum, playable::playable};

/// Notes and holds as lazer's oracle prints them: start, end, column, kind.
fn played(bytes: &[u8]) -> (u32, Vec<(f64, f64, u32, &'static str)>) {
    let converted = playable(bytes).unwrap();
    let map = Beatmap::from_bytes(&converted).unwrap();
    let keys = map.circle_size as u32;
    let mut objects: Vec<_> = map
        .hit_objects
        .iter()
        .map(|o| {
            let (x, end, kind) = match &o.kind {
                HitObjectKind::Circle(c) => (c.pos.x, o.start_time, "note"),
                HitObjectKind::Hold(h) => (h.pos_x, o.start_time + h.duration, "hold"),
                other => panic!("unconverted object {other:?}"),
            };
            let column = ((x * keys as f32 / 512.0).floor() as u32).min(keys - 1);
            (o.start_time, end, column, kind)
        })
        .collect();
    objects.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.2.cmp(&b.2)));
    (keys, objects)
}

fn compare(reference: &[Value], path_of: impl Fn(&str) -> String) {
    for r in reference {
        let path = path_of(r["chart"].as_str().unwrap());
        let (keys, ours) = played(&std::fs::read(&path).unwrap());
        assert_eq!(u64::from(keys), r["columns"].as_u64().unwrap(), "{path}");
        let mut lazer: Vec<(f64, f64, u32, String)> = r["objects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| {
                (
                    o[0].as_f64().unwrap(),
                    o[1].as_f64().unwrap(),
                    o[2].as_u64().unwrap() as u32,
                    o[3].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        lazer.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.2.cmp(&b.2)));
        assert_eq!(ours.len(), lazer.len(), "{path}");
        for (o, l) in ours.iter().zip(&lazer) {
            assert_eq!((o.0, o.2, o.3), (l.0, l.2, l.3.as_str()), "{path}");
            assert!((o.1 - l.1).abs() < 1e-6, "{path}: end {} vs {}", o.1, l.1);
        }
    }
}

#[test]
fn matches_lazer_on_fixtures() {
    let reference: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/lazer-reference.json")).unwrap();
    assert_eq!(reference.len(), 5);
    compare(&reference, |chart| {
        format!("{}/tests/fixtures/{chart}", env!("CARGO_MANIFEST_DIR"))
    });
}

/// Real charts: `generate.py --oracle … --out FILE chart.osu ...`, then set
/// VOSU_LAZER_REFERENCE=FILE. Skipped when unset.
#[test]
fn matches_lazer_on_listed_charts() {
    let Ok(file) = std::env::var("VOSU_LAZER_REFERENCE") else {
        return;
    };
    let reference: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    compare(&reference, str::to_owned);
    eprintln!("compared {} charts", reference.len());
}

/// Every system rates a chart with sliders and spinners, the file's checksum
/// is kept, and only the converted lines change.
#[test]
fn every_system_rates_charts_with_sliders_and_spinners() {
    for (chart, keys) in [("sliders-7k", 7), ("mixed-7k-v12", 7), ("spinners-8k", 8)] {
        let path = format!(
            "{}/tests/fixtures/objects/{chart}.osu",
            env!("CARGO_MANIFEST_DIR")
        );
        let bytes = std::fs::read(&path).unwrap();
        let d = calculate(&bytes, Params::new(1.0, None).unwrap()).unwrap();
        assert_eq!(d.checksum, checksum(&bytes), "{chart}");
        assert_eq!(d.keys, keys);
        assert!(d.unsupported.is_none(), "{chart}: {:?}", d.unsupported);
        assert!(d.stars.is_some() && d.quaver.is_some() && d.interlude.is_some());
        assert!(d.patterns.is_some() && d.ln.is_some(), "{chart}");
        assert!(d.ln.as_ref().unwrap().holds > 0, "{chart}");
        if keys == 7 {
            assert!(d.msd.is_some(), "{chart}: {:?}", d.unrated);
        }
        if keys == 8 {
            assert!(d.prism.is_some(), "{chart}");
        }
        let text = String::from_utf8(bytes.clone()).unwrap();
        let converted = String::from_utf8(playable(&bytes).unwrap().into_owned()).unwrap();
        assert_eq!(text.lines().count(), converted.lines().count(), "{chart}");
        assert_eq!(
            text.ends_with("\r\n"),
            converted.ends_with("\r\n"),
            "{chart}"
        );
        let mut objects = false;
        for (before, after) in text.lines().zip(converted.lines()) {
            if before.starts_with('[') {
                objects = before == "[HitObjects]";
            }
            let slider_or_spinner = objects
                && before
                    .split(',')
                    .nth(3)
                    .and_then(|k| k.parse::<i32>().ok())
                    .is_some_and(|k| k & 1 == 0 && k & 10 != 0);
            assert_eq!(before == after, !slider_or_spinner, "{chart}: {before}");
        }
    }
}
