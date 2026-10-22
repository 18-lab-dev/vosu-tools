//! Animated element previews: osu! frame sequences (`name-0.png`,
//! `name-1.png`, … or `name0.png` for elements such as `sliderb`) assembled
//! into one APNG at the skin's AnimationFramerate and cached in the tool's
//! cache directory.

use crate::library::FileEntry;
use sha2::{Digest, Sha256};
use std::{io::Cursor, path::Path};

pub const MAX_FRAMES: usize = 240;
const MAX_SIDE: u32 = 2048;

/// Frame file names (preferring @2x when every frame has one), in order.
pub fn frames(files: &[FileEntry], element: &str) -> Vec<String> {
    let element = element.to_lowercase();
    let mut best: Vec<String> = Vec::new();
    for separator in ["-", ""] {
        for hd in [true, false] {
            let mut found = Vec::new();
            for index in 0..MAX_FRAMES {
                let want = format!(
                    "{element}{separator}{index}{}.png",
                    if hd { "@2x" } else { "" }
                );
                match files.iter().find(|f| f.name.to_lowercase() == want) {
                    Some(file) => found.push(file.name.clone()),
                    None => break,
                }
            }
            if found.len() > best.len() {
                best = found;
            }
        }
    }
    if best.len() < 2 { Vec::new() } else { best }
}

/// Frames per second for a frame count: AnimationFramerate when positive,
/// otherwise the whole sequence plays over one second (stable's default).
pub fn fps(framerate: Option<i64>, count: usize) -> u16 {
    match framerate {
        Some(rate) if rate > 0 => rate.min(240) as u16,
        _ => count.clamp(1, 240) as u16,
    }
}

/// `AnimationFramerate` from skin.ini `[General]`.
pub fn framerate(ini: &str) -> Option<i64> {
    let mut general = false;
    for line in ini.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[') {
            general = header.trim_end_matches(']').trim() == "General";
        } else if general
            && let Some((key, value)) = line.split_once(':')
            && key.trim() == "AnimationFramerate"
        {
            return value.trim().parse().ok();
        }
    }
    None
}

pub fn cache_key(frames: &[Vec<u8>], fps: u16) -> String {
    let mut hash = Sha256::new();
    hash.update(fps.to_le_bytes());
    for frame in frames {
        hash.update((frame.len() as u64).to_le_bytes());
        hash.update(frame);
    }
    format!("{:x}", hash.finalize())
}

struct Rgba {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

fn decode(bytes: &[u8]) -> Result<Rgba, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(
        png::Transformations::EXPAND | png::Transformations::STRIP_16 | png::Transformations::ALPHA,
    );
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width > MAX_SIDE || height > MAX_SIDE {
        return Err(format!("frame {width}×{height} exceeds {MAX_SIDE}px"));
    }
    let mut buffer = vec![0; reader.output_buffer_size().ok_or("frame too large")?];
    let info = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    buffer.truncate(info.buffer_size());
    let pixels = match info.color_type {
        png::ColorType::Rgba => buffer,
        png::ColorType::GrayscaleAlpha => buffer
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        other => return Err(format!("unsupported frame colour type {other:?}")),
    };
    Ok(Rgba {
        width,
        height,
        pixels,
    })
}

/// Encodes frames as a looping APNG; frames of different sizes are centred
/// on a canvas of the largest frame, as osu! draws them around one origin.
pub fn encode(frames: &[Vec<u8>], fps: u16) -> Result<Vec<u8>, String> {
    let decoded = frames
        .iter()
        .map(|f| decode(f))
        .collect::<Result<Vec<_>, _>>()?;
    let width = decoded.iter().map(|f| f.width).max().unwrap_or(1).max(1);
    let height = decoded.iter().map(|f| f.height).max().unwrap_or(1).max(1);
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder
            .set_animated(decoded.len() as u32, 0)
            .map_err(|e| e.to_string())?;
        encoder.set_frame_delay(1, fps).map_err(|e| e.to_string())?;
        encoder
            .set_dispose_op(png::DisposeOp::Background)
            .map_err(|e| e.to_string())?;
        encoder
            .set_blend_op(png::BlendOp::Source)
            .map_err(|e| e.to_string())?;
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        let mut canvas = vec![0u8; (width * height * 4) as usize];
        for frame in &decoded {
            canvas.fill(0);
            let (x0, y0) = ((width - frame.width) / 2, (height - frame.height) / 2);
            let row = (frame.width * 4) as usize;
            for y in 0..frame.height {
                let src = (y * frame.width * 4) as usize;
                let dst = (((y0 + y) * width + x0) * 4) as usize;
                canvas[dst..dst + row].copy_from_slice(&frame.pixels[src..src + row]);
            }
            writer
                .write_image_data(&canvas)
                .map_err(|e| e.to_string())?;
        }
        writer.finish().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Returns the cached APNG for these frames, encoding it on a miss.
pub fn cached(cache_dir: &Path, frames: &[Vec<u8>], fps: u16) -> Result<Vec<u8>, String> {
    let dir = cache_dir.join("animations");
    let path = dir.join(format!("{}.png", cache_key(frames, fps)));
    if let Ok(bytes) = std::fs::read(&path) {
        return Ok(bytes);
    }
    let bytes = encode(frames, fps)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut temp, &bytes).map_err(|e| e.to_string())?;
    temp.persist(&path).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&rgba.repeat((width * height) as usize))
            .unwrap();
        writer.finish().unwrap();
        out
    }
    fn entry(name: &str) -> FileEntry {
        FileEntry {
            name: name.into(),
            size: 1,
        }
    }

    #[test]
    fn finds_dash_and_plain_sequences() {
        let files = [
            "hit300-0.png",
            "hit300-1.png",
            "hit300-2.png",
            "hit300-0@2x.png",
            "sliderb0.png",
            "sliderb1.png",
            "SliderB2.png",
            "cursor.png",
        ]
        .map(entry);
        assert_eq!(frames(&files, "hit300").len(), 3);
        assert_eq!(frames(&files, "hit300")[0], "hit300-0.png");
        assert_eq!(
            frames(&files, "sliderb"),
            ["sliderb0.png", "sliderb1.png", "SliderB2.png"]
        );
        assert!(frames(&files, "cursor").is_empty());
    }
    #[test]
    fn framerate_rules() {
        assert_eq!(framerate("[General]\nAnimationFramerate: 30\n"), Some(30));
        assert_eq!(framerate("[Colours]\nAnimationFramerate: 30\n"), None);
        assert_eq!(fps(Some(30), 5), 30);
        assert_eq!(fps(Some(-1), 12), 12);
        assert_eq!(fps(None, 4), 4);
    }
    #[test]
    fn encodes_centred_apng_and_caches() {
        let frames = vec![png(4, 4, [255, 0, 0, 255]), png(2, 2, [0, 0, 255, 128])];
        let bytes = encode(&frames, 10).unwrap();
        let mut reader = png::Decoder::new(Cursor::new(&bytes)).read_info().unwrap();
        let animation = reader.info().animation_control.unwrap();
        assert_eq!(animation.num_frames, 2);
        assert_eq!((reader.info().width, reader.info().height), (4, 4));
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut buf).unwrap();
        assert_eq!(&buf[..4], &[255, 0, 0, 255]);
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(cached(dir.path(), &frames, 10).unwrap(), bytes);
        assert_eq!(
            std::fs::read_dir(dir.path().join("animations"))
                .unwrap()
                .count(),
            1
        );
    }
}
