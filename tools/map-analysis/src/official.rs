//! Official difficulty attributes. Community calculators deliberately stay outside this
//! engine: any future provider must identify its revision, licence, and ruleset.
use rosu_pp::{Beatmap, Difficulty, any::DifficultyAttributes, model::mode::GameMode};
use serde_json::{Value, json};

pub fn mode(value: &str) -> Result<GameMode, String> {
    match value {
        "0" | "osu" | "standard" => Ok(GameMode::Osu),
        "1" | "taiko" => Ok(GameMode::Taiko),
        "2" | "fruits" | "catch" => Ok(GameMode::Catch),
        "3" | "mania" => Ok(GameMode::Mania),
        _ => Err("unknown played ruleset".into()),
    }
}
pub fn mods(value: &str) -> Result<u32, String> {
    if let Ok(bits) = value.parse() {
        return Ok(bits);
    }
    let value = value.to_ascii_uppercase().replace(['+', ',', ' '], "");
    if value.is_empty() || value == "NM" {
        return Ok(0);
    }
    if !value.is_ascii() || !value.len().is_multiple_of(2) {
        return Err("expected two-letter mods".into());
    }
    let mut bits = 0;
    for pair in value.as_bytes().chunks_exact(2) {
        bits |= match pair {
            b"NF" => 1,
            b"EZ" => 2,
            b"TD" => 4,
            b"HD" => 8,
            b"HR" => 16,
            b"SD" => 32,
            b"DT" => 64,
            b"RX" => 128,
            b"HT" => 256,
            b"NC" => 576,
            b"FL" => 1024,
            b"SO" => 4096,
            b"AP" => 8192,
            b"PF" => 16416,
            b"V2" => 1 << 29,
            b"4K" => 1 << 15,
            b"5K" => 1 << 16,
            b"6K" => 1 << 17,
            b"7K" => 1 << 18,
            b"8K" => 1 << 19,
            b"9K" => 1 << 24,
            b"DS" => 1 << 25,
            b"1K" => 1 << 26,
            b"3K" => 1 << 27,
            b"2K" => 1 << 28,
            b"MR" => 1 << 30,
            _ => return Err(format!("unsupported mod {}", String::from_utf8_lossy(pair))),
        };
    }
    Ok(bits)
}
pub fn calculate(
    bytes: &[u8],
    played: Option<&str>,
    mods_text: &str,
    rate: f64,
) -> Result<Value, String> {
    if bytes.len() > crate::MAX_BYTES {
        return Err("beatmap exceeds 1 MiB".into());
    }
    if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
        return Err("rate must be between 0.5 and 2.0".into());
    }
    let mut map = Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?;
    let bits = mods(mods_text)?;
    let played = played.map(mode).transpose()?.unwrap_or(map.mode);
    map.convert_mut(played, &bits.into())
        .map_err(|e| e.to_string())?;
    let attributes = Difficulty::new()
        .mods(bits)
        .clock_rate(rate)
        .calculate(&map);
    let skills = match &attributes {
        DifficultyAttributes::Osu(a) => {
            json!({"Aim":a.aim,"Speed":a.speed,"Flashlight":a.flashlight,"Slider factor":a.slider_factor})
        }
        DifficultyAttributes::Taiko(a) => {
            json!({"Colour":a.color,"Rhythm":a.rhythm,"Stamina":a.stamina,"Reading":a.reading})
        }
        DifficultyAttributes::Catch(a) => {
            json!({"Fruits":a.n_fruits,"Droplets":a.n_droplets,"Tiny droplets":a.n_tiny_droplets,"Preempt / ms":a.preempt})
        }
        DifficultyAttributes::Mania(_) => json!({}),
    };
    let targets: Vec<Value> = [95.0, 98.0, 99.0, 100.0]
        .into_iter()
        .map(|accuracy| {
            let performance = rosu_pp::Performance::new(attributes.clone())
                .mods(bits)
                .clock_rate(rate)
                .lazer(true)
                .accuracy(accuracy)
                .calculate();
            json!({"accuracy":accuracy,"pp":performance.pp()})
        })
        .collect();
    Ok(
        json!({"stars":attributes.stars(),"skills":skills,"performance":{"targets":targets,"source":"rosu-pp 4.0.1 / lazer 2025-10-13"},"source":"rosu-pp 4.0.1 (osu!lazer 2025-10-13 algorithms; current lazer may differ)","mode":match played { GameMode::Osu=>"osu",GameMode::Taiko=>"taiko",GameMode::Catch=>"fruits",GameMode::Mania=>"mania" },"rate":rate,"mods":bits,"objects":map.hit_objects.len()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mod_parser_does_not_ignore_unknown_mods() {
        assert_eq!(mods("HDDT").unwrap(), 72);
        assert_eq!(mods("NC").unwrap(), 576);
        assert!(mods("XX").is_err());
    }
    #[test]
    fn official_attributes_cover_all_modes_and_rates() {
        for mode in 0..4 {
            let bytes = format!(
                "osu file format v14\n[General]\nMode:{mode}\n[Difficulty]\nCircleSize:4\nOverallDifficulty:7\nApproachRate:8\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:\n448,192,1100,1,2,0:0:0:0:\n128,192,1200,1,0,0:0:0:0:\n384,192,1300,1,2,0:0:0:0:\n"
            );
            for rate in [0.75, 1.0, 1.5] {
                let value = calculate(bytes.as_bytes(), None, "HD", rate).unwrap();
                assert!(value["stars"].as_f64().unwrap().is_finite());
                assert_eq!(value["rate"], rate);
            }
        }
    }
}
