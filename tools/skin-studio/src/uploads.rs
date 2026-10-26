//! Images dropped into Skin studio from the desktop. They are checked (name,
//! type, size) and kept in the tool's data folder as one more read-only
//! source, `uploads:`, that mix plans copy from like any library skin.

use crate::{Failure, failure};
use axum::http::StatusCode;
use std::{fs, io::Write, path::Path};

/// The library key of dropped files.
pub const KEY: &str = "uploads:";
/// The largest image accepted: vosu forwards at most 1 MiB of request body
/// to a tool (`MAX_POST_BODY` in vosu's src/server/routes.rs), so this is the
/// largest upload that can arrive at all.
pub const MAX_BYTES: u64 = 1024 * 1024;
/// File names that Windows reserves whatever the extension.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A dropped file's name: one path segment, portable to Windows, `.png`,
/// `.jpg` or `.jpeg`. Names that try to leave the folder are refused, not
/// rewritten.
pub fn name(name: &str) -> Result<&str, Failure> {
    if name.contains(['/', '\\']) || name == ".." || name.contains("..") {
        return Err(failure(format!("{name}: a file name, not a path")));
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    if !["png", "jpg", "jpeg"].contains(&ext.to_ascii_lowercase().as_str()) {
        return Err(failure(format!("{name}: only PNG and JPEG images")));
    }
    if stem.is_empty()
        || name.chars().count() > 120
        || name.starts_with(['.', ' '])
        || stem.ends_with([' ', '.'])
        || name
            .chars()
            .any(|c| c.is_control() || r#"<>:"|?*"#.contains(c))
        || RESERVED.contains(&stem.to_ascii_uppercase().as_str())
    {
        return Err(failure(format!("{name}: not a portable file name")));
    }
    Ok(name)
}

/// A drop's folder: 16 lower-case hex digits (the page derives them from the
/// dropped bytes, so dropping the same files again lands in the same place).
pub fn group(group: &str) -> Result<&str, Failure> {
    if group.len() == 16
        && group
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(group)
    } else {
        Err(failure("Invalid upload group"))
    }
}

/// The pixel size of a PNG or JPEG whose content matches its extension.
pub fn image(name: &str, bytes: &[u8]) -> Result<(u32, u32), Failure> {
    let png = !name.to_ascii_lowercase().ends_with(".jpg")
        && !name.to_ascii_lowercase().ends_with(".jpeg");
    let size = if png {
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(failure(format!("{name} is not a PNG image")));
        }
        png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .map(|reader| (reader.info().width, reader.info().height))
            .map_err(|e| failure(format!("{name} is not a readable PNG: {e}")))?
    } else {
        if !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            return Err(failure(format!("{name} is not a JPEG image")));
        }
        jpeg_size(bytes).ok_or_else(|| failure(format!("{name} is not a readable JPEG")))?
    };
    if size.0 == 0 || size.1 == 0 {
        return Err(failure(format!("{name} has no pixels")));
    }
    Ok(size)
}

/// Width and height from a JPEG's first start-of-frame segment.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xff {
            return None;
        }
        let marker = bytes[at + 1];
        if marker == 0xff {
            at += 1;
            continue;
        }
        let length = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            let frame = bytes.get(at + 5..at + 9)?;
            let height = u16::from_be_bytes([frame[0], frame[1]]) as u32;
            let width = u16::from_be_bytes([frame[2], frame[3]]) as u32;
            return Some((width, height));
        }
        at += 2 + length;
    }
    None
}

/// Stores a checked image as `<group>/<name>` under `dir` and returns that
/// name. The same bytes under the same name are kept; different bytes never
/// replace a stored file, and a name differing only in case from a stored
/// one is refused (they would be one file on Windows and in osu!'s lookups).
/// Every store marks the group as used now (see [`prune`]).
pub fn store(dir: &Path, group: &str, name: &str, bytes: &[u8]) -> Result<String, Failure> {
    let folder = dir.join(group);
    fs::create_dir_all(&folder).map_err(failure)?;
    // `.used` (no dropped name starts with a dot) records the last drop.
    fs::write(folder.join(USED), []).map_err(failure)?;
    for entry in fs::read_dir(&folder).map_err(failure)? {
        let other = entry.map_err(failure)?.file_name();
        let other = other.to_string_lossy();
        if other != name && other.eq_ignore_ascii_case(name) && !other.starts_with(".tmp") {
            return Err((
                StatusCode::CONFLICT,
                format!("{name} differs only in case from the dropped {other}."),
            ));
        }
    }
    let path = folder.join(name);
    if let Ok(existing) = fs::read(&path) {
        return if existing == bytes {
            Ok(format!("{group}/{name}"))
        } else {
            Err((
                StatusCode::CONFLICT,
                format!("{name} differs from the file already dropped under that name."),
            ))
        };
    }
    let mut temp = tempfile::NamedTempFile::new_in(&folder).map_err(failure)?;
    temp.write_all(bytes).map_err(failure)?;
    temp.as_file().sync_all().map_err(failure)?;
    temp.persist_noclobber(&path)
        .map_err(|e| failure(e.error))?;
    Ok(format!("{group}/{name}"))
}

