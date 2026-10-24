use crate::schema;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

type Md5 = [u8; 16];
type Hash = [u8; 32];
fn hex<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() != N * 2 {
        return None;
    }
    let mut out = [0; N];
    for (byte, pair) in out.iter_mut().zip(text.as_bytes().chunks_exact(2)) {
        let digit = |v: u8| match v {
            b'0'..=b'9' => Some(v - b'0'),
            b'a'..=b'f' => Some(v - b'a' + 10),
            b'A'..=b'F' => Some(v - b'A' + 10),
            _ => None,
        };
        *byte = digit(pair[0])? * 16 + digit(pair[1])?;
    }
    Some(out)
}
fn hex_text(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from(DIGITS[usize::from(byte >> 4)]));
        text.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    text
}
fn text<'a>(v: &'a Value, field: &str) -> Option<&'a str> {
    v[field].as_str()
}
fn key(v: &Value) -> Cow<'_, str> {
    v.as_str()
        .map(Cow::Borrowed)
        .unwrap_or_else(|| Cow::Owned(v.to_string()))
}
fn positive(v: &Value) -> Option<i64> {
    v.as_i64().filter(|n| *n > 0)
}
fn deleted(v: &Value) -> bool {
    v["DeletePending"].as_bool() == Some(true)
}
fn store_path(base: &Path, hash: &str) -> PathBuf {
    let mut path = PathBuf::with_capacity(base.as_os_str().len() + 77);
    path.push(base);
    path.push("files");
    path.push(&hash[..1]);
    path.push(&hash[..2]);
    path.push(hash);
    path
}
#[derive(Default)]
struct Strings(HashSet<Arc<str>>);
impl Strings {
    fn intern(&mut self, s: &str) -> Arc<str> {
        if let Some(existing) = self.0.get(s) {
            return existing.clone();
        }
        let value: Arc<str> = Arc::from(s);
        self.0.insert(value.clone());
        value
    }
    fn field(&mut self, row: &Value, field: &str) -> Option<Arc<str>> {
        text(row, field).map(|s| self.intern(s))
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct LibraryFile {
    pub name: String,
    pub hash: String,
    pub path: PathBuf,
}
struct StoredFile {
    name: Arc<str>,
    hash: Hash,
}
impl StoredFile {
    fn describe(&self, base: &Path) -> LibraryFile {
        let hash = hex_text(&self.hash);
        let path = store_path(base, &hash);
        LibraryFile {
            name: self.name.to_string(),
            hash,
            path,
        }
    }
    fn response(&self, base: &Path) -> Value {
        let hash = hex_text(&self.hash);
        let path = store_path(base, &hash)
            .into_os_string()
            .into_string()
            .expect("lazer file paths must be UTF-8 for JSON");
        Value::Object(
            [
                ("name".into(), Value::String(self.name.to_string())),
                ("hash".into(), Value::String(hash)),
                ("path".into(), Value::String(path)),
            ]
            .into_iter()
            .collect(),
        )
    }
}
fn files(row: &Value, strings: &mut Strings) -> Box<[StoredFile]> {
    row["Files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            Some(StoredFile {
                name: strings.intern(text(f, "Filename").unwrap_or_default()),
                hash: hex(text(f, "File")?)?,
            })
        })
        .collect()
}
struct BeatmapSet {
    online_id: Option<i64>,
    files: Box<[StoredFile]>,
}
struct Metadata {
    artist: Option<Arc<str>>,
    title: Option<Arc<str>>,
    creator: Option<Arc<str>>,
    audio: Option<Arc<str>>,
    background: Option<Arc<str>>,
}
#[derive(Clone, Copy)]
enum Ruleset {
    Osu,
    Taiko,
    Fruits,
    Mania,
}
impl Ruleset {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "osu" => Self::Osu,
            "taiko" => Self::Taiko,
            "fruits" => Self::Fruits,
            "mania" => Self::Mania,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Self::Osu => "osu",
            Self::Taiko => "taiko",
            Self::Fruits => "fruits",
            Self::Mania => "mania",
        }
    }
}
struct Beatmap {
    online_id: Option<i64>,
    set: usize,
    metadata: Option<usize>,
    ruleset: Ruleset,
    difficulty: Option<Arc<str>>,
    hash: Hash,
}
struct Skin {
    name: Option<Arc<str>>,
    creator: Option<Arc<str>>,
    files: Box<[StoredFile]>,
}
struct Score {
    id: Option<Arc<str>>,
    username: Option<Arc<str>>,
    ruleset: Option<Arc<str>>,
    mods: Option<Arc<str>>,
    total_score: Option<i64>,
    date: Option<Arc<str>>,
    replay: Option<Hash>,
}
#[derive(Default)]
pub struct Index {
    pub schema: i64,
    base: PathBuf,
    beatmaps: HashMap<Md5, Beatmap>,
    sets: Vec<BeatmapSet>,
    metadata: Vec<Metadata>,
    skins: HashMap<Arc<str>, Skin>,
    scores: HashMap<Md5, Vec<Score>>,
    pub online_ids: Vec<i64>,
    pub counts: [usize; 4],
    pub missing_properties: Vec<String>,
}
#[derive(Debug)]
pub struct LoadError {
    pub schema: Option<i64>,
    pub missing_properties: Vec<String>,
    pub message: String,
}
impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for LoadError {}
impl Index {
    pub fn load(base: &Path) -> Result<Self, LoadError> {
        let mut tables = realm_reader::read(&base.join("client.realm"))
            .map_err(|e| LoadError {
                schema: None,
                missing_properties: vec![],
                message: e.to_string(),
            })?
            .rows;
        let version = tables
            .get("metadata")
            .and_then(|r| r.first())
            .and_then(|v| v["version"].as_i64());
        let compatibility = schema::inspect(
            tables
                .get("__schema")
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        if !compatibility.errors.is_empty() {
            return Err(LoadError {
                schema: version,
                missing_properties: compatibility.missing,
                message: format!(
                    "Incompatible Realm properties: {}",
                    compatibility.errors.join("; ")
                ),
            });
        }
        let schema = version.ok_or_else(|| LoadError {
            schema: None,
            missing_properties: vec!["metadata.version".into()],
            message: "metadata.version: missing schema version value".into(),
        })?;
        compatibility.project(&mut tables);
        let mut index = Self {
            schema,
            base: base.to_owned(),
            missing_properties: compatibility.missing,
            ..Self::default()
        };
        let mut strings = Strings::default();
        let mut metadata_ids = HashMap::new();
        // Keep transient rows alive until construction finishes. Dropping each row
        // early would scatter long-lived compact strings across the large serde
        // arena's freed holes, preventing the allocator from returning its pages.
        for row in tables.get("class_BeatmapMetadata").into_iter().flatten() {
            metadata_ids.insert(key(&row["_key"]).into_owned(), index.metadata.len());
            index.metadata.push(Metadata {
                artist: strings.field(row, "Artist"),
                title: strings.field(row, "Title"),
                creator: strings.field(&row["Author"], "Username"),
                audio: strings.field(row, "AudioFile"),
                background: strings.field(row, "BackgroundFile"),
            });
        }
        let mut set_ids = HashMap::new();
        let mut online_ids = BTreeSet::new();
        for row in tables.get("class_BeatmapSet").into_iter().flatten() {
            if deleted(row) {
                continue;
            }
            let online_id = positive(&row["OnlineID"]);
            if let Some(id) = online_id {
                online_ids.insert(id);
            }
            set_ids.insert(key(&row["ID"]).into_owned(), index.sets.len());
            index.sets.push(BeatmapSet {
                online_id,
                files: files(row, &mut strings),
            });
        }
        index.online_ids = online_ids.into_iter().collect();
        let mut hash_to_md5 = HashMap::new();
        for row in tables.get("class_Beatmap").into_iter().flatten() {
            let Some(&set) = set_ids.get(key(&row["BeatmapSet"]).as_ref()) else {
                continue;
            };
            let Some(md5) = text(row, "MD5Hash").and_then(hex::<16>) else {
                continue;
            };
            let Some(hash) = text(row, "Hash").and_then(hex::<32>) else {
                continue;
            };
            let Some(ruleset) = text(row, "Ruleset").and_then(Ruleset::parse) else {
                continue;
            };
            hash_to_md5.insert(hash, md5);
            index.beatmaps.insert(
                md5,
                Beatmap {
                    online_id: positive(&row["OnlineID"]),
                    set,
                    metadata: metadata_ids.get(key(&row["Metadata"]).as_ref()).copied(),
                    ruleset,
                    difficulty: strings.field(row, "DifficultyName"),
                    hash,
                },
            );
        }
        for row in tables.get("class_Skin").into_iter().flatten() {
            if deleted(row) {
                continue;
            }
            index.skins.insert(
                strings.intern(key(&row["ID"]).as_ref()),
                Skin {
                    name: strings.field(row, "Name"),
                    creator: strings.field(row, "Creator"),
                    files: files(row, &mut strings),
                },
            );
        }
        let mut score_count = 0;
        for row in tables.get("class_Score").into_iter().flatten() {
            if deleted(row) {
                continue;
            }
            score_count += 1;
            let Some(md5) = text(row, "BeatmapHash")
                .and_then(hex::<32>)
                .and_then(|h| hash_to_md5.get(&h))
            else {
                continue;
            };
            let replay = row["Files"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|f| {
                    text(f, "Filename").is_some_and(|s| {
                        s.get(s.len().saturating_sub(4)..)
                            .is_some_and(|end| end.eq_ignore_ascii_case(".osr"))
                    })
                })
                .and_then(|f| text(f, "File"))
                .and_then(hex::<32>);
            let date =
                text(row, "Date").map(|s| strings.intern(&format!("{}Z", s.replacen(' ', "T", 1))));
            index.scores.entry(*md5).or_default().push(Score {
                id: strings.field(row, "ID"),
                username: strings.field(&row["User"], "Username"),
                ruleset: strings.field(row, "Ruleset"),
                mods: strings.field(row, "Mods"),
                total_score: row["TotalScore"].as_i64(),
                date,
                replay,
            });
        }
        index.counts = [
            index.sets.len(),
            index.beatmaps.len(),
            index.skins.len(),
            score_count,
        ];
        Ok(index)
    }
    pub fn data_dir(&self) -> &Path {
        &self.base
    }
    pub fn md5s(&self) -> impl Iterator<Item = String> + '_ {
        self.beatmaps.keys().map(|md5| hex_text(md5))
    }
    pub fn contains_md5(&self, md5: &str) -> bool {
        hex::<16>(md5).is_some_and(|k| self.beatmaps.contains_key(&k))
    }
    pub fn beatmap(&self, md5: &str) -> Option<Value> {
        let md5 = hex::<16>(md5)?;
        let map = self.beatmaps.get(&md5)?;
        let set = &self.sets[map.set];
        let file = set.files.iter().find(|f| f.hash == map.hash)?;
        let metadata = map.metadata.and_then(|id| self.metadata.get(id));
        let named = |name: Option<&str>| {
            name.and_then(|name| {
                set.files
                    .iter()
                    .find(|f| unicase::UniCase::new(f.name.as_ref()) == unicase::UniCase::new(name))
            })
            .map(|f| store_path(&self.base, &hex_text(&f.hash)))
        };
        let mut response = json!({"md5":hex_text(&md5),"beatmap_id":map.online_id,"beatmapset_id":set.online_id,"ruleset":map.ruleset.name(),"difficulty_name":map.difficulty.as_deref(),"artist":metadata.and_then(|m|m.artist.as_deref()),"title":metadata.and_then(|m|m.title.as_deref()),"creator":metadata.and_then(|m|m.creator.as_deref()),"osu_path":store_path(&self.base,&hex_text(&file.hash)),"audio_path":named(metadata.and_then(|m|m.audio.as_deref())),"background_path":named(metadata.and_then(|m|m.background.as_deref()))});
        response["files"] =
            Value::Array(set.files.iter().map(|f| f.response(&self.base)).collect());
        Some(response)
    }
    pub fn skin_list(&self) -> Value {
        let mut skins:Vec<_> = self.skins.iter().map(|(id,skin)| {
            let builtin = match id.as_ref() {"2991cfd8-2140-469a-bcb9-2ec23fbce4ad"=>Some("triangles"),"cffa69de-b3e3-4dee-8563-3c4f425c05d0"=>Some("argon"),"9fc9cf5d-0f16-4c71-8256-98868321ac43"=>Some("argon-pro"),"81f02cd3-eec6-4865-ac23-fae26a386187"=>Some("legacy"),"0555c76a-cc6b-4bb4-9548-df76ba72ef25"=>Some("retro"),_=>None};
            json!({"id":id.as_ref(),"name":skin.name.as_deref(),"creator":skin.creator.as_deref(),"builtin":builtin,"files":skin.files.len()})
        }).collect();
        skins.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        json!({"skins":skins})
    }
    pub fn skin_files(&self, id: &str) -> Option<Vec<LibraryFile>> {
        Some(
            self.skins
                .get(id)?
                .files
                .iter()
                .map(|f| f.describe(&self.base))
                .collect(),
        )
    }
    pub fn skin_file(&self, id: &str, name: &str) -> Option<LibraryFile> {
        self.skins
            .get(id)?
            .files
            .iter()
            .find(|f| unicase::UniCase::new(f.name.as_ref()) == unicase::UniCase::new(name))
            .map(|f| f.describe(&self.base))
    }
    pub fn skin_asset(&self, name: &str) -> Option<LibraryFile> {
        self.skins
            .values()
            .flat_map(|s| s.files.iter())
            .find(|f| unicase::UniCase::new(f.name.as_ref()) == unicase::UniCase::new(name))
            .map(|f| f.describe(&self.base))
    }
    pub fn score_list(&self, md5: &str) -> Value {
        let key = hex::<16>(md5);
        let scores:Vec<_> = key.as_ref().and_then(|k|self.scores.get(k)).into_iter().flatten().map(|score| {
            let replay_hash = score.replay.map(|h|hex_text(&h));
            json!({"id":score.id.as_deref(),"beatmap_md5":key.map(|k|hex_text(&k)),"username":score.username.as_deref(),"ruleset":score.ruleset.as_deref(),"mods":score.mods.as_deref(),"total_score":score.total_score,"date":score.date.as_deref(),"replay_hash":replay_hash,"replay_path":replay_hash.as_ref().map(|h|store_path(&self.base,h))})
        }).collect();
        json!({"scores":scores})
    }
}

/// Release transient Realm/serde allocations after publishing a completed refresh.
/// This is not periodic trimming and never runs on a request/lookup hot path.
pub fn release_allocator_pages() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        unsafe extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        malloc_trim(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packed_hex_is_case_insensitive_and_checked() {
        assert_eq!(hex::<2>("aB01"), Some([0xab, 1]));
        assert_eq!(hex::<2>("../a"), None);
        assert_eq!(hex::<2>("abc"), None);
        assert_eq!(hex_text(&[0xab, 1]), "ab01");
    }
}
