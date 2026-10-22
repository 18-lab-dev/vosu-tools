use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Arc};

pub const AKATSUKI: &str = "c0e499ec3ac138c7cc329771fc70992de39fbb77";
pub const MAME: &str = "11f4c0443f8dd777a356cad1d06e675971ec0a4e";
pub fn servers() -> Value {
    json!({"servers": [
        {"id":"akatsuki", "version":AKATSUKI, "rulesets":["osu","taiko","fruits","mania"], "coverage":"Native rulesets; vanilla all modes, RX osu/taiko/catch, AP osu only. Stable scoring; ScoreV2 rejected.", "difference":"osu RX uses custom osu_2019; other scores use the fork's modern stable calculator.", "source":"https://github.com/osuAkatsuki/akatsuki-pp-rs", "callsite":"https://github.com/osuAkatsuki/performance-service/blob/2e89b9c9d4365e98e2b0d98ba506862db5e92c60/src/api/routes/calculate.rs", "deployment_verified":false},
        {"id":"mamestagram", "version":MAME, "rulesets":["osu","taiko","fruits","mania"], "coverage":"Public calculator snapshot, native rulesets, vanilla stable mods only; RX/AP/ScoreV2 rejected (server policies unverified).", "difference":"Fork of 2024 rosu-pp; not the current official engine. Exact numeric difference is map dependent.", "source":"https://github.com/Mamestagram/mamestagram-pp-rs", "deployment_verified":false}
    ], "warning":"Reproducible public source snapshots, NOT a guarantee of current server deployment or ranking eligibility.", "unsupported":[
        {"id":"ripple","reason":"Documented custom std RX formula but no identifiable current implementation/revision; classic taiko/catch version unpinned."},
        {"id":"gatari","reason":"Current calculator implementation/revision not verifiable."},
        {"id":"kurikku","reason":"Current calculator implementation/revision not verifiable."},
        {"id":"titanic","reason":"Current ppv1 formula and deployment revision not verifiable."},
        {"id":"bancho.py","reason":"Server framework, not an identifiable deployed calculator; fork-specific."}
    ]})
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Input {
    pub server: String,
    pub checksum: Option<String>,
    #[serde(default)]
    pub mods: String,
    pub acc: Option<f64>,
    pub combo: Option<u32>,
    #[serde(default)]
    pub misses: u32,
    pub n300: Option<u32>,
    pub n100: Option<u32>,
    pub n50: Option<u32>,
    pub n_geki: Option<u32>,
    pub n_katu: Option<u32>,
    pub passed_objects: Option<u32>,
}

pub fn mods(text: &str) -> Result<u32, String> {
    if let Ok(bits) = text.parse::<u32>() {
        return Ok(bits);
    }
    let text = text.to_ascii_uppercase().replace(['+', ',', ' '], "");
    if text.is_empty() || text == "NM" {
        return Ok(0);
    }
    if !text.is_ascii() || !text.len().is_multiple_of(2) {
        return Err("mods must be legacy bits or two-letter acronyms".into());
    }
    let mut bits = 0;
    for pair in text.as_bytes().chunks_exact(2) {
        bits |= match pair {
            b"NF" => 1,
            b"EZ" => 2,
            b"HD" => 8,
            b"HR" => 16,
            b"SD" => 32,
            b"DT" => 64,
            b"RX" => 128,
            b"HT" => 256,
            b"NC" => 512 | 64,
            b"FL" => 1024,
            b"AP" => 8192,
            b"PF" => 16384 | 32,
            b"SO" => 4096,
            b"V2" => 1 << 29,
            _ => return Err(format!("unsupported mod {}", String::from_utf8_lossy(pair))),
        };
    }
    Ok(bits)
}

#[derive(Clone)]
pub struct Map {
    pub checksum: String,
    pub bytes: Arc<[u8]>,
    pub akatsuki: akatsuki::Beatmap,
    pub mame: mamestagram::Beatmap,
}
impl Map {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 1024 * 1024 || !bytes.starts_with(b"osu file format v") {
            return Err("expected an .osu file (maximum 1 MiB)".into());
        }
        Ok(Self {
            checksum: format!("{:x}", md5::compute(bytes)),
            bytes: bytes.into(),
            akatsuki: akatsuki::Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?,
            mame: mamestagram::Beatmap::from_bytes(bytes).map_err(|e| e.to_string())?,
        })
    }
}

