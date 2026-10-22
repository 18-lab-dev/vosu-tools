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
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub sources: Vec<Source>,
    pub concurrency: usize,
    pub max_file_mb: u64,
    pub saved_searches: BTreeMap<String, Search>,
    pub presets: BTreeMap<String, Search>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub client_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub client_secret: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            sources: vec![Source::default()],
            concurrency: 1,
            max_file_mb: 64,
            saved_searches: BTreeMap::new(),
            presets: BTreeMap::new(),
            client_id: String::new(),
            client_secret: String::new(),
        }
    }
}
impl Settings {
    pub fn public(&self) -> serde_json::Value {
        let mut s = self.clone();
        s.client_id.clear();
        s.client_secret.clear();
        let mut v = serde_json::to_value(s).unwrap();
        v["credentials_configured"] =
            (!self.client_id.is_empty() && !self.client_secret.is_empty()).into();
        v
    }
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=3).contains(&self.concurrency) || !(1..=128).contains(&self.max_file_mb) {
            return Err("concurrency must be 1–3; file cap 1–128 MiB".into());
        }
        if self.sources.len() > 8 || self.saved_searches.len() > 100 || self.presets.len() > 100 {
            return Err("settings limit exceeded".into());
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
    pub owned: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Id {
    Set(u32),
    Map(u32),
}
pub fn parse_ids(input: &str) -> Result<Vec<Id>, String> {
    let mut out = Vec::new();
    for part in input
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
    {
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
