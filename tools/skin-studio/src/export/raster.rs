//! Image work for the Quaver and Etterna exports: decoding skin images,
//! resampling with premultiplied alpha, flips, padding, centred frame
//! canvases, sprite sheets, PNG encoding, and the plain shapes drawn where
//! osu! would use its built-in look (the shapes of render-core's classic
//! mania look, `packages/render-core/src/builtin.ts` `legacyMania`).

use image::{
    ImageEncoder, ImageReader, Limits, RgbaImage,
    codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder},
    imageops::{self, FilterType},
};
use std::io::Cursor;

/// The largest image side read from a skin or written to an export.
pub const MAX_SIDE: u32 = 8192;

/// An image and its pixel density: pixels per display unit (`2` for an
/// osu! `@2x` file, whose display size is half its pixel size).
#[derive(Clone)]
pub struct Img {
    pub pixels: RgbaImage,
    pub density: f32,
}
impl Img {
    pub fn width(&self) -> f32 {
        self.pixels.width() as f32 / self.density
    }
    pub fn height(&self) -> f32 {
        self.pixels.height() as f32 / self.density
    }
}

/// Decodes a PNG or JPEG (by content) into RGBA.
pub fn decode(bytes: &[u8]) -> Result<RgbaImage, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    Ok(reader.decode().map_err(|e| e.to_string())?.into_rgba8())
}

/// Encodes RGBA as PNG.
pub fn encode(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Default, PngFilter::Adaptive)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// A transparent 1×1 image: drawn, so the target uses no default of its own
/// where osu! would draw nothing.
pub fn transparent() -> RgbaImage {
    RgbaImage::new(1, 1)
}