// LRU map reuse is explicitly partitioned by server/checksum/mods. No score is cached.
#[derive(Default)]
pub struct Cache(VecDeque<((String, String, u32), Arc<Map>)>);
impl Cache {
    pub fn get(&mut self, server: &str, checksum: &str, mods: u32) -> Option<Arc<Map>> {
        let i = self
            .0
            .iter()
            .position(|(k, _)| k.0 == server && k.1 == checksum && k.2 == mods)?;
        let entry = self.0.remove(i)?;
        let map = entry.1.clone();
        self.0.push_back(entry);
        Some(map)
    }
    pub fn insert(&mut self, server: &str, mods: u32, map: Arc<Map>) {
        self.0
            .retain(|(k, _)| !(k.0 == server && k.1 == map.checksum && k.2 == mods));
        self.0
            .push_back(((server.into(), map.checksum.clone(), mods), map));
        if self.0.len() > 32 {
            self.0.pop_front();
        }
    }
}

pub fn calculate(map: &Map, input: &Input) -> Result<Value, String> {
    let bits = mods(&input.mods)?;
    let mode = map.akatsuki.mode as u8;
    let counts = match mode {
        0 | 1 => [
            input.n300,
            input.n100,
            input.n50,
            None,
            None,
            Some(input.misses),
        ],
        _ => [
            input.n300,
            input.n100,
            input.n50,
            input.n_geki,
            input.n_katu,
            Some(input.misses),
        ],
    };
    let total = counts
        .into_iter()
        .flatten()
        .try_fold(0u32, |a, b| a.checked_add(b))
        .ok_or("judgement count overflow")?;
    let objects = input
        .passed_objects
        .unwrap_or(map.akatsuki.hit_objects.len() as u32);
    if mode != 2 && total > objects {
        return Err("judgement counts exceed passed objects".into());
    }
    let allowed = 1 | 2 | 8 | 16 | 32 | 64 | 128 | 256 | 512 | 1024 | 4096 | 8192 | 16384;
    if bits & !allowed != 0 {
        return Err("ScoreV2, automation, key overrides and unknown mods are not verified for these server profiles".into());
    }
    if bits & 64 != 0 && bits & 256 != 0
        || bits & 2 != 0 && bits & 16 != 0
        || bits & 128 != 0 && bits & 8192 != 0
    {
        return Err("incompatible mods".into());
    }
    if bits & 8192 != 0 && mode != 0
        || bits & 128 != 0 && mode == 3
        || input.server == "mamestagram" && bits & (128 | 8192) != 0
    {
        return Err("RX/AP not verified for this server/ruleset".into());
    }
    if let Some(acc) = input.acc {
        if !acc.is_finite() || !(0.0..=100.0).contains(&acc) {
            return Err("accuracy must be 0..100".into());
        }
        if [
            input.n300,
            input.n100,
            input.n50,
            input.n_geki,
            input.n_katu,
        ]
        .iter()
        .any(Option::is_some)
        {
            return Err("supply accuracy OR judgements, not both".into());
        }
    }
    let mut fc = input.clone();
    fc.misses = 0;
    fc.combo = None;
    fc.passed_objects = None;
    // Full-map projection preserves achieved accuracy, rather than filling future objects with 300s.
    if input.acc.is_none() {
        let n300 = input.n300.unwrap_or(0) as f64;
        let n100 = input.n100.unwrap_or(0) as f64;
        let n50 = input.n50.unwrap_or(0) as f64;
        let geki = input.n_geki.unwrap_or(0) as f64;
        let katu = input.n_katu.unwrap_or(0) as f64;
        let misses = input.misses as f64;
        let (num, den) = match mode {
            0 => (
                300.0 * n300 + 100.0 * n100 + 50.0 * n50,
                300.0 * (n300 + n100 + n50 + misses),
            ),
            1 => (2.0 * n300 + n100, 2.0 * (n300 + n100 + misses)),
            2 => (n300 + n100 + n50, n300 + n100 + n50 + katu + misses),
            _ => (
                300.0 * (geki + n300) + 200.0 * katu + 100.0 * n100 + 50.0 * n50,
                300.0 * (geki + n300 + katu + n100 + n50 + misses),
            ),
        };
        fc.acc = Some(if den > 0.0 { 100.0 * num / den } else { 100.0 });
        fc.n300 = None;
        fc.n100 = None;
        fc.n50 = None;
        fc.n_geki = None;
        fc.n_katu = None;
    }
    let (current, stars) = raw(map, input, bits)?;
    let (if_fc, _) = raw(map, &fc, bits)?;
    if !current.is_finite() || !if_fc.is_finite() {
        return Err("calculator returned a non-finite result".into());
    }
    Ok(
        json!({"server":input.server,"version":match input.server.as_str(){"akatsuki"=>AKATSUKI,_=>MAME},"checksum":map.checksum,"mode":mode,"mods":bits,"current":current,"if_fc":if_fc,"stars":stars,"projection":"full map at achieved accuracy with zero misses and maximum combo","deployment_verified":false}),
    )
}