/// Marks when a drop group was last used.
const USED: &str = ".used";
/// How long dropped files are kept after their last drop. Mix drafts live in
/// the page's storage, which the service cannot see; a draft naming a pruned
/// file gets an error when it builds and the file can be dropped again.
pub const KEEP: std::time::Duration = std::time::Duration::from_secs(90 * 24 * 60 * 60);

/// Removes drop groups not used for `keep` (abandoned uploads); returns how
/// many. Entries that are not groups are left alone.
pub fn prune(dir: &Path, keep: std::time::Duration) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let stale = fs::metadata(entry.path().join(USED))
            .or_else(|_| entry.metadata())
            .and_then(|m| m.modified())
            .is_ok_and(|at| at.elapsed().is_ok_and(|age| age > keep));
        if group(&name.to_string_lossy()).is_ok()
            && entry.file_type().is_ok_and(|t| t.is_dir())
            && stale
            && fs::remove_dir_all(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&vec![0; (width * height * 4) as usize])
            .unwrap();
        writer.finish().unwrap();
        out
    }
    /// SOI, an APP0 segment, then SOF0 for 3×2.
    const JPEG: [u8; 23] = [
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02,
        0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
    ];

    #[test]
    fn names_stay_one_portable_segment() {
        for good in [
            "note.png",
            "Receptor@2x.PNG",
            "hold-0.jpeg",
            "Baby Pink.jpg",
        ] {
            assert_eq!(name(good).unwrap(), good);
        }
        for bad in [
            "../note.png",
            "a/b.png",
            "a\\b.png",
            "..png",
            "note.gif",
            "note",
            ".png",
            "CON.png",
            "a:b.png",
            "note .png",
            "bell\u{7}.png",
        ] {
            assert!(name(bad).is_err(), "{bad}");
        }
        assert!(group("0123456789abcdef").is_ok());
        assert!(group("../../etc/passwd").is_err());
        assert!(group("0123456789ABCDEF").is_err());
    }

    #[test]
    fn content_must_match_the_extension() {
        assert_eq!(image("a.png", &png(4, 3)).unwrap(), (4, 3));
        assert_eq!(image("a.jpg", &JPEG).unwrap(), (3, 2));
        assert!(image("a.jpg", &png(1, 1)).is_err());
        assert!(image("a.png", &JPEG).is_err());
        assert!(image("a.png", b"\x89PNG\r\n\x1a\nbroken").is_err());
        assert!(image("a.png", b"GIF89a").is_err());
    }

    #[test]
    fn stored_once_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = png(2, 2);
        let stored = store(dir.path(), "0123456789abcdef", "n.png", &bytes).unwrap();
        assert_eq!(stored, "0123456789abcdef/n.png");
        assert_eq!(fs::read(dir.path().join(&stored)).unwrap(), bytes);
        assert!(store(dir.path(), "0123456789abcdef", "n.png", &bytes).is_ok());
        assert_eq!(
            store(dir.path(), "0123456789abcdef", "n.png", &png(3, 3))
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
    }

    #[test]
    fn case_collisions_and_size_cap() {
        let dir = tempfile::tempdir().unwrap();
        let group = "00000000000000aa";
        store(dir.path(), group, "Note.png", &png(1, 1)).unwrap();
        assert_eq!(
            store(dir.path(), group, "note.PNG", &png(1, 1))
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        // @2x and frames are separate names in one group.
        for name in ["Note@2x.png", "hold-0.png", "hold-1.png"] {
            store(dir.path(), group, name, &png(1, 1)).unwrap();
        }
        assert_eq!(MAX_BYTES, 1024 * 1024);
        for reserved in ["con.png", "Lpt9.JPG", "aux.jpeg"] {
            assert!(name(reserved).is_err(), "{reserved}");
        }
    }

    #[test]
    fn abandoned_groups_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        store(dir.path(), "00000000000000aa", "old.png", &png(1, 1)).unwrap();
        store(dir.path(), "00000000000000bb", "new.png", &png(1, 1)).unwrap();
        fs::create_dir(dir.path().join("not-a-group")).unwrap();
        let old = dir.path().join("00000000000000aa").join(USED);
        let past = std::time::SystemTime::now() - KEEP - std::time::Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(past)
            .unwrap();
        assert_eq!(prune(dir.path(), KEEP), 1);
        assert!(!dir.path().join("00000000000000aa").exists());
        assert!(dir.path().join("00000000000000bb/new.png").exists());
        assert!(dir.path().join("not-a-group").exists());
    }
}
