// MIT OR Apache-2.0. Reference driver: runs the pristine upstream Prism crates
// (fetched by generate.py at the pinned revision) on one chart and prints JSON.
use prism::{analyze_prism, analyze_prism_ln, chart_notes, PrismOptions};

fn main() {
    let path = std::env::args().nth(1).expect("chart path");
    let bytes = std::fs::read(&path).expect("chart");
    let text = String::from_utf8_lossy(&bytes);
    let map = chart_parser::parse_mania_beatmap(&text);
    let notes = chart_notes(&map);
    for rate in [1.0_f64, 1.5] {
        let options = PrismOptions { rate: Some(rate), ..Default::default() };
        let Some(press) = analyze_prism(&notes, map.key_count, map.od, &options) else {
            println!("{{\"keys\":{},\"rate\":{rate},\"supported\":false}}", map.key_count);
            continue;
        };
        let ln = if notes.iter().any(|n| n.is_hold) {
            analyze_prism_ln(&notes, map.key_count, map.od, &options)
        } else {
            None
        };
        let values: Vec<String> = press.values.iter().map(|(k, v)| format!("\"{k}\":{v:?}")).collect();
        println!(
            "{{\"keys\":{},\"rate\":{rate},\"supported\":true,\"centre_hand\":{},\"ln\":{},\"values\":{{{}}}}}",
            map.key_count,
            press.centre_hand,
            ln.map_or("null".to_string(), |v| format!("{v:?}")),
            values.join(",")
        );
    }
}
