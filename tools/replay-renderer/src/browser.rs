//! Downloads a release-pinned headless browser into the tool cache; never uses host credentials.
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
const VERSION: &str = "156.0.8078.47";
const LINUX_SHA: &str = "0d5acc62c3e213f8c87d3c298d66ffcf9a236d12ea4b9f85318bf85dbc279daa";
const WINDOWS_SHA: &str = "e0af9b23f8051cca4f37ca49cd425e8055701bfc0383c198d67f8d5cc5884249";
const MAX_ARCHIVE: u64 = 300 * 1024 * 1024;
const MAX_EXPANDED: u64 = 1024 * 1024 * 1024;

pub async fn executable(cache: &Path) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("VOSU_RENDER_CHROMIUM").filter(|p| !p.is_empty()) {
        return Ok(path.into());
    }
    let (platform, sha, relative) = if cfg!(target_os = "windows") {
        (
            "win64",
            WINDOWS_SHA,
            "chrome-headless-shell-win64/chrome-headless-shell.exe",
        )
    } else if cfg!(target_os = "linux") {
        (
            "linux64",
            LINUX_SHA,
            "chrome-headless-shell-linux64/chrome-headless-shell",
        )
    } else {
        return Err("Managed browser supports Linux and Windows x86_64; set VOSU_RENDER_CHROMIUM for another platform".into());
    };
    let root = cache.join(format!("chromium-{VERSION}-{platform}"));
    if tokio::fs::read_to_string(root.join("verified.sha256"))
        .await
        .is_ok_and(|text| text == sha)
        && root.join(relative).is_file()
    {
        return Ok(root.join(relative));
    }
    tokio::fs::create_dir_all(cache)
        .await
        .map_err(|e| e.to_string())?;
    let nonce = uuid::Uuid::new_v4();
    let archive = cache.join(format!("browser-{nonce}.zip"));
    let stage = cache.join(format!("browser-{nonce}"));
    let result=async{
  let url=format!("https://storage.googleapis.com/chrome-for-testing-public/{VERSION}/{platform}/chrome-headless-shell-{platform}.zip");
  let client=reqwest::Client::builder().timeout(Duration::from_secs(300)).https_only(true).redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())?;
  let mut response=client.get(url).send().await.map_err(|e|format!("Browser download failed: {e}"))?.error_for_status().map_err(|e|e.to_string())?;
  if response.content_length().is_some_and(|length|length>MAX_ARCHIVE){return Err("Browser archive exceeds size limit".into());}
  let mut file=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&archive).await.map_err(|e|e.to_string())?;
  let mut digest=Sha256::new();let mut size=0;
  while let Some(chunk)=response.chunk().await.map_err(|e|e.to_string())?{size+=chunk.len() as u64;if size>MAX_ARCHIVE{return Err("Browser archive exceeds size limit".into());}digest.update(&chunk);file.write_all(&chunk).await.map_err(|e|e.to_string())?;}
  file.sync_all().await.map_err(|e|e.to_string())?;drop(file);
  if format!("{:x}",digest.finalize())!=sha{return Err("Browser archive SHA-256 mismatch; nothing was executed".into());}
  let source=archive.clone();let destination=stage.clone();
  tokio::task::spawn_blocking(move||extract(&source,&destination)).await.map_err(|e|e.to_string())??;
  if !stage.join(relative).is_file(){return Err("Verified browser archive has no expected executable".into());}
  tokio::fs::write(stage.join("verified.sha256"),sha).await.map_err(|e|e.to_string())?;
  if root.exists(){tokio::fs::remove_dir_all(&root).await.map_err(|e|e.to_string())?;}
  tokio::fs::rename(&stage,&root).await.map_err(|e|e.to_string())?;
  Ok(root.join(relative))
 }.await;
    let _ = tokio::fs::remove_file(archive).await;
    let _ = tokio::fs::remove_dir_all(stage).await;
    result
}
fn extract(archive: &Path, stage: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if zip.len() > 10000 {
        return Err("Browser archive has too many members".into());
    }
    let mut expanded = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or("Browser archive path escapes extraction root")?;
        let mode = entry.unix_mode().unwrap_or(0o644);
        if mode & 0o170000 == 0o120000 {
            return Err("Browser archive symlinks are not accepted".into());
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or("Browser archive size overflow")?;
        if expanded > MAX_EXPANDED {
            return Err("Browser archive expands beyond 1 GiB".into());
        }
        let path = stage.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
            continue;
        }
        std::fs::create_dir_all(path.parent().ok_or("Browser member has no parent")?)
            .map_err(|e| e.to_string())?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o755))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_release_hashes_have_sha256_shape() {
        for hash in [LINUX_SHA, WINDOWS_SHA] {
            assert_eq!(hash.len(), 64);
            assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }
    #[test]
    fn malicious_browser_archive_is_rejected() {
        let root = std::env::temp_dir().join(format!("vosu-browser-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let archive = root.join("bad.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        zip.start_file("../escape", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        assert!(extract(&archive, &root.join("unpack")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
