//! The documents a replay's overlay pages read, in vosu's wire shapes.
//!
//! The studio sends one partial vosu v2 document per frame (the fields a replay
//! can reproduce, see `web/src/telemetry.ts`); every other field keeps the
//! value vosu reports when it has nothing to say (the templates, taken from
//! vosu's own wire fixtures). The precise, gosu (v1) and StreamCompanion
//! documents are projections of that v2 document, as vosu derives them from
//! one state point.
use serde_json::{Value, json};
use std::sync::LazyLock;

static V2: LazyLock<Value> = LazyLock::new(|| template(include_str!("../overlay-api/v2.json")));
static PRECISE: LazyLock<Value> =
    LazyLock::new(|| template(include_str!("../overlay-api/precise.json")));
static V1: LazyLock<Value> = LazyLock::new(|| template(include_str!("../overlay-api/v1.json")));
static SC: LazyLock<Value> = LazyLock::new(|| template(include_str!("../overlay-api/sc.json")));

fn template(text: &str) -> Value {
    serde_json::from_str(text).expect("overlay API templates are valid JSON")
}

/// One state point in every shape the overlay routes serve.
pub struct Documents {
    pub sequence: u64,
    /// The state's render clock (milliseconds of output time).
    pub wall: f64,
    pub v2: Value,
    pub precise: Value,
    pub v1: Value,
    pub sc: Value,
}

impl Documents {
    /// The documents for `state` (a partial v2 document plus `__render`).
    pub fn new(state: &Value, sequence: u64) -> Self {
        let mut v2 = V2.clone();
        if let Value::Object(fields) = state {
            for (key, value) in fields {
                if key != "__render" {
                    merge(&mut v2, key, value);
                }
            }
        }
        let render = &state["__render"];
        let wall = render["wallMs"].as_f64().unwrap_or(0.0);
        let precise = precise(&v2, render);
        let v1 = v1(&v2);
        let sc = sc(&v2, render);
        Self {
            sequence,
            wall,
            v2,
            precise,
            v1,
            sc,
        }
    }
}

/// Writes `value` over `target[key]`, recursing into objects so fields the
/// partial document leaves out keep their template values.
fn merge(target: &mut Value, key: &str, value: &Value) {
    let Value::Object(target) = target else {
        return;
    };
    match (target.get_mut(key), value) {
        (Some(existing @ Value::Object(_)), Value::Object(fields)) => {
            for (key, value) in fields {
                merge(existing, key, value);
            }
        }
        _ => {
            target.insert(key.to_owned(), value.clone());
        }
    }
}

