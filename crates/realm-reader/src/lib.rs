//! Read-only Realm snapshots. The native engine only sees private, stable copies.
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_void},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
}
pub type Result<T> = std::result::Result<T, Error>;
const MAX_FILE: u64 = 4 * 1024 * 1024 * 1024;
const MAX_JSON: usize = 256 * 1024 * 1024;
unsafe extern "C" {
    fn vosu_realm_scan(
        path: *const c_char,
        callback: extern "C" fn(*mut c_void, *const c_char, *const c_char, usize) -> i32,
        ctx: *mut c_void,
        error: *mut c_char,
        cap: usize,
    ) -> i32;
    fn vosu_realm_fixture(path: *const c_char, generation: i32) -> i32;
    #[cfg(test)]
    fn vosu_realm_test_commits(path: *const c_char, count: i32) -> i32;
}
#[derive(Default, Debug)]
pub struct Tables {
    pub rows: HashMap<String, Vec<Value>>,
    bytes: usize,
    heap_estimate: usize,
    error: Option<String>,
}

fn heap_estimate(value: &Value) -> usize {
    let nested = match value {
        Value::String(s) => s.capacity(),
        Value::Array(a) => {
            a.capacity() * std::mem::size_of::<Value>() + a.iter().map(heap_estimate).sum::<usize>()
        }
        // BTreeMap node overhead is conservatively charged per entry, including
        // keys, pointers and allocator overhead, instead of assuming JSON size.
        Value::Object(o) => o
            .iter()
            .map(|(k, v)| 128 + k.capacity() + heap_estimate(v))
            .sum(),
        _ => 0,
    };
    std::mem::size_of::<Value>() + nested
}
extern "C" fn receive(
    ctx: *mut c_void,
    name: *const c_char,
    data: *const c_char,
    len: usize,
) -> i32 {
    // Pointers are valid only for this synchronous callback. Never unwind into C++.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let tables = unsafe { &mut *ctx.cast::<Tables>() };
        tables.bytes = tables.bytes.saturating_add(len);
        if tables.bytes > MAX_JSON {
            return Err("Realm index exceeds 256 MiB serialized data".to_owned());
        }
        let name = unsafe { CStr::from_ptr(name) }
            .to_string_lossy()
            .into_owned();
        let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) };
        let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        tables.heap_estimate = tables.heap_estimate.saturating_add(heap_estimate(&value));
        if tables.heap_estimate > MAX_JSON {
            return Err("Realm index exceeds 256 MiB estimated JSON heap".to_owned());
        }
        tables.rows.entry(name).or_default().push(value);
        Ok(())
    }));
    match result {
        Ok(Ok(())) => 0,
        other => {
            let message = match other {
                Ok(Err(e)) => e,
                _ => "Realm row callback panicked".into(),
            };
            unsafe { &mut *ctx.cast::<Tables>() }.error = Some(message);
            -1
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    header: [u8; 24],
    root: Vec<u8>,
    len: u64,
    modified: std::time::SystemTime,
}

/// Exact committed-header/root signature, including the MVCC transaction number.
/// Unlike mtime alone, this detects mmap commits on filesystems with coarse times.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision(Stamp);
pub fn revision(source: &Path) -> Result<Revision> {
    stamp(&mut File::open(source)?).map(Revision)
}
fn stamp(file: &mut File) -> Result<Stamp> {
    let metadata = file.metadata()?;
    if metadata.len() < 24 || metadata.len() > MAX_FILE {
        return Err(Error::Invalid("Realm size outside 24 bytes..4 GiB".into()));
    }
    file.seek(SeekFrom::Start(0))?;
    let mut header = [0; 24];
    file.read_exact(&mut header)?;
    if &header[16..20] != b"T-DB" {
        return Err(Error::Invalid("Not an unencrypted Realm file".into()));
    }
    let slot = usize::from(header[23] & 1);
    if header[20 + slot] > 24 {
        return Err(Error::Invalid("Realm file format newer than 24".into()));
    }
    let top = u64::from_le_bytes(header[slot * 8..slot * 8 + 8].try_into().unwrap());
    // Streaming form is immutable output from Group::write. Its footer selects the top.
    let top = if top == u64::MAX {
        file.seek(SeekFrom::End(-16))?;
        let mut footer = [0; 16];
        file.read_exact(&mut footer)?;
        u64::from_le_bytes(footer[..8].try_into().unwrap())
    } else {
        top
    };
    if top < 24 || top.checked_add(8).is_none_or(|n| n > metadata.len()) {
        return Err(Error::Invalid("Invalid Realm top reference".into()));
    }
    file.seek(SeekFrom::Start(top))?;
    let mut node = [0; 8];
    file.read_exact(&mut node)?;
    let count = (usize::from(node[5]) << 16) | (usize::from(node[6]) << 8) | usize::from(node[7]);
    let width = (1usize << (node[4] & 7)) >> 1;
    if !(3..=12).contains(&count) {
        return Err(Error::Invalid("Invalid Realm root array".into()));
    }
    let mut root = vec![0; 8 + (count * width).div_ceil(8)];
    root[..8].copy_from_slice(&node);
    file.read_exact(&mut root[8..])?;
    // Includes transaction version (slot 6): detects header ABA when dual slots/refs are reused.
    file.seek(SeekFrom::Start(0))?;
    let mut end = [0; 24];
    file.read_exact(&mut end)?;
    if end != header {
        return Err(Error::Invalid(
            "Realm committed while reading header".into(),
        ));
    }
    Ok(Stamp {
        header,
        root,
        len: metadata.len(),
        modified: metadata.modified()?,
    })
}

/// Retry a changing source; never open its lock file or native DB handle.
/// Realm MVCC protects the selected committed tree until the next commit. Requiring
/// identical committed roots/version before and after the copy detects that boundary.
/// Linux reflink gives an instantaneous COW image as well (when supported).
pub fn snapshot(source: &Path) -> Result<tempfile::NamedTempFile> {
    let mut last = "Realm is changing continuously".to_owned();
    for _ in 0..8 {
        let attempt = (|| {
            let mut input = File::open(source)?;
            let before = stamp(&mut input)?;
            let mut copy = tempfile::NamedTempFile::new()?;
            #[cfg(target_os = "linux")]
            let cloned = {
                use std::os::fd::AsRawFd;
                unsafe {
                    libc::ioctl(
                        copy.as_file().as_raw_fd(),
                        0x40049409_u64,
                        input.as_raw_fd(),
                    ) == 0
                }
            };
            #[cfg(not(target_os = "linux"))]
            let cloned = false;
            if !cloned {
                input.seek(SeekFrom::Start(0))?;
                let copied = std::io::copy(&mut input.by_ref().take(MAX_FILE + 1), &mut copy)?;
                if copied > MAX_FILE {
                    return Err(Error::Invalid(
                        "Realm grew beyond 4 GiB while copying".into(),
                    ));
                }
            }
            let after = stamp(&mut input)?;
            let copied = stamp(copy.as_file_mut())?;
            // Reopen to detect path replacement, not just modifications of the old handle.
            let current = stamp(&mut File::open(source)?)?;
            if before.header != after.header
                || before.root != after.root
                || before.len != after.len
                || before.modified != after.modified
                || after != current
                || copied.header != after.header
                || copied.root != after.root
            {
                return Err(Error::Invalid(
                    "Realm changed during snapshot; retrying".into(),
                ));
            }
            Ok(copy)
        })();
        match attempt {
            Ok(copy) => return Ok(copy),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    }
    Err(Error::Invalid(last))
}

pub fn read(source: &Path) -> Result<Tables> {
    let copy = snapshot(source)?;
    let path = CString::new(copy.path().to_string_lossy().as_bytes())
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let mut tables = Tables::default();
    let mut error = [0i8; 2048];
    let code = unsafe {
        vosu_realm_scan(
            path.as_ptr(),
            receive,
            (&mut tables as *mut Tables).cast(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if code != 0 {
        return Err(Error::Invalid(tables.error.unwrap_or_else(|| {
            unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        })));
    }
    if !tables.rows.contains_key("metadata") {
        return Err(Error::Invalid("Missing Realm .NET metadata table".into()));
    }
    Ok(tables)
}

/// Synthetic fixture generator for integration/concurrency tests; never accepts an existing path.
pub fn fixture(path: &Path, generation: bool) -> Result<()> {
    if path.exists() {
        return Err(Error::Invalid("Fixture destination already exists".into()));
    }
    let path = CString::new(path.to_string_lossy().as_bytes())
        .map_err(|e| Error::Invalid(e.to_string()))?;
    if unsafe { vosu_realm_fixture(path.as_ptr(), i32::from(generation)) } != 0 {
        return Err(Error::Invalid("Native fixture creation failed".into()));
    }
    Ok(())
}

/// Follow lazer's storage.ini (framework IniConfigManager: key `FullPath`).
pub fn data_dir(context: Option<&Path>, setting: Option<&Path>, default: &Path) -> PathBuf {
    let base = context.or(setting).unwrap_or(default);
    let storage = fs::read_to_string(base.join("storage.ini")).unwrap_or_default();
    for line in storage.lines() {
        if let Some((key, value)) = line.split_once('=')
            && key.trim().eq_ignore_ascii_case("FullPath")
            && !value.trim().is_empty()
        {
            let path = PathBuf::from(value.trim());
            return if path.is_absolute() {
                path
            } else {
                base.join(path)
            };
        }
    }
    base.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn synthetic() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.realm");
        fixture(&p, false).unwrap();
        let t = read(&p).unwrap();
        assert_eq!(t.rows["class_Beatmap"].len(), 1);
        assert_eq!(t.rows["metadata"][0]["version"], 52);
        assert_eq!(t.rows["class_Skin"][0]["Name"], "Fixture\u{1}skin");
    }
    #[test]
    fn storage_redirect() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("storage.ini"), "FullPath = custom\n").unwrap();
        assert_eq!(data_dir(None, None, dir.path()), dir.path().join("custom"));
    }
    #[test]
    fn rejects_invalid() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(read(file.path()).is_err());
    }
    #[test]
    fn concurrent_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        let active = dir.path().join("client.realm");
        fixture(&a, false).unwrap();
        fixture(&b, true).unwrap();
        fs::copy(&a, &active).unwrap();
        std::thread::scope(|scope| {
            let active = &active;
            let a = &a;
            let b = &b;
            scope.spawn(move || {
                for i in 0..100 {
                    let tmp = active.with_extension("new");
                    fs::copy(if i % 2 == 0 { a } else { b }, &tmp).unwrap();
                    fs::rename(&tmp, active).unwrap();
                }
            });
            for _ in 0..30 {
                if let Ok(t) = read(active) {
                    let d = t.rows["class_Beatmap"][0]["DifficultyName"]
                        .as_str()
                        .unwrap();
                    assert!(d == "Generation A" || d == "Generation B");
                }
            }
        });
    }
    #[test]
    fn commit_writer_child() {
        let Some(path) = std::env::var_os("VOSU_REALM_SYNTHETIC_WRITER") else {
            return;
        };
        let path = PathBuf::from(path);
        assert_eq!(path.file_name().unwrap(), "fixture-commits.realm");
        let cpath = CString::new(path.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { vosu_realm_test_commits(cpath.as_ptr(), 200) }, 0);
    }
    #[test]
    fn concurrent_real_commits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture-commits.realm");
        fixture(&path, false).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::commit_writer_child", "--nocapture"])
            .env("VOSU_REALM_SYNTHETIC_WRITER", &path)
            .spawn()
            .unwrap();
        let mut successful = 0;
        while child.try_wait().unwrap().is_none() {
            if let Ok(tables) = read(&path) {
                let generation = tables.rows["class_Beatmap"][0]["DifficultyName"]
                    .as_str()
                    .unwrap();
                let score = tables.rows["class_Score"][0]["TotalScore"]
                    .as_i64()
                    .unwrap();
                assert_eq!(
                    score,
                    if generation == "Generation A" {
                        100
                    } else {
                        200
                    },
                    "torn generation"
                );
                successful += 1;
            }
        }
        assert!(child.wait().unwrap().success());
        assert!(successful > 0);
    }
}
