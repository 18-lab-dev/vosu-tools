use serde_json::Value;
use vosu_map_analysis::official;

#[test]
fn pinned_lazer_difficulty_parity() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/official-lazer.json")).unwrap();
    for row in fixture["rows"].as_array().unwrap() {
        let chart = row["chart"].as_str().unwrap();
        let bytes = std::fs::read(format!(
            "{}/tests/fixtures/demo/{chart}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let output = official::calculate(
            &bytes,
            row["mode"].as_str(),
            row["mods"].as_str().unwrap(),
            row["rate"].as_f64().unwrap(),
        )
        .unwrap();
        let expected = row["attributes"]["StarRating"].as_f64().unwrap();
        let actual = output["stars"].as_f64().unwrap();
        assert!(
            (expected - actual).abs() < 0.00001,
            "{chart} {}: expected {expected}, got {actual}",
            row["mods"]
        );
        let pairs: &[(&str, &str)] = match row["mode"].as_str().unwrap() {
            "osu" => &[
                ("Aim", "AimDifficulty"),
                ("Speed", "SpeedDifficulty"),
                ("Flashlight", "FlashlightDifficulty"),
                ("Slider factor", "SliderFactor"),
            ],
            "taiko" => &[
                ("Colour", "ColourDifficulty"),
                ("Rhythm", "RhythmDifficulty"),
                ("Stamina", "StaminaDifficulty"),
            ],
            _ => &[],
        };
        for (label, key) in pairs {
            let actual = output["skills"][label].as_f64().unwrap();
            let expected = row["attributes"][key].as_f64().unwrap();
            assert!(
                (expected - actual).abs() < 0.00001,
                "{chart} {label}: {expected} != {actual}"
            );
        }
    }
}
