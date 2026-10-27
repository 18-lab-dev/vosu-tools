//! The newest completed local osu!mania play: its replay and its `.osu`, for
//! calibrating a skin's hit position and hold tails from how the player
//! actually hits. Replays, not live capture, so Skin studio need not be open
//! while playing.
//!
//! - osu!stable keeps a replay of every completed local score in
//!   `<osu!>/Data/r/<beatmap md5>-<time>.osr` (`time`: the play's Windows
//!   FILETIME, 100 ns since 1601). Maps come from `osu!.db` (folder and file per MD5)
//!   under the Songs folder.
//! - osu!lazer's scores and replay files come from the optional
//!   `lazer-library` tool (`/v1/scores/recent`, `/v1/beatmaps/by-md5/<md5>`).

use crate::{App, Failure, library};
use axum::http::StatusCode;
use base64::Engine;
use md5::{Digest, Md5};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
pub struct LastPlay {
    pub client: &'static str,
    /// Where the replay came from, for the UI (`Data/r/<file>`, `lazer score <id>`).
    pub source: String,
    /// When it was played: epoch milliseconds (stable) or lazer's ISO date.
    pub date: Value,
    pub md5: String,
    /// The `.osr`, base64.
    pub replay: String,
    /// The map's `.osu` text.
    pub osu: String,
}

/// Windows FILETIME (100 ns since 1601) at the Unix epoch.
const UNIX_FILETIME: u64 = 116_444_736_000_000_000;

/// `Data/r` names, newest first: `(ticks, md5, file name)`.
pub fn stable_replays(names: impl IntoIterator<Item = String>) -> Vec<(u64, String, String)> {
    let mut out: Vec<_> = names
        .into_iter()
        .filter_map(|name| {
            let stem = name
                .strip_suffix(".osr")
                .or_else(|| name.strip_suffix(".OSR"))?;
            let (md5, ticks) = stem.split_once('-')?;
            let valid = md5.len() == 32 && md5.bytes().all(|b| b.is_ascii_hexdigit());
            Some((
                ticks.parse::<u64>().ok()?,
                md5.to_ascii_lowercase(),
                name.clone(),
            ))
            .filter(|_| valid)
        })
        .collect();
    out.sort_by_key(|play| std::cmp::Reverse(play.0));
    out
}

/// stable's osu! folder: vosu's (the attached stable client's) or the one
/// holding Skin studio's Skins folder setting, so it works without osu! open.
async fn stable_dir(app: &App) -> Option<PathBuf> {
    let context: Value = app.client.host("context").await.ok()?;
    if let Some(dir) = context["osu_dir"].as_str() {
        return Some(PathBuf::from(dir));
    }
    let settings = library::settings(app).await;
    library::stable_dir(&settings, None)?
        .parent()
        .map(Path::to_path_buf)
}

/// The newest mania replay in `Data/r` and its map, or why there is none.
async fn stable_last(app: &App) -> Result<LastPlay, String> {
    let osu = stable_dir(app)
        .await
        .ok_or("osu!stable: no osu! folder (attach stable or set the Stable Skins folder)")?;
    let dir = osu.join("Data").join("r");
    let names = std::fs::read_dir(&dir)
        .map_err(|_| format!("osu!stable: no replays in {}", dir.display()))?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned());
    // Each completed local play leaves one; the newest mania one is the last play.
    for (ticks, md5, name) in stable_replays(names).into_iter().take(500) {
        let Ok(bytes) = std::fs::read(dir.join(&name)) else {
            continue;
        };
        if bytes.first() != Some(&3) {
            continue;
        }
        let osu_text = stable_map(&osu, &md5).ok_or_else(|| {
            format!(
                "osu!stable: the map of {name} (MD5 {md5}) is not in osu!.db or its Songs folder"
            )
        })?;
        return Ok(LastPlay {
            client: "stable",
            source: format!("Data/r/{name}"),
            date: Value::from(ticks.saturating_sub(UNIX_FILETIME) / 10_000),
            md5,
            replay: base64::engine::general_purpose::STANDARD.encode(bytes),
            osu: osu_text,
        });
    }
    Err(format!(
        "osu!stable: no osu!mania replay in {}",
        dir.display()
    ))
}