fn premultiply(image: &mut RgbaImage) {
    for p in image.pixels_mut() {
        let a = p[3] as u32;
        for c in 0..3 {
            p[c] = ((p[c] as u32 * a + 127) / 255) as u8;
        }
    }
}
fn unpremultiply(image: &mut RgbaImage) {
    for p in image.pixels_mut() {
        let a = p[3] as u32;
        if a == 0 {
            p.0 = [0; 4];
            continue;
        }
        for c in 0..3 {
            p[c] = ((p[c] as u32 * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

/// Resamples to `width`×`height` pixels (at least 1×1, at most
/// [`MAX_SIDE`]); colours are filtered premultiplied, so transparent pixels
/// do not darken edges.
pub fn resize(image: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    let (width, height) = (width.clamp(1, MAX_SIDE), height.clamp(1, MAX_SIDE));
    if image.dimensions() == (width, height) {
        return image.clone();
    }
    let mut source = image.clone();
    premultiply(&mut source);
    let mut out = imageops::resize(&source, width, height, FilterType::CatmullRom);
    unpremultiply(&mut out);
    out
}

/// Pixel count for `units` display units at `density`, at least one.
pub fn px(units: f32, density: f32) -> u32 {
    (units * density).round().clamp(1.0, MAX_SIDE as f32) as u32
}

pub fn flip_vertical(image: &RgbaImage) -> RgbaImage {
    imageops::flip_vertical(image)
}

/// `image` on a canvas `height` pixels tall, aligned to the canvas bottom
/// (transparent rows above); unchanged when it is that tall already.
pub fn pad_top(image: &RgbaImage, height: u32) -> RgbaImage {
    if image.height() >= height {
        return image.clone();
    }
    let mut out = RgbaImage::new(image.width(), height);
    imageops::replace(&mut out, image, 0, (height - image.height()) as i64);
    out
}

/// Frames centred on a canvas of the largest frame, as osu! draws an
/// animation's frames around one origin.
pub fn centred(frames: &[RgbaImage]) -> Vec<RgbaImage> {
    let width = frames.iter().map(|f| f.width()).max().unwrap_or(1).max(1);
    let height = frames.iter().map(|f| f.height()).max().unwrap_or(1).max(1);
    frames
        .iter()
        .map(|frame| {
            if frame.dimensions() == (width, height) {
                return frame.clone();
            }
            let mut out = RgbaImage::new(width, height);
            imageops::replace(
                &mut out,
                frame,
                ((width - frame.width()) / 2) as i64,
                ((height - frame.height()) / 2) as i64,
            );
            out
        })
        .collect()
}

/// Rows and columns of a sheet of `count` frames of `width`×`height`: exactly
/// `count` cells (both games play every cell of a sheet as a frame), a
/// single row when it fits within `max_side`, else the divisor pair whose
/// sheet has the shortest longest side.
pub fn sheet_layout(count: u32, width: u32, height: u32, max_side: u32) -> (u32, u32) {
    let count = count.max(1);
    if count.saturating_mul(width) <= max_side {
        return (1, count);
    }
    (1..=count)
        .filter(|rows| count % rows == 0)
        .map(|rows| (rows, count / rows))
        .min_by_key(|&(rows, columns)| {
            (columns.saturating_mul(width)).max(rows.saturating_mul(height))
        })
        .unwrap_or((1, count))
}

/// Frames of equal size laid out left to right, top to bottom.
pub fn sheet(frames: &[RgbaImage], rows: u32, columns: u32) -> RgbaImage {
    let (width, height) = frames.first().map_or((1, 1), |f| f.dimensions());
    let mut out = RgbaImage::new(width * columns, height * rows);
    for (i, frame) in frames.iter().enumerate() {
        let (row, column) = (i as u32 / columns, i as u32 % columns);
        imageops::replace(
            &mut out,
            frame,
            (column * width) as i64,
            (row * height) as i64,
        );
    }
    out
}

/// A sheet of `frames` that fits [`MAX_SIDE`]: frames are scaled down
/// uniformly when even the most compact layout would not fit.
pub fn fitted_sheet(frames: &[RgbaImage]) -> (RgbaImage, u32, u32) {
    let frames = centred(frames);
    let (width, height) = frames[0].dimensions();
    let (rows, columns) = sheet_layout(frames.len() as u32, width, height, MAX_SIDE);
    let side = (columns * width).max(rows * height);
    let frames = if side > MAX_SIDE {
        let scale = MAX_SIDE as f32 / side as f32;
        let (w, h) = (
            ((width as f32 * scale).floor() as u32).max(1),
            ((height as f32 * scale).floor() as u32).max(1),
        );
        frames.iter().map(|f| resize(f, w, h)).collect()
    } else {
        frames
    };
    (sheet(&frames, rows, columns), rows, columns)
}

/// A column's kind behind osu!'s default names (`mania-note1`, `2`, `S`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
pub enum Kind {
    #[serde(rename = "1")]
    One,
    #[serde(rename = "2")]
    Two,
    #[serde(rename = "S")]
    Special,
}
impl Kind {
    /// render-core's classic accents: white, blue, and a yellow centre.
    fn accent(self) -> [f32; 3] {
        match self {
            Kind::One => [236.0, 236.0, 236.0],
            Kind::Two => [84.0, 156.0, 255.0],
            Kind::Special => [255.0, 212.0, 64.0],
        }
    }
}

/// The built-in shapes: a note, hold head or tail, hold body, key, or
/// pressed key.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Shape {
    Note,
    Tail,
    Body,
    Key,
    KeyDown,
}

/// Pixels per display unit of the generated shapes.
pub const SHAPE_DENSITY: f32 = 4.0;

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t)
}
fn lighten(c: [f32; 3], t: f32) -> [f32; 3] {
    mix(c, [255.0; 3], t)
}
fn darken(c: [f32; 3], t: f32) -> [f32; 3] {
    mix(c, [0.0; 3], t)
}
/// A colour at `t` (0 top, 1 bottom) of a vertical gradient through `stops`.
fn gradient(stops: &[(f32, [f32; 3])], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    for pair in stops.windows(2) {
        let ((t0, c0), (t1, c1)) = (pair[0], pair[1]);
        if t <= t1 {
            return mix(c0, c1, if t1 > t0 { (t - t0) / (t1 - t0) } else { 0.0 });
        }
    }
    stops.last().map_or([0.0; 3], |s| s.1)
}

/// Coverage of a rounded rectangle at one pixel, 4×4 supersampled.
fn coverage(x: u32, y: u32, rect: [f32; 4], radius: f32) -> f32 {
    let [left, top, width, height] = rect;
    let (right, bottom) = (left + width, top + height);
    let mut inside = 0;
    for sy in 0..4 {
        for sx in 0..4 {
            let px = x as f32 + (sx as f32 + 0.5) / 4.0;
            let py = y as f32 + (sy as f32 + 0.5) / 4.0;
            if px < left || px > right || py < top || py > bottom {
                continue;
            }
            let cx = px.clamp(left + radius, right - radius);
            let cy = py.clamp(top + radius, bottom - radius);
            if (px - cx).powi(2) + (py - cy).powi(2) <= radius * radius {
                inside += 1;
            }
        }
    }
    inside as f32 / 16.0
}

/// Paints a rounded rectangle (display units) over `image`.
fn fill(
    image: &mut RgbaImage,
    rect: [f32; 4],
    radius: f32,
    alpha: f32,
    colour: impl Fn(f32) -> [f32; 3],
) {
    let rect = rect.map(|v| v * SHAPE_DENSITY);
    let radius = radius * SHAPE_DENSITY;
    let height = image.height() as f32;
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let cover = coverage(x, y, rect, radius) * alpha;
        if cover <= 0.0 {
            continue;
        }
        let c = colour((y as f32 + 0.5) / height);
        // Source-over onto what is there.
        let below = pixel.0.map(|v| v as f32 / 255.0);
        let out_a = cover + below[3] * (1.0 - cover);
        let blend = |i: usize| {
            if out_a <= 0.0 {
                0.0
            } else {
                (c[i] / 255.0 * cover + below[i] * below[3] * (1.0 - cover)) / out_a
            }
        };
        pixel.0 = [
            (blend(0) * 255.0).round() as u8,
            (blend(1) * 255.0).round() as u8,
            (blend(2) * 255.0).round() as u8,
            (out_a * 255.0).round() as u8,
        ];
    }
}

/// One built-in shape for a column of `kind`, at [`SHAPE_DENSITY`]: notes
/// 30×10 units, bodies 30×30, keys 30×124.8 (the distance from the default
/// HitPosition 402 to the stage's bottom edge), as render-core draws them.
pub fn shape(shape: Shape, kind: Kind) -> Img {
    let accent = kind.accent();
    let (width, height) = match shape {
        Shape::Note | Shape::Tail => (30.0, 10.0),
        Shape::Body => (30.0, 30.0),
        Shape::Key | Shape::KeyDown => (30.0, 78.0 * 1.6),
    };
    let mut pixels = RgbaImage::new(px(width, SHAPE_DENSITY), px(height, SHAPE_DENSITY));
    match shape {
        Shape::Note | Shape::Tail => {
            let stops = [
                (0.0, lighten(accent, 0.4)),
                (0.5, accent),
                (1.0, darken(accent, 0.5)),
            ];
            fill(&mut pixels, [0.5, 0.5, 29.0, 9.0], 2.0, 1.0, |t| {
                gradient(&stops, t)
            });
            if shape == Shape::Tail {
                fill(&mut pixels, [0.5, 0.5, 29.0, 2.0], 1.0, 0.5, |_| [255.0; 3]);
            }
        }
        Shape::Body => fill(&mut pixels, [3.0, 0.0, 24.0, 30.0], 0.0, 0.75, |_| accent),
        Shape::Key | Shape::KeyDown => {
            let stops = if shape == Shape::KeyDown {
                [(0.0, lighten(accent, 0.2)), (1.0, darken(accent, 0.6))]
            } else {
                [(0.0, [91.0, 91.0, 96.0]), (1.0, [42.0, 42.0, 46.0])]
            };
            fill(&mut pixels, [1.0, 3.2, 28.0, 118.4], 4.8, 1.0, |t| {
                gradient(&stops, t)
            });
            fill(&mut pixels, [4.0, 9.6, 22.0, 6.4], 3.2, 0.35, |_| {
                [255.0; 3]
            });
        }
    }
    Img {
        pixels,
        density: SHAPE_DENSITY,
    }
}

/// A horizontal strip of colours (one segment per entry, `segment` pixels
/// wide, one pixel tall) for a stage background stretched over the columns.
pub fn strip(colours: &[[u8; 4]], segment: u32) -> RgbaImage {
    let mut out = RgbaImage::new((colours.len() as u32 * segment).max(1), 1);
    for (x, _, pixel) in out.enumerate_pixels_mut() {
        if let Some(colour) = colours.get((x / segment) as usize) {
            pixel.0 = *colour;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(width, height, image::Rgba(rgba))
    }

    #[test]
    fn png_round_trip() {
        let image = solid(3, 2, [10, 20, 30, 40]);
        let back = decode(&encode(&image).unwrap()).unwrap();
        assert_eq!(back, image);
        assert!(decode(b"not an image").is_err());
    }
    #[test]
    fn resize_keeps_colour_at_transparent_edges() {
        let mut image = RgbaImage::new(4, 1);
        image.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 0, image::Rgba([255, 0, 0, 255]));
        let out = resize(&image, 8, 1);
        for p in out.pixels().filter(|p| p[3] > 0) {
            // Premultiplied filtering: no dark fringe from the transparent black.
            assert!(p[0] >= 250 && p[1] == 0, "{p:?}");
        }
    }
    #[test]
    fn sheet_layouts_use_exactly_the_frames() {
        assert_eq!(sheet_layout(8, 100, 100, 8192), (1, 8));
        // 60 frames of 256 px do not fit one row of 8192: the most compact
        // exact factorisation (6 rows × 10 columns).
        assert_eq!(sheet_layout(60, 256, 256, 8192), (6, 10));
        // Wide frames of a prime count stack in one column instead.
        assert_eq!(sheet_layout(7, 2000, 10, 8192), (7, 1));
        let frames: Vec<_> = (0..3).map(|i| solid(2, 1, [i * 80, 0, 0, 255])).collect();
        let out = sheet(&frames, 1, 3);
        assert_eq!(out.dimensions(), (6, 1));
        assert_eq!(out.get_pixel(4, 0)[0], 160);
        // No exact layout fits two 5000 px frames: they are scaled down.
        let big: Vec<_> = (0..2).map(|_| solid(5000, 5000, [1, 2, 3, 255])).collect();
        let (fitted, rows, columns) = fitted_sheet(&big);
        assert_eq!(rows * columns, 2);
        assert!(
            fitted.width() <= MAX_SIDE && fitted.height() <= MAX_SIDE,
            "{:?}",
            fitted.dimensions()
        );
    }
    #[test]
    fn centres_and_pads() {
        let frames = centred(&[solid(4, 4, [9; 4]), solid(2, 2, [7; 4])]);
        assert_eq!(frames[1].dimensions(), (4, 4));
        assert_eq!(frames[1].get_pixel(1, 1).0, [7; 4]);
        assert_eq!(frames[1].get_pixel(0, 0).0, [0; 4]);
        let padded = pad_top(&solid(2, 3, [5; 4]), 5);
        assert_eq!(padded.dimensions(), (2, 5));
        assert_eq!(padded.get_pixel(0, 1).0, [0; 4]);
        assert_eq!(padded.get_pixel(0, 4).0, [5; 4]);
    }
    #[test]
    fn shapes_have_the_classic_sizes() {
        let note = shape(Shape::Note, Kind::Two);
        assert_eq!((note.width(), note.height()), (30.0, 10.0));
        let key = shape(Shape::Key, Kind::One);
        assert_eq!(key.width(), 30.0);
        assert!((key.height() - 124.75).abs() < 0.3, "{}", key.height());
        // The note is opaque in the middle and transparent outside its rounding.
        assert_eq!(note.pixels.get_pixel(60, 20)[3], 255);
        assert_eq!(note.pixels.get_pixel(0, 0)[3], 0);
        let strip = strip(&[[1, 2, 3, 4], [5, 6, 7, 8]], 3);
        assert_eq!(strip.dimensions(), (6, 1));
        assert_eq!(strip.get_pixel(4, 0).0, [5, 6, 7, 8]);
    }
}
