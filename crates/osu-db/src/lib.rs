//! Read-only stable database readers, ported from vosu 4c06922
//! crates/vosu-tool-skill-tracker/src/stable.rs (MIT OR Apache-2.0).
//! Format reference: https://osu.ppy.sh/wiki/en/Client/File_formats/Db_(file_format)
//! No client database is ever mutated by this crate.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

const LIMIT: usize = 1_000_000;
struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).ok_or("offset overflow")?;
        let b = self.data.get(self.at..end).ok_or("truncated database")?;
        self.at = end;
        Ok(b)
    }
    fn skip(&mut self, n: usize) -> Result<(), String> {
        self.take(n).map(|_| ())
    }
    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(self.u32()? as i32)
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn count(&mut self) -> Result<usize, String> {
        let n = self.u32()? as usize;
        if n > LIMIT || n > self.data.len() - self.at {
            Err("database collection exceeds safety limit or remaining input".into())
        } else {
            Ok(n)
        }
    }
    fn string(&mut self) -> Result<String, String> {
        match self.byte()? {
            0 => Ok(String::new()),
            11 => {
                let mut len = 0_usize;
                for shift in (0..35).step_by(7) {
                    let b = self.byte()?;
                    len |= ((b & 127) as usize) << shift;
                    if b & 128 == 0 {
                        if len > 1_048_576 {
                            return Err("database string too long".into());
                        }
                        return String::from_utf8(self.take(len)?.to_vec())
                            .map_err(|_| "invalid UTF-8".into());
                    }
                }
                Err("invalid ULEB128".into())
            }
            _ => Err("invalid string marker".into()),
        }
    }
    fn finish(&self) -> Result<(), String> {
        if self.at == self.data.len() {
            Ok(())
        } else {
            Err("unrecognized database trailing data".into())
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Beatmap {
    pub checksum: String,
    pub artist: String,
    pub title: String,
    pub creator: String,
    pub difficulty: String,
    pub folder: String,
    pub file: String,
    pub mode: u8,
    pub keys: f32,
    pub beatmap_id: i32,
    pub set_id: i32,
    pub length_seconds: u32,
    pub last_played_ticks: u64,
}
pub fn maps(data: &[u8]) -> Result<HashMap<String, Beatmap>, String> {
    let mut r = Reader::new(data);
    let version = r.u32()?;
    if version < 20080101 {
        return Err("unsupported osu!.db version".into());
    }
    r.skip(13)?;
    r.string()?;
    let n = r.count()?;
    let mut maps = HashMap::with_capacity(n);
    for _ in 0..n {
        if version < 20191106 {
            r.skip(4)?;
        }
        let artist = r.string()?;
        r.string()?;
        let title = r.string()?;
        r.string()?;
        let creator = r.string()?;
        let difficulty = r.string()?;
        r.string()?;
        let checksum = r.string()?;
        let file = r.string()?;
        r.skip(15)?;
        let keys = if version < 20140609 {
            r.skip(1)?;
            let cs = r.byte()?;
            r.skip(2)?;
            f32::from(cs)
        } else {
            r.skip(4)?;
            let cs = r.f32()?;
            r.skip(8)?;
            cs
        };
        r.skip(8)?;
        if version >= 20140609 {
            for _ in 0..4 {
                let pairs = r.count()?;
                r.skip(pairs * if version >= 20250107 { 10 } else { 14 })?;
            }
        }
        r.skip(4)?;
        let length_seconds = r.u32()? / 1000;
        r.skip(4)?;
        let timing = r.count()?;
        r.skip(timing * 17)?;
        let beatmap_id = r.i32()?;
        let set_id = r.i32()?;
        r.skip(4 + 4 + 2 + 4)?;
        let mode = r.byte()?;
        if mode > 3 {
            return Err("invalid beatmap mode".into());
        }
        r.string()?;
        r.string()?;
        r.skip(2)?;
        r.string()?;
        r.skip(1)?;
        let last_played_ticks = r.u64()?;
        r.skip(1)?;
        let folder = r.string()?;
        r.skip(13)?;
        if version < 20140609 {
            r.skip(2)?;
        }
        r.skip(5)?;
        maps.insert(
            checksum.clone(),
            Beatmap {
                checksum,
                artist,
                title,
                creator,
                difficulty,
                folder,
                file,
                mode,
                keys,
                beatmap_id,
                set_id,
                length_seconds,
                last_played_ticks,
            },
        );
    }
    r.skip(4)?;
    r.finish()?;
    Ok(maps)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Score {
    pub checksum: String,
    pub player: String,
    pub mode: u8,
    pub score: u32,
    pub combo: u16,
    pub mods: u32,
    pub timestamp_ticks: u64,
    pub online_id: u64,
}
pub fn scores(data: &[u8]) -> Result<Vec<Score>, String> {
    let mut r = Reader::new(data);
    r.u32()?;
    let n = r.count()?;
    let mut scores = Vec::new();
    for _ in 0..n {
        let group = r.string()?;
        let count = r.count()?;
        if scores.len().saturating_add(count) > LIMIT {
            return Err("too many imported scores".into());
        }
        for _ in 0..count {
            let mode = r.byte()?;
            if mode > 3 {
                return Err("invalid score mode".into());
            }
            r.skip(4)?;
            let checksum = r.string()?;
            let player = r.string()?;
            r.string()?;
            r.skip(12)?;
            let score = r.u32()?;
            let combo = r.u16()?;
            r.skip(1)?;
            let mods = r.u32()?;
            r.string()?;
            let timestamp_ticks = r.u64()?;
            r.skip(4)?;
            let online_id = r.u64()?;
            if mods & (1 << 23) != 0 {
                r.skip(8)?;
            }
            scores.push(Score {
                checksum: if checksum.is_empty() {
                    group.clone()
                } else {
                    checksum
                },
                player,
                mode,
                score,
                combo,
                mods,
                timestamp_ticks,
                online_id,
            });
        }
    }
    r.finish()?;
    Ok(scores)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Collection {
    pub name: String,
    pub checksums: Vec<String>,
}
pub fn collections(data: &[u8]) -> Result<Vec<Collection>, String> {
    let mut r = Reader::new(data);
    r.u32()?;
    let n = r.count()?;
    let mut result = Vec::with_capacity(n);
    let mut total = 0usize;
    for _ in 0..n {
        let name = r.string()?;
        let count = r.count()?;
        total = total.saturating_add(count);
        if total > LIMIT {
            return Err("too many collection entries".into());
        }
        let mut checksums = Vec::with_capacity(count);
        for _ in 0..count {
            checksums.push(r.string()?);
        }
        result.push(Collection { name, checksums });
    }
    r.finish()?;
    Ok(result)
}
#[derive(Default)]
pub struct Owned {
    pub set_ids: HashSet<u32>,
    pub checksums: HashSet<String>,
}
impl Owned {
    pub fn from_maps(maps: &HashMap<String, Beatmap>) -> Self {
        Self {
            set_ids: maps
                .values()
                .filter_map(|m| u32::try_from(m.set_id).ok().filter(|i| *i > 0))
                .collect(),
            checksums: maps.keys().cloned().collect(),
        }
    }
    pub fn contains(&self, set: u32, checksums: &[String]) -> bool {
        self.set_ids.contains(&set) || checksums.iter().any(|h| self.checksums.contains(h))
    }
}
/// Bound input before reading. Callers should copy a running client's DB first.
pub fn read_copy(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(512 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("database exceeds 512 MiB".into());
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn string(b: &mut Vec<u8>, s: &str) {
        b.push(11);
        b.push(s.len() as u8);
        b.extend(s.as_bytes());
    }
    fn u32(b: &mut Vec<u8>, v: u32) {
        b.extend(v.to_le_bytes());
    }
    #[test]
    fn map_fixtures() {
        for version in [20100101, 20150101, 20200101, 20250107] {
            let mut b = Vec::new();
            u32(&mut b, version);
            b.extend([0; 13]);
            string(&mut b, "player");
            u32(&mut b, 1);
            if version < 20191106 {
                u32(&mut b, 0);
            }
            for s in [
                "artist", "", "title", "", "mapper", "diff", "audio", "hash", "map.osu",
            ] {
                string(&mut b, s);
            }
            b.extend([0; 15]);
            if version < 20140609 {
                b.extend([8, 4, 8, 8]);
            } else {
                for n in [8_f32, 4.0, 8.0, 8.0] {
                    b.extend(n.to_le_bytes());
                }
            }
            b.extend([0; 8]);
            if version >= 20140609 {
                for _ in 0..4 {
                    u32(&mut b, 1);
                    b.extend(vec![0; if version >= 20250107 { 10 } else { 14 }]);
                }
            }
            b.extend([0; 12]);
            u32(&mut b, 1);
            b.extend([0; 17]);
            u32(&mut b, 42);
            u32(&mut b, 123);
            b.extend([0; 14]);
            b.push(3);
            string(&mut b, "");
            string(&mut b, "");
            b.extend([0; 2]);
            string(&mut b, "");
            b.extend([0; 10]);
            string(&mut b, "folder");
            b.extend([0; 13]);
            if version < 20140609 {
                b.extend([0; 2]);
            }
            b.extend([0; 5]);
            u32(&mut b, 0);
            let m = maps(&b).unwrap();
            assert_eq!(m["hash"].keys, 4.0);
            assert_eq!(m["hash"].set_id, 123);
            assert!(Owned::from_maps(&m).contains(123, &[]));
            assert!(!Owned::from_maps(&m).contains(124, &[]));
            assert!(Owned::from_maps(&m).contains(124, &["hash".into()]));
            assert!(!Owned::from_maps(&m).contains(124, &["unowned".into()]));
            for end in 0..b.len() {
                assert!(maps(&b[..end]).is_err());
            }
        }
    }
    #[test]
    fn score_fixture() {
        let mut b = Vec::new();
        u32(&mut b, 20250107);
        u32(&mut b, 1);
        string(&mut b, "hash");
        u32(&mut b, 1);
        b.push(3);
        u32(&mut b, 20250107);
        for s in ["", "player", "replay"] {
            string(&mut b, s);
        }
        b.extend([0; 12]);
        u32(&mut b, 1000000);
        b.extend(10_u16.to_le_bytes());
        b.push(1);
        u32(&mut b, 1 << 23);
        string(&mut b, "");
        b.extend(638000000000000000_u64.to_le_bytes());
        u32(&mut b, u32::MAX);
        b.extend(42_u64.to_le_bytes());
        b.extend([0; 8]);
        let s = scores(&b).unwrap();
        assert_eq!(s[0].checksum, "hash");
        assert_eq!(s[0].online_id, 42);
        for end in 0..b.len() {
            assert!(scores(&b[..end]).is_err());
        }
    }
    #[test]
    fn collection_fixture() {
        let mut b = Vec::new();
        u32(&mut b, 20250107);
        u32(&mut b, 1);
        string(&mut b, "Practice");
        u32(&mut b, 1);
        string(&mut b, "md5");
        assert_eq!(collections(&b).unwrap()[0].checksums, ["md5"]);
        for end in 0..b.len() {
            assert!(collections(&b[..end]).is_err());
        }
        b.push(0);
        assert!(collections(&b).is_err());
    }
    #[test]
    fn malformed_limits() {
        assert!(collections(&[0; 4]).is_err());
        assert!(collections(&[255; 8]).is_err());
    }
    #[test]
    fn local_temp_copies_when_requested() {
        let Ok(root) = std::env::var("OSU_DB_FIXTURE_DIR") else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        for name in ["osu!.db", "scores.db", "collection.db"] {
            let dest = temp.path().join(name);
            std::fs::copy(Path::new(&root).join(name), &dest).unwrap();
            let b = read_copy(&dest).unwrap();
            let count = match name {
                "osu!.db" => maps(&b).unwrap().len(),
                "scores.db" => scores(&b).unwrap().len(),
                _ => collections(&b).unwrap().len(),
            };
            eprintln!("{name}: parsed {count} records from temporary copy");
        }
    }
}
