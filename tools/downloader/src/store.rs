use crate::{
    model::{Config, Mapset, Source},
    net::Network,
};
use md5::Md5;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

pub fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("missing parent directory")?;
    std::fs::create_dir_all(parent).map_err(|_| "cannot create data directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "cannot create atomic temporary file")?;
    temp.write_all(bytes).map_err(|_| "cannot write data")?;
    temp.as_file().sync_all().map_err(|_| "cannot sync data")?;
    temp.persist(path)
        .map_err(|_| "cannot atomically replace data")?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "cannot sync data directory")?;
    Ok(())
}
pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    atomic_bytes(
        path,
        &serde_json::to_vec_pretty(value).map_err(|_| "cannot serialize data")?,
    )
}
pub fn load<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b)
            .map_err(|_| "invalid persisted settings or queue; not overwritten".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(_) => Err("cannot read persisted data".into()),
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub set: Mapset,
    pub source: Source,
    pub no_video: bool,
    pub state: String,
    pub progress: f64,
    pub message: String,
    pub bytes: u64,
    pub total: Option<u64>,
    pub sha256: Option<String>,
    pub result: Option<PathBuf>,
    pub imported_to: Option<PathBuf>,
}
#[derive(Default, Serialize, Deserialize)]
pub struct Queue {
    pub paused: bool,
    pub jobs: Vec<Job>,
    pub next_id: u64,
}
impl Queue {
    pub fn recover(&mut self) {
        self.paused = true;
        for j in &mut self.jobs {
            if j.state == "running" {
                j.state = "queued".into();
                j.progress = 0.0;
                j.bytes = 0;
                j.message = "Interrupted by restart; resume to restart the file safely".into();
            }
        }
    }
    pub fn add(&mut self, set: Mapset, source: Source, no_video: bool) -> Result<String, String> {
        if set.id == 0 {
            return Err("invalid mapset ID".into());
        }
        if self.jobs.len() >= 500 {
            return Err("queue limited to 500 entries; clear completed jobs first".into());
        }
        if self.jobs.iter().any(|j| {
            j.set.id == set.id
                && j.no_video == no_video
                && j.state != "cancelled"
                && j.state != "failed"
        }) {
            return Err("mapset already queued or downloaded".into());
        }
        self.next_id = self.next_id.checked_add(1).ok_or("job ID exhausted")?;
        let id = self.next_id.to_string();
        self.jobs.push(Job {
            id: id.clone(),
            set,
            source,
            no_video,
            state: "queued".into(),
            progress: 0.0,
            message: "Waiting for resume".into(),
            bytes: 0,
            total: None,
            sha256: None,
            result: None,
            imported_to: None,
        });
        Ok(id)
    }
}
/// How long effective settings are reused before asking vosu again. Edits in
/// the dashboard apply within this window without restarting the service.
const CONFIG_TTL: std::time::Duration = std::time::Duration::from_secs(2);
type CachedConfig = Option<(tokio::time::Instant, Result<Config, String>)>;
#[derive(Clone)]
pub struct Store {
    pub queue: Arc<Mutex<Queue>>,
    pub data: PathBuf,
    pub network: Network,
    pub host: vosu_tool_sdk::Client,
    config: Arc<Mutex<CachedConfig>>,
}
impl Store {
    pub fn new(queue: Queue, data: PathBuf, network: Network, host: vosu_tool_sdk::Client) -> Self {
        Self {
            queue: Arc::new(Mutex::new(queue)),
            data,
            network,
            host,
            config: Arc::default(),
        }
    }
    /// Effective settings from `settings.json`, as edited in the dashboard.
    pub async fn config(&self) -> Result<Config, String> {
        let mut cached = self.config.lock().await;
        if let Some((at, config)) = &*cached
            && at.elapsed() < CONFIG_TTL
        {
            return config.clone();
        }
        let config = match self.host.settings::<serde_json::Value>().await {
            Ok(v) => Config::from_settings(v),
            Err(e) => Err(format!("cannot read tool settings from vosu: {e}")),
        };
        *cached = Some((tokio::time::Instant::now(), config.clone()));
        config
    }
    pub fn queue_path(&self) -> PathBuf {
        self.data.join("queue.json")
    }
    pub async fn persist(&self) -> Result<(), String> {
        save(&self.queue_path(), &*self.queue.lock().await)
    }
    pub async fn cancelled(&self, id: &str) -> bool {
        let q = self.queue.lock().await;
        q.paused
            || q.jobs
                .iter()
                .find(|j| j.id == id)
                .is_none_or(|j| j.state != "running")
    }
    pub async fn worker(self) {
        loop {
            // Invalid or unreadable settings start nothing; /v1/state reports why.
            let Ok(config) = self.config().await else {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                continue;
            };
            let (limit, cap) = (config.concurrency, config.max_file_mb * 1024 * 1024);
            let jobs = {
                let mut q = self.queue.lock().await;
                if q.paused {
                    Vec::new()
                } else {
                    let active = q.jobs.iter().filter(|j| j.state == "running").count();
                    let mut jobs = Vec::new();
                    for j in q
                        .jobs
                        .iter_mut()
                        .filter(|j| j.state == "queued")
                        .take(limit.saturating_sub(active))
                    {
                        j.state = "running".into();
                        j.message = "Connecting".into();
                        jobs.push(j.clone());
                    }
                    if let Err(e) = save(&self.queue_path(), &*q) {
                        q.paused = true;
                        for j in &mut q.jobs {
                            if j.state == "running" {
                                j.state = "failed".into();
                                j.message = e.clone();
                            }
                        }
                        jobs.clear();
                    }
                    jobs
                }
            };
            for job in jobs {
                let s = self.clone();
                tokio::spawn(async move {
                    s.run_job(job, cap).await;
                });
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
    // Pausing is a control outcome, not an error. Keep it distinct even if a
    // user resumes before this worker has finished dropping the response.
    async fn run_job(&self, job: Job, cap: u64) {
        let result = self.download(&job, cap).await;
        let mut q = self.queue.lock().await;
        let paused = q.paused;
        if let Some(j) = q.jobs.iter_mut().find(|j| j.id == job.id)
            && j.state != "cancelled"
        {
            match result {
                Ok((path, sha)) => {
                    j.result = Some(path);
                    j.sha256 = Some(sha);
                    j.progress = 1.0;
                    j.state = "done".into();
                    j.message = "Validated ZIP, CRCs and beatmap checksums; ready to import".into();
                }
                Err(TransferError::Paused) => {
                    j.state = "queued".into();
                    j.message = "Paused; resume safely restarts the file".into();
                }
                Err(TransferError::Failed(e)) => {
                    j.state = if paused { "queued" } else { "failed" }.into();
                    j.message = e;
                }
            }
        }
        if let Err(e) = save(&self.queue_path(), &*q) {
            q.paused = true;
            if let Some(j) = q.jobs.iter_mut().find(|j| j.id == job.id) {
                j.message = e;
            }
        }
    }
    async fn download(&self, job: &Job, cap: u64) -> Result<(PathBuf, String), TransferError> {
        let downloads = self.data.join("downloads");
        std::fs::create_dir_all(&downloads).map_err(|_| "cannot create downloads directory")?;
        let path = downloads.join(format!(
            "{}-{}{}.osz",
            job.set.id,
            job.id,
            if job.no_video { "-novideo" } else { "" }
        ));
        // A crash can happen after archive rename but before queue persistence.
        // Reuse only an independently revalidated completed archive.
        if path.exists() {
            let size = std::fs::metadata(&path)
                .map_err(|_| "cannot stat recovered archive")?
                .len();
            if size > cap {
                return Err("recovered archive exceeds size cap".into());
            }
            validate_archive(&path, &job.set)?;
            let mut file =
                std::fs::File::open(&path).map_err(|_| "cannot read recovered archive")?;
            let mut sha = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let n = file
                    .read(&mut buffer)
                    .map_err(|_| "cannot hash recovered archive")?;
                if n == 0 {
                    break;
                }
                sha.update(&buffer[..n]);
            }
            return Ok((path, format!("{:x}", sha.finalize())));
        }
        let url = format!(
            "{}/api/d/{}{}",
            job.source.base.trim_end_matches('/'),
            job.set.id,
            if job.no_video { "?noVideo=true" } else { "" }
        );
        let mut response = self
            .network
            .request(&url, &job.source.base, job.source.interval_ms, None)
            .await?;
        if self.cancelled(&job.id).await {
            return Err(TransferError::Paused);
        }
        let total = response.content_length();
        if total.is_some_and(|n| n > cap) {
            return Err("file exceeds configured size cap".into());
        }
        let mut temp = tempfile::NamedTempFile::new_in(&downloads)
            .map_err(|_| "cannot create download file")?;
        let mut bytes = 0u64;
        let mut sha = Sha256::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "download interrupted; retry restarts the file")?
        {
            if self.cancelled(&job.id).await {
                return Err(TransferError::Paused);
            }
            bytes += chunk.len() as u64;
            if bytes > cap {
                return Err("file exceeds configured size cap".into());
            }
            temp.write_all(&chunk)
                .map_err(|_| "cannot write download")?;
            sha.update(&chunk);
            let mut q = self.queue.lock().await;
            if let Some(j) = q.jobs.iter_mut().find(|j| j.id == job.id) {
                j.bytes = bytes;
                j.total = total;
                j.progress = total.map_or(0.0, |t| bytes as f64 / t.max(1) as f64);
                j.message = "Downloading".into();
            }
        }
        if bytes == 0 || total.is_some_and(|n| bytes != n) {
            return Err("download size mismatch".into());
        }
        temp.as_file()
            .sync_all()
            .map_err(|_| "cannot sync download")?;
        validate_archive(temp.path(), &job.set)?;
        temp.persist_noclobber(&path)
            .map_err(|_| "download destination already exists or cannot be saved")?;
        Ok((path, format!("{:x}", sha.finalize())))
    }
}
fn validate_archive(path: &Path, set: &Mapset) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|_| "cannot read downloaded archive")?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "download is not a valid .osz ZIP")?;
    if zip.len() > 10000 {
        return Err("too many archive entries".into());
    }
    let expected = set
        .beatmaps
        .iter()
        .filter_map(|m| m.checksum.as_ref())
        .collect::<std::collections::HashSet<_>>();
    let mut matched = std::collections::HashSet::new();
    let mut maps = 0;
    let mut expanded = 0u64;
    let mut buf = [0u8; 65536];
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|_| "invalid ZIP entry")?;
        if f.enclosed_name().is_none() || f.name().contains('\\') || f.is_symlink() {
            return Err("unsafe archive entry".into());
        }
        expanded = expanded
            .checked_add(f.size())
            .ok_or("archive size overflow")?;
        if expanded > 512 * 1024 * 1024 {
            return Err("expanded archive exceeds 512 MiB".into());
        }
        let is_map = f.name().to_ascii_lowercase().ends_with(".osu");
        let mut md5 = Md5::new();
        let mut actual = 0u64;
        loop {
            let n = f
                .read(&mut buf)
                .map_err(|_| "archive CRC or decompression failed")?;
            if n == 0 {
                break;
            }
            actual += n as u64;
            if actual > f.size() {
                return Err("archive entry size mismatch".into());
            }
            if is_map {
                md5.update(&buf[..n]);
            }
        }
        if actual != f.size() {
            return Err("archive entry truncated".into());
        }
        if is_map {
            maps += 1;
            let hash = format!("{:x}", md5.finalize());
            if expected.iter().any(|h| h.eq_ignore_ascii_case(&hash)) {
                matched.insert(hash);
            }
        }
    }
    if maps == 0 {
        return Err("archive contains no beatmaps".into());
    }
    if !expected.is_empty() && matched.len() != expected.len() {
        return Err("beatmap MD5 metadata mismatch; refresh metadata before retrying".into());
    }
    Ok(())
}
#[derive(Debug)]
enum TransferError {
    Paused,
    Failed(String),
}
impl From<String> for TransferError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}
impl From<&str> for TransferError {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistence_resume_and_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.json");
        let mut q = Queue::default();
        let id = q
            .add(
                Mapset {
                    id: 42,
                    ..Mapset::default()
                },
                Source::default(),
                true,
            )
            .unwrap();
        assert_eq!(id, "1");
        assert!(
            q.add(
                Mapset {
                    id: 42,
                    ..Mapset::default()
                },
                Source::default(),
                true
            )
            .is_err()
        );
        q.jobs[0].state = "running".into();
        save(&path, &q).unwrap();
        let mut recovered: Queue = load(&path).unwrap();
        recovered.recover();
        assert!(recovered.paused);
        assert_eq!(recovered.jobs[0].state, "queued");
        save(&path, &recovered).unwrap();
        assert_eq!(load::<Queue>(&path).unwrap().jobs.len(), 1);
    }
    #[test]
    fn archive_checksums_and_rejection() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let mut z = zip::ZipWriter::new(temp.reopen().unwrap());
        z.start_file("map.osu", zip::write::SimpleFileOptions::default())
            .unwrap();
        z.write_all(b"osu file format v14").unwrap();
        z.finish().unwrap();
        let set = Mapset {
            beatmaps: vec![crate::model::Difficulty {
                checksum: Some(format!("{:x}", Md5::digest(b"osu file format v14"))),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(validate_archive(temp.path(), &set).is_ok());
        let wrong = Mapset {
            beatmaps: vec![crate::model::Difficulty {
                checksum: Some("wrong".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(validate_archive(temp.path(), &wrong).is_err());
    }
    #[tokio::test]
    async fn recovers_archive_renamed_before_queue_commit_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = dir.path().join("downloads");
        std::fs::create_dir(&downloads).unwrap();
        let file = downloads.join("42-1.osz");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&file).unwrap());
        z.start_file("map.osu", zip::write::SimpleFileOptions::default())
            .unwrap();
        z.write_all(b"osu file format v14").unwrap();
        z.finish().unwrap();
        let mut queue = Queue::default();
        queue
            .add(
                Mapset {
                    id: 42,
                    ..Default::default()
                },
                Source::default(),
                false,
            )
            .unwrap();
        let job = queue.jobs[0].clone();
        // No vosu is running in tests; recovery must not need settings or network.
        let host = vosu_tool_sdk::ToolEnv {
            id: "downloader".into(),
            token: "0".repeat(64).into(),
            vosu_url: "http://127.0.0.1:9".into(),
            data_dir: dir.path().to_owned(),
            cache_dir: dir.path().join("cache"),
            interface: vosu_tool_sdk::Interface::Service,
        }
        .client();
        let store = Store::new(
            queue,
            dir.path().to_owned(),
            Network::new(dir.path().join("cache")).unwrap(),
            host,
        );
        let (recovered, hash) = store.download(&job, 1024 * 1024).await.unwrap();
        assert_eq!(recovered, file);
        assert_eq!(
            hash,
            format!("{:x}", Sha256::digest(std::fs::read(file).unwrap()))
        );
    }
}
