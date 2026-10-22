//! Named option profiles (osu-trainer style) in the tool data directory. The
//! active profile is the last one saved or selected; the UI loads it on open.
use crate::map::Options;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Default, Serialize, Deserialize)]
pub struct Profiles {
    pub active: Option<String>,
    pub profiles: BTreeMap<String, Options>,
}

const FILE: &str = "profiles.json";
pub const MAX_PROFILES: usize = 100;

pub fn load(data: &Path) -> Result<Profiles> {
    let path = data.join(FILE);
    if !path.exists() {
        return Ok(Profiles::default());
    }
    serde_json::from_slice(&fs::read(&path)?).with_context(|| format!("reading {}", path.display()))
}

fn store(data: &Path, profiles: &Profiles) -> Result<()> {
    fs::create_dir_all(data)?;
    let temporary = data.join(format!("{FILE}.tmp"));
    fs::write(&temporary, serde_json::to_vec_pretty(profiles)?)?;
    fs::rename(temporary, data.join(FILE))?;
    Ok(())
}

pub fn name(raw: &str) -> Result<String> {
    let name = raw.trim();
    ensure!(
        (1..=40).contains(&name.chars().count()),
        "profile names are 1–40 characters"
    );
    ensure!(
        !name.chars().any(char::is_control),
        "profile names cannot contain control characters"
    );
    Ok(name.to_owned())
}

/// Saves `options` under `name` and makes it active. Trim ranges belong to one
/// map, so profiles keep the trim padding but never the ranges.
pub fn save(data: &Path, raw_name: &str, mut options: Options) -> Result<Profiles> {
    let name = name(raw_name)?;
    let mut profiles = load(data)?;
    ensure!(
        profiles.profiles.contains_key(&name) || profiles.profiles.len() < MAX_PROFILES,
        "at most {MAX_PROFILES} profiles"
    );
    options.trims.clear();
    profiles.profiles.insert(name.clone(), options);
    profiles.active = Some(name);
    store(data, &profiles)?;
    Ok(profiles)
}

pub fn activate(data: &Path, raw_name: &str) -> Result<Profiles> {
    let name = name(raw_name)?;
    let mut profiles = load(data)?;
    ensure!(profiles.profiles.contains_key(&name), "unknown profile");
    profiles.active = Some(name);
    store(data, &profiles)?;
    Ok(profiles)
}

pub fn delete(data: &Path, raw_name: &str) -> Result<Profiles> {
    let name = name(raw_name)?;
    let mut profiles = load(data)?;
    ensure!(profiles.profiles.remove(&name).is_some(), "unknown profile");
    if profiles.active.as_deref() == Some(name.as_str()) {
        profiles.active = None;
    }
    store(data, &profiles)?;
    Ok(profiles)
}
