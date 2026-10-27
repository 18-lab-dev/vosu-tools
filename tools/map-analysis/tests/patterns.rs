//! Differential test: our "Interlude patterns" port against Interlude's
//! unmodified F# (tests/reference/patterns/generate.py).
use serde_json::Value;
use vosu_map_analysis::patterns;

fn close(a: f64, b: f64, what: &str) {
    // f32 arithmetic in the same order; .NET and Rust `pow` may differ in the
    // last bits, which the strain weighting can amplify slightly.
    assert!(
        (a - b).abs() <= 1e-3_f64.max(b.abs() * 2e-4),
        "{what}: {a} != {b}"
    );
}

fn compare(reference: &[Value], path_of: impl Fn(&str) -> String) {
    assert!(!reference.is_empty());
    for r in reference {
        let chart = r["chart"].as_str().unwrap();
        let text = String::from_utf8_lossy(&std::fs::read(path_of(chart)).unwrap()).into_owned();
        if let Some(error) = r["error"].as_str() {
            // Interlude refuses the chart (e.g. a note inside a hold); so do we.
            assert!(
                patterns::convert(&text).is_err(),
                "{chart}: Interlude: {error}"
            );
            continue;
        }
        let rate = r["rate"].as_f64().unwrap() as f32;
        let parsed = patterns::convert(&text).unwrap();
        assert_eq!(
            parsed.rows.len() as u64,
            r["rows"].as_u64().unwrap(),
            "{chart} rows"
        );
        let ours = patterns::report(&parsed, rate);
        let what = format!("{chart} {rate}");
        assert_eq!(
            ours.category,
            r["category"].as_str().unwrap(),
            "{what} category"
        );
        close(
            f64::from(ours.ln_percent),
            r["ln_percent"].as_f64().unwrap(),
            &what,
        );
        close(
            f64::from(ours.duration),
            r["duration"].as_f64().unwrap(),
            &what,
        );
        for (a, b) in ours.density.iter().zip(r["density"].as_array().unwrap()) {
            close(
                f64::from(*a),
                b.as_f64().unwrap(),
                &format!("{what} density"),
            );
        }
        let clusters = r["clusters"].as_array().unwrap();
        assert_eq!(ours.clusters.len(), clusters.len(), "{what} clusters");
        for (c, e) in ours.clusters.iter().zip(clusters) {
            let w = format!("{what} {:?} {}", c.pattern, c.bpm);
            assert_eq!(
                format!("{:?}", c.pattern),
                e["pattern"].as_str().unwrap(),
                "{w}"
            );
            assert_eq!(i64::from(c.bpm), e["bpm"].as_i64().unwrap(), "{w}");
            assert_eq!(c.mixed, e["mixed"].as_bool().unwrap(), "{w}");
            close(
                f64::from(c.amount),
                e["amount"].as_f64().unwrap(),
                &format!("{w} amount"),
            );
            match (c.rating, e["rating"].as_f64()) {
                (Some(a), Some(b)) => close(f64::from(a), b, &format!("{w} rating")),
                (None, None) => {}
                (a, b) => panic!("{w} rating {a:?} != {b:?} ({})", e["rating"]),
            }
            for (a, b) in c.density.iter().zip(e["density"].as_array().unwrap()) {
                close(f64::from(*a), b.as_f64().unwrap(), &format!("{w} density"));
            }
            let specific = e["specific"].as_array().unwrap();
            assert_eq!(c.specific.len(), specific.len(), "{w} specific");
            for ((name, share), s) in c.specific.iter().zip(specific) {
                assert_eq!(name, s[0].as_str().unwrap(), "{w}");
                close(f64::from(*share), s[1].as_f64().unwrap(), &w);
            }
        }
    }
}

#[test]
fn matches_interlude_on_fixtures() {
    let reference: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/patterns-reference.json")).unwrap();
    let keys: std::collections::BTreeSet<u64> = reference
        .iter()
        .map(|r| r["keys"].as_u64().unwrap())
        .collect();
    assert_eq!(keys, (3..=10).collect());
    compare(&reference, |chart| {
        format!("{}/tests/fixtures/{chart}", env!("CARGO_MANIFEST_DIR"))
    });
}

/// Real charts: `generate.py --out FILE chart.osu ...`, then set
/// VOSU_PATTERNS_REFERENCE=FILE. Skipped when unset.
#[test]
fn matches_interlude_on_listed_charts() {
    let Ok(file) = std::env::var("VOSU_PATTERNS_REFERENCE") else {
        return;
    };
    let reference: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    compare(&reference, str::to_owned);
    eprintln!("compared {} chart/rate results", reference.len());
}

#[test]
fn key_counts_outside_interlude_are_refused() {
    for keys in [1, 2, 11, 18] {
        let text =
            format!("[Difficulty]\nCircleSize:{keys}\n[HitObjects]\n0,192,1000,1,0,0:0:0:0:\n");
        assert!(patterns::convert(&text).is_err());
        assert!(!patterns::supports(keys));
    }
}