/// The `.osu` with this MD5, from `osu!.db` under the Songs folder.
fn stable_map(osu: &Path, md5: &str) -> Option<String> {
    let maps = osu_db::maps(&std::fs::read(osu.join("osu!.db")).ok()?).ok()?;
    let map = maps.get(md5)?;
    let path = osu.join("Songs").join(&map.folder).join(&map.file);
    let bytes = std::fs::read(path).ok()?;
    (format!("{:x}", Md5::digest(&bytes)) == md5)
        .then(|| String::from_utf8_lossy(&bytes).into_owned())
}

async fn lazer_json(app: &App, path: &str) -> Result<Value, String> {
    let response = library::lazer_get(app, path)
        .send()
        .await
        .map_err(|e| format!("osu!lazer: the lazer-library tool is unavailable ({e})"))?;
    if !response.status().is_success() {
        return Err(format!(
            "osu!lazer: lazer-library answered {} for {path}",
            response.status()
        ));
    }
    response.json().await.map_err(|e| format!("osu!lazer: {e}"))
}

/// A file lazer-library names, read only inside lazer's file store.
fn lazer_file(files: &Path, path: Option<&str>) -> Option<Vec<u8>> {
    let path = PathBuf::from(path?).canonicalize().ok()?;
    path.starts_with(files).then(|| std::fs::read(path).ok())?
}

async fn lazer_last(app: &App) -> Result<LastPlay, String> {
    let status = lazer_json(app, "v1/status").await?;
    let files = status["data_dir"]
        .as_str()
        .map(|d| Path::new(d).join("files"))
        .and_then(|d| d.canonicalize().ok())
        .ok_or("osu!lazer: lazer-library has no data folder")?;
    let recent = lazer_json(app, "v1/scores/recent?ruleset=mania&limit=1").await?;
    let score = &recent["scores"][0];
    let md5 = score["beatmap_md5"]
        .as_str()
        .ok_or("osu!lazer: no osu!mania score with a replay")?
        .to_owned();
    let replay = lazer_file(&files, score["replay_path"].as_str())
        .ok_or("osu!lazer: the last score's replay file is missing")?;
    let map = lazer_json(app, &format!("v1/beatmaps/by-md5/{md5}")).await?;
    let osu = lazer_file(&files, map["osu_path"].as_str())
        .ok_or_else(|| format!("osu!lazer: the map with MD5 {md5} is missing"))?;
    Ok(LastPlay {
        client: "lazer",
        source: format!("lazer score {}", score["id"].as_str().unwrap_or("?")),
        date: score["date"].clone(),
        md5,
        replay: base64::engine::general_purpose::STANDARD.encode(replay),
        osu: String::from_utf8_lossy(&osu).into_owned(),
    })
}

/// The last play of the client vosu is attached to (else stable, then
/// lazer); a 404 lists what each source said.
pub async fn last(app: &App) -> Result<LastPlay, Failure> {
    let context: Value = app.client.host("context").await.unwrap_or_default();
    let lazer_first = context["client"].as_str() == Some("lazer");
    let first = if lazer_first {
        lazer_last(app).await
    } else {
        stable_last(app).await
    };
    let first_error = match first {
        Ok(play) => return Ok(play),
        Err(e) => e,
    };
    let second = if lazer_first {
        stable_last(app).await
    } else {
        lazer_last(app).await
    };
    second.map_err(|e| (StatusCode::NOT_FOUND, format!("{first_error}; {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_replays_newest_first() {
        let md5 = "0123456789abcdef0123456789abcdef";
        let names = [
            format!("{md5}-134364069253702913.osr"),
            format!("{md5}-134364072615346452.osr"),
            format!("{md5}-134364072615346452.osg"),
            "notes.txt".into(),
            "nothex0123456789abcdef0123456789-1.osr".into(),
        ];
        let found = stable_replays(names);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].0, 134364072615346452);
        assert_eq!(found[0].1, md5);
        // The user's newest stable replay: 2026-10-14 (Unix ms below).
        assert_eq!((found[0].0 - UNIX_FILETIME) / 10_000, 1_791_933_661_534);
    }
}