fn set(document: &mut Value, pointer: &str, value: Value) {
    if let Some(slot) = document.pointer_mut(pointer) {
        *slot = value;
    }
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

/// `/websocket/v2/precise`: keys and hit errors.
fn precise(v2: &Value, render: &Value) -> Value {
    let mut out = PRECISE.clone();
    set(&mut out, "/keys", v2["keys"].clone());
    set(&mut out, "/hitErrors", v2["play"]["hitErrorArray"].clone());
    for (key, field) in [
        ("pressHitErrors", "/pressHitErrors"),
        ("releaseHitErrors", "/releaseHitErrors"),
    ] {
        if render["precise"][key].is_array() {
            set(&mut out, field, render["precise"][key].clone());
        }
    }
    out
}

/// The legacy key overlay (`k1`, `k2`, `m1`, `m2`) as gosu and StreamCompanion name it.
fn key_overlay(v2: &Value) -> Value {
    let key = |name: &str| v2["keys"][name].clone();
    json!({"k1": key("k1"), "k2": key("k2"), "m1": key("m1"), "m2": key("m2")})
}

/// gosu's `/json` and `/ws` document.
fn v1(v2: &Value) -> Value {
    let mut out = V1.clone();
    let beatmap = &v2["beatmap"];
    let stats = &beatmap["stats"];
    let play = &v2["play"];
    let hits = &play["hits"];
    let mode = play["mode"]["number"].clone();
    set(&mut out, "/client", v2["client"].clone());
    set(&mut out, "/menu/state", v2["state"]["number"].clone());
    set(&mut out, "/menu/gameMode", mode.clone());
    set(
        &mut out,
        "/menu/bm/time",
        json!({
            "firstObj": beatmap["time"]["firstObject"],
            "current": beatmap["time"]["live"],
            "full": beatmap["time"]["lastObject"],
            "mp3": beatmap["time"]["mp3Length"],
        }),
    );
    set(&mut out, "/menu/bm/id", beatmap["id"].clone());
    set(&mut out, "/menu/bm/set", beatmap["set"].clone());
    set(&mut out, "/menu/bm/md5", beatmap["checksum"].clone());
    set(
        &mut out,
        "/menu/bm/metadata",
        json!({
            "artist": beatmap["artist"],
            "artistOriginal": beatmap["artistUnicode"],
            "title": beatmap["title"],
            "titleOriginal": beatmap["titleUnicode"],
            "mapper": beatmap["mapper"],
            "difficulty": beatmap["version"],
        }),
    );
    for (field, key) in [("AR", "ar"), ("CS", "cs"), ("OD", "od"), ("HP", "hp")] {
        set(
            &mut out,
            &format!("/menu/bm/stats/{field}"),
            stats[key]["converted"].clone(),
        );
        set(
            &mut out,
            &format!("/menu/bm/stats/memory{field}"),
            stats[key]["original"].clone(),
        );
    }
    set(
        &mut out,
        "/menu/bm/stats/SR",
        stats["stars"]["live"].clone(),
    );
    set(
        &mut out,
        "/menu/bm/stats/fullSR",
        stats["stars"]["total"].clone(),
    );
    set(&mut out, "/menu/bm/stats/BPM", stats["bpm"].clone());
    for key in ["circles", "sliders", "spinners", "holds"] {
        set(
            &mut out,
            &format!("/menu/bm/stats/{key}"),
            stats["objects"][key].clone(),
        );
    }
    set(
        &mut out,
        "/menu/bm/stats/maxCombo",
        stats["maxCombo"].clone(),
    );
    set(
        &mut out,
        "/menu/bm/path",
        json!({
            "full": v2["directPath"]["beatmapFile"],
            "folder": v2["folders"]["beatmap"],
            "file": v2["files"]["beatmap"],
            "bg": v2["files"]["background"],
            "audio": v2["files"]["audio"],
        }),
    );
    let mods = json!({"num": play["mods"]["number"], "str": play["mods"]["name"]});
    set(&mut out, "/menu/mods", mods.clone());
    set(&mut out, "/gameplay/gameMode", mode.clone());
    set(&mut out, "/gameplay/name", play["playerName"].clone());
    set(&mut out, "/gameplay/score", play["score"].clone());
    set(&mut out, "/gameplay/accuracy", play["accuracy"].clone());
    set(&mut out, "/gameplay/combo", play["combo"].clone());
    // gosu's health runs 0-200, v2's 0-100.
    set(
        &mut out,
        "/gameplay/hp",
        json!({
            "normal": number(&play["healthBar"]["normal"]) * 2.0,
            "smooth": number(&play["healthBar"]["smooth"]) * 2.0,
        }),
    );
    for key in [
        "0",
        "50",
        "100",
        "300",
        "geki",
        "katu",
        "sliderEndHits",
        "smallTickHits",
        "largeTickHits",
        "sliderBreaks",
    ] {
        set(
            &mut out,
            &format!("/gameplay/hits/{key}"),
            hits[key].clone(),
        );
    }
    set(&mut out, "/gameplay/hits/grade", play["rank"].clone());
    set(
        &mut out,
        "/gameplay/hits/unstableRate",
        play["unstableRate"].clone(),
    );
    set(
        &mut out,
        "/gameplay/hits/hitErrorArray",
        play["hitErrorArray"].clone(),
    );
    set(
        &mut out,
        "/gameplay/pp/current",
        play["pp"]["current"].clone(),
    );
    set(&mut out, "/gameplay/keyOverlay", key_overlay(v2));
    set(&mut out, "/resultsScreen/mode", mode);
    set(&mut out, "/resultsScreen/mods", mods);
    out
}

/// StreamCompanion's `/json/sc` and `/tokens` document.
fn sc(v2: &Value, render: &Value) -> Value {
    let mut out = SC.clone();
    let beatmap = &v2["beatmap"];
    let stats = &beatmap["stats"];
    let play = &v2["play"];
    let hits = &play["hits"];
    let text = |value: &Value| value.as_str().unwrap_or("").to_owned();
    let put = |out: &mut Value, key: &str, value: Value| {
        if let Value::Object(fields) = out
            && fields.contains_key(key)
        {
            fields.insert(key.to_owned(), value);
        }
    };
    put(
        &mut out,
        "isBreakTime",
        json!(i64::from(beatmap["isBreak"] == true)),
    );
    put(&mut out, "artistRoman", beatmap["artist"].clone());
    put(&mut out, "artistUnicode", beatmap["artistUnicode"].clone());
    put(&mut out, "titleRoman", beatmap["title"].clone());
    put(&mut out, "titleUnicode", beatmap["titleUnicode"].clone());
    put(
        &mut out,
        "mapArtistTitle",
        json!(format!(
            "{} - {}",
            text(&beatmap["artist"]),
            text(&beatmap["title"])
        )),
    );
    put(
        &mut out,
        "mapArtistTitleUnicode",
        json!(format!(
            "{} - {}",
            text(&beatmap["artistUnicode"]),
            text(&beatmap["titleUnicode"])
        )),
    );
    put(&mut out, "diffName", beatmap["version"].clone());
    put(
        &mut out,
        "mapDiff",
        json!(format!("[{}]", text(&beatmap["version"]))),
    );
    put(&mut out, "creator", beatmap["mapper"].clone());
    put(&mut out, "liveStarRating", stats["stars"]["live"].clone());
    put(&mut out, "mStars", stats["stars"]["total"].clone());
    for key in ["ar", "od", "cs", "hp"] {
        put(&mut out, key, stats[key]["original"].clone());
        put(
            &mut out,
            &format!("m{}", key.to_uppercase()),
            stats[key]["converted"].clone(),
        );
    }
    put(&mut out, "currentBpm", stats["bpm"]["realtime"].clone());
    put(&mut out, "bpm", stats["bpm"]["common"].clone());
    put(&mut out, "mainBpm", stats["bpm"]["common"].clone());
    put(&mut out, "maxBpm", stats["bpm"]["max"].clone());
    put(&mut out, "minBpm", stats["bpm"]["min"].clone());
    put(&mut out, "md5", beatmap["checksum"].clone());
    put(&mut out, "gameMode", play["mode"]["name"].clone());
    put(&mut out, "mode", play["mode"]["number"].clone());
    let live = number(&beatmap["time"]["live"]);
    put(&mut out, "time", json!(live / 1000.0));
    put(&mut out, "totaltime", beatmap["time"]["lastObject"].clone());
    put(
        &mut out,
        "totalAudioTime",
        beatmap["time"]["mp3Length"].clone(),
    );
    put(
        &mut out,
        "firstHitObjectTime",
        beatmap["time"]["firstObject"].clone(),
    );
    put(&mut out, "mapPosition", json!(clock(live)));
    put(
        &mut out,
        "timeLeft",
        json!(clock(number(&beatmap["time"]["lastObject"]) - live)),
    );
    put(&mut out, "mapid", beatmap["id"].clone());
    put(&mut out, "mapsetid", beatmap["set"].clone());
    for key in ["circles", "sliders", "spinners"] {
        put(&mut out, key, stats["objects"][key].clone());
    }
    put(&mut out, "maxCombo", stats["maxCombo"].clone());
    put(&mut out, "mp3Name", v2["files"]["audio"].clone());
    put(&mut out, "osuFileName", v2["files"]["beatmap"].clone());
    put(
        &mut out,
        "backgroundImageFileName",
        v2["files"]["background"].clone(),
    );
    put(
        &mut out,
        "osuFileLocation",
        v2["directPath"]["beatmapFile"].clone(),
    );
    put(
        &mut out,
        "backgroundImageLocation",
        v2["directPath"]["beatmapBackground"].clone(),
    );
    put(&mut out, "dir", v2["folders"]["beatmap"].clone());
    put(&mut out, "username", play["playerName"].clone());
    put(&mut out, "score", play["score"].clone());
    put(
        &mut out,
        "playerHp",
        json!(number(&play["healthBar"]["normal"]) * 2.0),
    );
    put(
        &mut out,
        "playerHpSmooth",
        json!(number(&play["healthBar"]["smooth"]) * 2.0),
    );
    put(&mut out, "combo", play["combo"]["current"].clone());
    put(&mut out, "currentMaxCombo", play["combo"]["max"].clone());
    let keys = &v2["keys"];
    let overlay = json!({
        "Enabled": true,
        "K1Pressed": keys["k1"]["isPressed"], "K1Count": keys["k1"]["count"],
        "K2Pressed": keys["k2"]["isPressed"], "K2Count": keys["k2"]["count"],
        "M1Pressed": keys["m1"]["isPressed"], "M1Count": keys["m1"]["count"],
        "M2Pressed": keys["m2"]["isPressed"], "M2Count": keys["m2"]["count"],
    });
    put(&mut out, "keyOverlay", json!(overlay.to_string()));
    for (key, field) in [
        ("geki", "geki"),
        ("c300", "300"),
        ("katsu", "katu"),
        ("c100", "100"),
        ("c50", "50"),
        ("miss", "0"),
        ("sliderBreaks", "sliderBreaks"),
    ] {
        put(&mut out, key, hits[field].clone());
    }
    put(&mut out, "acc", play["accuracy"].clone());
    put(&mut out, "unstableRate", play["unstableRate"].clone());
    put(&mut out, "hitErrors", play["hitErrorArray"].clone());
    put(&mut out, "mods", play["mods"]["name"].clone());
    put(&mut out, "modsEnum", play["mods"]["number"].clone());
    put(&mut out, "ppIfMapEndsNow", play["pp"]["current"].clone());
    put(&mut out, "skin", render["skin"].clone());
    put(&mut out, "tags", beatmap["tags"].clone());
    put(&mut out, "source", beatmap["source"].clone());
    out
}

/// StreamCompanion's `HH:MM:SS.t` clock.
fn clock(milliseconds: f64) -> String {
    let tenths = (milliseconds.max(0.0) / 100.0).floor() as u64;
    let seconds = tenths / 10;
    format!(
        "{:02}:{:02}:{:02}.{}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
        tenths % 10
    )
}

/// The values of `pointers` in `document`, as vosu's selected-field
/// subscription resolves them; `None` where a pointer names nothing.
pub fn select(document: &Value, pointers: &[Vec<String>]) -> Vec<Option<Value>> {
    pointers
        .iter()
        .map(|tokens| {
            let mut current = document;
            for token in tokens {
                current = match current {
                    Value::Object(object) => object.get(token)?,
                    Value::Array(array) => array.get(array_index(token)?)?,
                    _ => return None,
                };
            }
            Some(current.clone())
        })
        .collect()
}

fn array_index(token: &str) -> Option<usize> {
    if token == "0" {
        return Some(0);
    }
    if token.is_empty() || token.starts_with('0') || !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    token.parse().ok()
}

/// vosu's selection rules: 1-256 RFC 6901 pointers of at most 512 bytes and
/// 32 tokens, none equal to or containing another.
pub fn compile_pointers(pointers: Vec<String>) -> Result<Vec<Vec<String>>, (u16, &'static str)> {
    const INVALID_REQUEST: (u16, &str) = (1, "invalid subscription request");
    const INVALID_POINTER: (u16, &str) = (2, "invalid JSON Pointer");
    if !(1..=256).contains(&pointers.len()) || pointers.iter().any(|p| p.len() > 512) {
        return Err(INVALID_REQUEST);
    }
    let mut compiled: Vec<Vec<String>> = Vec::with_capacity(pointers.len());
    for pointer in pointers {
        let tokens = decode_pointer(&pointer).ok_or(INVALID_POINTER)?;
        if tokens.len() > 32 {
            return Err(INVALID_REQUEST);
        }
        let prefix = |a: &[String], b: &[String]| a.len() < b.len() && b.starts_with(a);
        if compiled.iter().any(|existing| {
            existing == &tokens || prefix(existing, &tokens) || prefix(&tokens, existing)
        }) {
            return Err(INVALID_POINTER);
        }
        compiled.push(tokens);
    }
    Ok(compiled)
}

fn decode_pointer(pointer: &str) -> Option<Vec<String>> {
    if pointer.is_empty() {
        return Some(Vec::new());
    }
    pointer
        .strip_prefix('/')?
        .split('/')
        .map(|token| {
            let mut decoded = String::with_capacity(token.len());
            let mut chars = token.chars();
            while let Some(ch) = chars.next() {
                if ch != '~' {
                    decoded.push(ch);
                    continue;
                }
                match chars.next()? {
                    '0' => decoded.push('~'),
                    '1' => decoded.push('/'),
                    _ => return None,
                }
            }
            Some(decoded)
        })
        .collect()
}

/// `[0,revision,[[index,value],...]]`: the present values.
pub fn initial_frame(revision: u64, values: &[Option<Value>]) -> String {
    let present: Vec<Value> = values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.as_ref().map(|value| json!([index, value])))
        .collect();
    json!([0, revision, present]).to_string()
}

