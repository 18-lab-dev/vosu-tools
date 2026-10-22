use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Source {
    pub name: String,
    pub base: String,
    pub enabled: bool,
    pub priority: u8,
    pub interval_ms: u64,
    pub terms_url: String,
    pub automation_permitted: bool,
}
impl Default for Source {
    fn default() -> Self {
        Self {
            name: "osu.direct".into(),
            base: "https://osu.direct".into(),
            enabled: true,
            priority: 0,
            interval_ms: 2000,
            terms_url: "https://osu.direct/tos".into(),
            automation_permitted: true,
        }
    }
}
/// Effective tool settings from vosu (`settings.json`, edited in the dashboard).
/// `client_secret` is a password setting: vosu returns it only to this service.
#[derive(Clone)]
pub struct Config {
    pub sources: Vec<Source>,
    pub concurrency: usize,
    pub max_file_mb: u64,
    pub no_video: bool,
    pub hide_owned: bool,
    pub follow_current_map: bool,
    pub songs_dir: String,
    pub client_id: String,
    pub client_secret: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            sources: vec![Source::default()],
            concurrency: 1,
            max_file_mb: 64,
            no_video: true,
            hide_owned: true,
            follow_current_map: true,
            songs_dir: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
        }
    }
}
#[derive(Deserialize)]
#[serde(default)]
struct RawConfig {
    sources: serde_json::Value,
    concurrency: serde_json::Value,
    max_file_mb: serde_json::Value,
    no_video: bool,
    hide_owned: bool,
    follow_current_map: bool,
    songs_dir: String,
    client_id: serde_json::Value,
    client_secret: String,
}
impl Default for RawConfig {
    fn default() -> Self {
        let d = Config::default();
        Self {
            sources: serde_json::to_value(&d.sources).unwrap(),
            concurrency: d.concurrency.into(),
            max_file_mb: d.max_file_mb.into(),
            no_video: d.no_video,
            hide_owned: d.hide_owned,
            follow_current_map: d.follow_current_map,
            songs_dir: d.songs_dir,
            client_id: d.client_id.into(),
            client_secret: d.client_secret,
        }
    }
}
fn whole(v: &serde_json::Value, name: &str, min: u64, max: u64) -> Result<u64, String> {
    let n = match v {
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        v => v.as_f64(),
    };
    n.filter(|n| n.fract() == 0.0 && *n >= min as f64 && *n <= max as f64)
        .map(|n| n as u64)
        .ok_or_else(|| format!("{name} must be a whole number from {min} to {max}"))
}
impl Config {
    /// Parses `GET /tools/_host/v1/settings`. `sources` is the JSON text of
    /// the "Mirror sources" textarea (an array is accepted too).
    pub fn from_settings(v: serde_json::Value) -> Result<Self, String> {
        let raw: RawConfig =
            serde_json::from_value(v).map_err(|e| format!("invalid tool settings: {e}"))?;
        let sources = match raw.sources {
            serde_json::Value::String(s) if s.trim().is_empty() => Vec::new(),
            serde_json::Value::String(s) => serde_json::from_str(&s)
                .map_err(|e| format!("Mirror sources is not valid JSON: {e}"))?,
            v => serde_json::from_value(v)
                .map_err(|e| format!("Mirror sources has an invalid shape: {e}"))?,
        };
        let client_id = match raw.client_id {
            serde_json::Value::Number(n) => match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f > 0.0 => format!("{f:.0}"),
                _ => n.to_string(),
            },
            serde_json::Value::String(s) => s.trim().to_owned(),
            _ => String::new(),
        };
        let config = Self {
            sources,
            concurrency: whole(&raw.concurrency, "Concurrent downloads", 1, 3)? as usize,
            max_file_mb: whole(&raw.max_file_mb, "Maximum archive size", 1, 128)?,
            no_video: raw.no_video,
            hide_owned: raw.hide_owned,
            follow_current_map: raw.follow_current_map,
            songs_dir: raw.songs_dir.trim().to_owned(),
            client_id,
            client_secret: raw.client_secret,
        };
        config.validate()?;
        Ok(config)
    }
    pub fn credentials(&self) -> bool {
        !self.client_id.is_empty() && !self.client_secret.is_empty()
    }
    /// Everything the browser may see: never the credentials themselves.
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "sources": self.sources,
            "concurrency": self.concurrency,
            "max_file_mb": self.max_file_mb,
            "no_video": self.no_video,
            "hide_owned": self.hide_owned,
            "follow_current_map": self.follow_current_map,
            "songs_dir": self.songs_dir,
            "credentials_configured": self.credentials(),
        })
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.sources.len() > 8 {
            return Err("at most 8 mirror sources".into());
        }
        if !self.client_id.is_empty() && !self.client_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err("osu! API client ID must be numeric".into());
        }
        for s in &self.sources {
            let u = reqwest::Url::parse(&s.base).map_err(|_| "invalid source URL")?;
            if u.scheme() != "https"
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || u.query().is_some()
                || u.fragment().is_some()
            {
                return Err("mirror requires a plain HTTPS origin".into());
            }
            if u.path() != "/" || s.interval_ms < 2000 || s.interval_ms > 60_000 {
                return Err("source must be an origin; pacing must be 2000–60000 ms".into());
            }
            if s.enabled && (!s.automation_permitted || !s.terms_url.starts_with("https://")) {
                return Err("enable only sources whose terms permit automation".into());
            }
        }
        Ok(())
    }
    pub fn source(&self, name: Option<&str>) -> Result<Source, String> {
        self.sources
            .iter()
            .filter(|s| s.enabled && s.automation_permitted && name.is_none_or(|n| n == s.name))
            .min_by_key(|s| s.priority)
            .cloned()
            .ok_or("no enabled source (there is no automatic failover)".into())
    }
}
/// Saved searches and filter presets: page workspace kept by the service.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Workspace {
    pub saved_searches: BTreeMap<String, Search>,
    pub presets: BTreeMap<String, Search>,
}
impl Workspace {
    pub fn validate(&self) -> Result<(), String> {
        if self.saved_searches.len() > 100 || self.presets.len() > 100 {
            return Err("at most 100 saved searches and 100 presets".into());
        }
        if self
            .saved_searches
            .keys()
            .chain(self.presets.keys())
            .any(|k| k.trim().is_empty() || k.chars().count() > 80)
        {
            return Err("names must be 1–80 characters".into());
        }
        for q in self.saved_searches.values().chain(self.presets.values()) {
            q.validate()?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Search {
    pub provider: String,
    pub discovery: String,
    pub query: String,
    pub mapper: String,
    pub mode: Option<u8>,
    pub status: String,
    pub min_stars: Option<f64>,
    pub max_stars: Option<f64>,
    pub min_bpm: Option<f64>,
    pub max_bpm: Option<f64>,
    pub min_length: Option<f64>,
    pub max_length: Option<f64>,
    pub after: String,
    pub before: String,
    pub hide_owned: bool,
    pub limit: usize,
    pub offset: usize,
    pub cursor: String,
    pub ids: String,
    pub pack: String,
}
impl Default for Search {
    fn default() -> Self {
        Self {
            provider: "mirror".into(),
            discovery: "search".into(),
            query: String::new(),
            mapper: String::new(),
            mode: None,
            status: "any".into(),
            min_stars: None,
            max_stars: None,
            min_bpm: None,
            max_bpm: None,
            min_length: None,
            max_length: None,
            after: String::new(),
            before: String::new(),
            hide_owned: true,
            limit: 20,
            offset: 0,
            cursor: String::new(),
            ids: String::new(),
            pack: String::new(),
        }
    }
}
impl Search {
    pub fn validate(&self) -> Result<(), String> {
        if self.limit == 0
            || self.limit > 50
            || self.offset > 10_000
            || self.mode.is_some_and(|m| m > 3)
            || self.query.len() > 512
            || self.mapper.len() > 128
            || self.ids.len() > 4096
        {
            return Err("invalid search limits".into());
        }
        for (a, b) in [
            (self.min_stars, self.max_stars),
            (self.min_bpm, self.max_bpm),
            (self.min_length, self.max_length),
        ] {
            if a.into_iter()
                .chain(b)
                .any(|n| !n.is_finite() || !(0.0..=100000.0).contains(&n))
                || a.zip(b).is_some_and(|(a, b)| a > b)
            {
                return Err("invalid numeric filter range".into());
            }
        }
        for d in [&self.after, &self.before] {
            if !d.is_empty()
                && (d.len() != 10
                    || !d.chars().enumerate().all(|(i, c)| {
                        if i == 4 || i == 7 {
                            c == '-'
                        } else {
                            c.is_ascii_digit()
                        }
                    }))
            {
                return Err("date must be YYYY-MM-DD".into());
            }
        }
        if ![
            "any",
            "ranked",
            "approved",
            "qualified",
            "loved",
            "pending",
            "wip",
            "graveyard",
        ]
        .contains(&self.status.as_str())
        {
            return Err("invalid ranked status".into());
        }
        Ok(())
    }
    pub fn official_params(&self) -> Vec<(String, String)> {
        let mut q = self.query.clone();
        if !self.mapper.is_empty() {
            q.push_str(&format!(
                " creator=\"{}\"",
                self.mapper.replace(['"', '\\'], "")
            ));
        }
        for (key, min, max) in [
            ("stars", self.min_stars, self.max_stars),
            ("bpm", self.min_bpm, self.max_bpm),
            ("length", self.min_length, self.max_length),
        ] {
            if let Some(n) = min {
                q.push_str(&format!(" {key}>={n}"));
            }
            if let Some(n) = max {
                q.push_str(&format!(" {key}<={n}"));
            }
        }
        if !self.after.is_empty() {
            q.push_str(&format!(" created>={}", self.after));
        }
        if !self.before.is_empty() {
            q.push_str(&format!(" created<={}", self.before));
        }
        let mut p = vec![
            ("q".into(), q.trim().into()),
            ("s".into(), self.status.clone()),
        ];
        if let Some(m) = self.mode {
            p.push(("m".into(), m.to_string()));
        }
        if !self.cursor.is_empty() {
            p.push(("cursor_string".into(), self.cursor.clone()));
        }
        p
    }
    pub fn matches(&self, s: &Mapset) -> bool {
        if !self.mapper.is_empty() && !s.creator.eq_ignore_ascii_case(&self.mapper) {
            return false;
        }
        if self.status != "any" && self.status != s.status {
            return false;
        }
        if !self.after.is_empty()
            && s.submitted_date
                .get(..10)
                .is_none_or(|d| d < self.after.as_str())
        {
            return false;
        }
        if !self.before.is_empty()
            && s.submitted_date
                .get(..10)
                .is_none_or(|d| d > self.before.as_str())
        {
            return false;
        }
        s.beatmaps.iter().any(|m| {
            self.mode.is_none_or(|n| n == m.mode_int)
                && range(m.difficulty_rating, self.min_stars, self.max_stars)
                && range(m.bpm.or(s.bpm).unwrap_or(-1.0), self.min_bpm, self.max_bpm)
                && range(m.total_length as f64, self.min_length, self.max_length)
        })
    }
}
fn range(n: f64, min: Option<f64>, max: Option<f64>) -> bool {
    min.is_none_or(|v| n >= v) && max.is_none_or(|v| n <= v)
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Difficulty {
    pub id: u32,
    pub checksum: Option<String>,
    pub version: String,
    pub mode_int: u8,
    pub difficulty_rating: f64,
    pub total_length: u32,
    pub bpm: Option<f64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Mapset {
    pub id: u32,
    pub artist: String,
    pub title: String,
    pub creator: String,
    pub status: String,
    pub submitted_date: String,
    pub bpm: Option<f64>,
    pub beatmaps: Vec<Difficulty>,
    /// Present in the local stable/lazer library snapshot.
    pub owned: bool,
    /// Completed by this tool's queue (validated archive on disk).
    pub downloaded: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Id {
    Set(u32),
    Map(u32),
    /// A difficulty's `.osu` MD5, e.g. from a replay.
    Md5(String),
}
pub fn parse_ids(input: &str) -> Result<Vec<Id>, String> {
    let mut out = Vec::new();
    for part in input
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
    {
        if part.len() == 32 && part.bytes().all(|b| b.is_ascii_hexdigit()) {
            let id = Id::Md5(part.to_ascii_lowercase());
            if !out.contains(&id) {
                out.push(id);
            }
            if out.len() > 50 {
                return Err("at most 50 IDs per search".into());
            }
            continue;
        }
        let (map, n) = if part.chars().all(|c| c.is_ascii_digit()) {
            (false, part.to_owned())
        } else {
            let u = reqwest::Url::parse(part).map_err(|_| "invalid ID or osu! link")?;
            if u.scheme() != "https" || u.host_str() != Some("osu.ppy.sh") {
                return Err("only https://osu.ppy.sh links are accepted".into());
            }
            let seg = u.path_segments().ok_or("invalid link")?.collect::<Vec<_>>();
            match seg.as_slice() {
                ["beatmapsets" | "s", id] => (false, (*id).into()),
                ["beatmaps" | "b", id] => (true, (*id).into()),
                _ => return Err("unsupported osu! link".into()),
            }
        };
        let id = n
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or("invalid positive ID")?;
        let id = if map { Id::Map(id) } else { Id::Set(id) };
        if !out.contains(&id) {
            out.push(id);
        }
        if out.len() > 50 {
            return Err("at most 50 IDs per search".into());
        }
    }
    if out.is_empty() {
        return Err("enter at least one ID".into());
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_building() {
        let s = Search {
            mapper: "a\"b".into(),
            mode: Some(3),
            min_stars: Some(4.0),
            max_length: Some(120.0),
            ..Search::default()
        };
        let p = s.official_params();
        assert_eq!(p[0].1, "creator=\"ab\" stars>=4 length<=120");
        assert!(p.contains(&("m".into(), "3".into())));
    }
    #[test]
    fn id_links() {
        assert_eq!(
            parse_ids("42 https://osu.ppy.sh/beatmapsets/42#mania/5 https://osu.ppy.sh/b/5")
                .unwrap(),
            vec![Id::Set(42), Id::Map(5)]
        );
        assert!(parse_ids("https://evil.com/42").is_err());
        assert!(parse_ids("0").is_err());
    }
    #[test]
    fn md5_ids() {
        let h = "0123456789ABCDEF0123456789abcdef";
        assert_eq!(
            parse_ids(&format!("{h} 7")).unwrap(),
            vec![Id::Md5(h.to_ascii_lowercase()), Id::Set(7)]
        );
    }
    #[test]
    fn host_settings() {
        let settings: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json"))
                .unwrap(),
        )
        .unwrap();
        let defaults = settings
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["type"] != "header")
            .map(|s| {
                (
                    s["uniqueID"].as_str().unwrap().to_owned(),
                    s["value"].clone(),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let c = Config::from_settings(defaults.clone().into()).unwrap();
        assert_eq!(c.sources.len(), 1);
        assert_eq!(c.sources[0].name, "osu.direct");
        assert_eq!((c.concurrency, c.max_file_mb), (1, 64));
        assert!(c.no_video && c.hide_owned && c.follow_current_map && !c.credentials());
        let mut v = defaults.clone();
        v.insert("client_id".into(), 1234.0.into());
        v.insert("client_secret".into(), "s3cret".into());
        let c = Config::from_settings(v.into()).unwrap();
        assert!(c.credentials());
        assert!(!c.public().to_string().contains("s3cret"));
        let mut v = defaults.clone();
        v.insert("concurrency".into(), 4.into());
        assert!(Config::from_settings(v.into()).is_err());
        let mut v = defaults;
        v.insert("sources".into(), "[{".into());
        // Config deliberately has no Debug impl: it carries the client secret.
        assert!(matches!(
            Config::from_settings(v.into()),
            Err(e) if e.contains("not valid JSON")
        ));
    }
    #[test]
    fn local_filters() {
        let s = Search {
            min_stars: Some(4.0),
            mode: Some(3),
            ..Search::default()
        };
        let mut m = Mapset {
            beatmaps: vec![Difficulty {
                mode_int: 3,
                difficulty_rating: 5.0,
                ..Difficulty::default()
            }],
            ..Mapset::default()
        };
        assert!(s.matches(&m));
        m.beatmaps[0].mode_int = 0;
        assert!(!s.matches(&m));
    }
}