fn raw(map: &Map, i: &Input, bits: u32) -> Result<(f64, f64), String> {
    match i.server.as_str() {
        "akatsuki" if bits & 128 != 0 && map.akatsuki.mode as u8 == 0 => {
            let objects = i
                .passed_objects
                .unwrap_or(map.akatsuki.hit_objects.len() as u32)
                .min(map.akatsuki.hit_objects.len() as u32);
            let remaining = objects
                .checked_sub(i.misses)
                .ok_or("miss count exceeds passed objects")?;
            if let Some(acc) = i.acc {
                let target = (acc as f32 / 100.0 * objects as f32 * 6.0).round() as u32;
                let delta = target.checked_sub(remaining).ok_or(
                    "pinned RX calculator cannot represent this accuracy; supply judgements",
                )?;
                if delta / 5 + delta % 5 > remaining {
                    return Err("pinned RX calculator cannot represent this accuracy/miss combination; supply judgements".into());
                }
            }
            let mut p = akatsuki::osu_2019::OsuPP::from_map(&map.akatsuki)
                .mods(bits)
                .misses(i.misses);
            if let Some(v) = i.combo {
                p = p.combo(v)
            }
            if let Some(v) = i.passed_objects {
                p = p.passed_objects(v)
            }
            if let Some(v) = i.acc {
                p = p.accuracy(v as f32)
            } else {
                if let Some(v) = i.n300 {
                    p = p.n300(v)
                }
                if let Some(v) = i.n100 {
                    p = p.n100(v)
                }
                if let Some(v) = i.n50 {
                    p = p.n50(v)
                }
            }
            let r = p.calculate();
            Ok((r.pp, r.difficulty.stars))
        }
        "akatsuki" => {
            let mut p = map
                .akatsuki
                .performance()
                .mods(bits)
                .lazer(false)
                .misses(i.misses);
            if let Some(v) = i.combo {
                p = p.combo(v)
            }
            if let Some(v) = i.passed_objects {
                p = p.passed_objects(v)
            }
            if let Some(v) = i.acc {
                p = p.accuracy(v)
            } else {
                if let Some(v) = i.n300 {
                    p = p.n300(v)
                }
                if let Some(v) = i.n100 {
                    p = p.n100(v)
                }
                if let Some(v) = i.n50 {
                    p = p.n50(v)
                }
                if let Some(v) = i.n_geki {
                    p = p.n_geki(v)
                }
                if let Some(v) = i.n_katu {
                    p = p.n_katu(v)
                }
            }
            let r = p.calculate();
            Ok((r.pp(), r.stars()))
        }
        "mamestagram" => {
            let mut p = map
                .mame
                .performance()
                .mods(bits)
                .lazer(false)
                .misses(i.misses);
            if let Some(v) = i.combo {
                p = p.combo(v)
            }
            if let Some(v) = i.passed_objects {
                p = p.passed_objects(v)
            }
            if let Some(v) = i.acc {
                p = p.accuracy(v)
            } else {
                if let Some(v) = i.n300 {
                    p = p.n300(v)
                }
                if let Some(v) = i.n100 {
                    p = p.n100(v)
                }
                if let Some(v) = i.n50 {
                    p = p.n50(v)
                }
                if let Some(v) = i.n_geki {
                    p = p.n_geki(v)
                }
                if let Some(v) = i.n_katu {
                    p = p.n_katu(v)
                }
            }
            let r = p.calculate();
            Ok((r.pp(), r.stars()))
        }
        _ => Err("unsupported server; GET /v1/servers lists reasons".into()),
    }
}