/// `[1,revision,[[index,value],...],[index,...]]` for the values that changed
/// since `previous`, or `None` when nothing did.
pub fn update_frame(
    revision: u64,
    previous: &[Option<Value>],
    current: &[Option<Value>],
) -> Option<String> {
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    for (index, (before, now)) in previous.iter().zip(current).enumerate() {
        if before == now {
            continue;
        }
        match now {
            Some(value) => changed.push(json!([index, value])),
            None => removed.push(json!(index)),
        }
    }
    (!changed.is_empty() || !removed.is_empty())
        .then(|| json!([1, revision, changed, removed]).to_string())
}

/// `[2,code,message]`.
pub fn error_frame(code: u16, message: &str) -> String {
    json!([2, code, message]).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_states_keep_vosu_shapes() {
        let state = json!({
            "client": "stable",
            "beatmap": {"artist": "A", "title": "T", "version": "V", "time": {"live": 61500.0, "lastObject": 90000.0},
                "stats": {"hitWindow": {"great": 40.5}, "objects": {"holds": 3}}},
            "play": {"playerName": "p", "accuracy": 98.5, "healthBar": {"normal": 50.0, "smooth": 50.0},
                "hits": {"300": 7, "geki": 2}, "hitErrorArray": [1.0, -2.0], "mods": {"number": 64, "name": "DT"}},
            "keys": {"k1": {"isPressed": true, "count": 3}, "all": [{"name": "K1", "isPressed": true, "count": 3, "pressedAt": 1.0, "releasedAt": null}]},
            "__render": {"precise": {"pressHitErrors": [1.0], "releaseHitErrors": [-2.0]}},
        });
        let documents = Documents::new(&state, 4);
        // Template fields survive a partial merge; merged ones replace them.
        assert_eq!(documents.v2["beatmap"]["stats"]["objects"]["circles"], 0);
        assert_eq!(documents.v2["beatmap"]["stats"]["objects"]["holds"], 3);
        assert_eq!(documents.v2["beatmap"]["stats"]["hitWindow"]["great"], 40.5);
        assert_eq!(documents.v2["state"], json!({"number": 2, "name": "play"}));
        assert!(documents.v2.get("__render").is_none());
        assert!(documents.v2.get("tourney").is_none());
        assert_eq!(
            documents.v2["keys"]["m1"],
            json!({"isPressed": false, "count": 0})
        );
        assert_eq!(documents.precise["hitErrors"], json!([1.0, -2.0]));
        assert_eq!(documents.precise["pressHitErrors"], json!([1.0]));
        assert_eq!(documents.precise["keys"]["all"][0]["name"], "K1");
        assert_eq!(documents.v1["gameplay"]["hp"]["normal"], 100.0);
        assert_eq!(documents.v1["gameplay"]["hits"]["300"], 7);
        assert_eq!(documents.v1["menu"]["bm"]["metadata"]["difficulty"], "V");
        assert_eq!(documents.v1["gameplay"]["keyOverlay"]["k1"]["count"], 3);
        assert_eq!(documents.sc["mapArtistTitle"], "A - T");
        assert_eq!(documents.sc["time"], 61.5);
        assert_eq!(documents.sc["mapPosition"], "00:01:01.5");
        assert_eq!(documents.sc["timeLeft"], "00:00:28.5");
        assert_eq!(documents.sc["c300"], 7);
        assert!(
            documents.sc["keyOverlay"]
                .as_str()
                .unwrap()
                .contains("\"K1Count\":3")
        );
    }

    #[test]
    fn selections_follow_vosus_rules_and_frames() {
        assert!(compile_pointers(vec![]).is_err());
        assert_eq!(compile_pointers(vec!["x".into()]).unwrap_err().0, 2);
        assert_eq!(
            compile_pointers(vec!["/a".into(), "/a/b".into()])
                .unwrap_err()
                .0,
            2
        );
        assert_eq!(compile_pointers(vec!["/a~2".into()]).unwrap_err().0, 2);
        let pointers = compile_pointers(vec![
            "/a/b~1c".into(),
            "/list/1".into(),
            "/list/01".into(),
            "/gone".into(),
        ])
        .unwrap();
        assert_eq!(pointers[0], ["a", "b/c"]);
        let document = json!({"a": {"b/c": 5}, "list": [1, 2]});
        let values = select(&document, &pointers);
        assert_eq!(values, [Some(json!(5)), Some(json!(2)), None, None]);
        assert_eq!(initial_frame(3, &values), "[0,3,[[0,5],[1,2]]]");
        let next = select(&json!({"a": {"b/c": 6}, "gone": true}), &pointers);
        assert_eq!(
            update_frame(4, &values, &next).unwrap(),
            "[1,4,[[0,6],[3,true]],[1]]"
        );
        assert_eq!(update_frame(5, &next, &next), None);
        assert_eq!(
            error_frame(2, "invalid JSON Pointer"),
            "[2,2,\"invalid JSON Pointer\"]"
        );
        assert_eq!(
            compile_pointers(vec!["".into()]).unwrap(),
            [Vec::<String>::new()]
        );
    }
}
