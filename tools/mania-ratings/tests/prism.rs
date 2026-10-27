//! Differential test: the vendored Prism through our adapter against the
//! pristine upstream crates (tests/reference/prism/generate.py).
use serde_json::Value;
use vosu_mania_ratings::prism;

#[test]
fn matches_pristine_upstream_prism() {
    let reference: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/prism-reference.json")).unwrap();
    assert!(reference.iter().any(|r| r["supported"] == true));
    compare(&reference, |chart| {
        format!("{}/tests/fixtures/{chart}", env!("CARGO_MANIFEST_DIR"))
    });
}

/// Real charts: `generate.py --out FILE chart.osu ...`, then set
/// VOSU_PRISM_REFERENCE=FILE. Skipped when unset.
#[test]
fn matches_pristine_upstream_prism_on_listed_charts() {
    let Ok(file) = std::env::var("VOSU_PRISM_REFERENCE") else {
        return;
    };
    let reference: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    compare(&reference, str::to_owned);
    eprintln!("compared {} chart/rate results", reference.len());
}

fn compare(reference: &[Value], path_of: impl Fn(&str) -> String) {
    for r in reference {
        let path = path_of(r["chart"].as_str().unwrap());
        let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
        let keys = r["keys"].as_u64().unwrap() as u32;
        let rate = r["rate"].as_f64().unwrap() as f32;
        let ours = prism::rate(&text, rate);
        assert_eq!(ours.is_some(), r["supported"] == true, "{path} {rate}");
        assert_eq!(prism::supports(keys), r["supported"] == true);
        let Some(ours) = ours else { continue };
        let values = &r["values"];
        // Bit-exact: same source, same inputs.
        assert_eq!(
            ours.overall,
            values["Overall"].as_f64().unwrap(),
            "{path} {rate}"
        );
        for (name, value) in &ours.skillsets {
            assert_eq!(
                *value,
                values[name].as_f64().unwrap(),
                "{path} {rate} {name}"
            );
        }
        assert_eq!(ours.ln, r["ln"].as_f64(), "{path} {rate} LN");
        assert_eq!(
            u64::from(ours.centre_hand),
            r["centre_hand"].as_u64().unwrap()
        );
    }
}
