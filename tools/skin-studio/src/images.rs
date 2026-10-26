//! Exact row operations on PNG images for hit-position and hold-tail
//! calibration: rows move, appear (transparent) or go; no pixel is resampled.
//! Images are decoded with palette/gray expansion only, so 8- and 16-bit
//! channels keep their values, and written back as RGBA of the same depth.

use crate::{Failure, failure};
use serde::{Deserialize, Serialize};

struct Image {
    width: u32,
    /// Bytes per channel (1 or 2).
    depth: usize,
    rows: Vec<Vec<u8>>,
}

fn decode(bytes: &[u8]) -> Result<Image, Failure> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = decoder
        .read_info()
        .map_err(|e| failure(format!("Not a readable PNG: {e}")))?;
    if reader.info().animation_control().is_some() {
        return Err(failure("Animated PNGs are not supported here."));
    }
    let mut buffer = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or_else(|| failure("PNG too large"))?
    ];
    let frame = reader.next_frame(&mut buffer).map_err(failure)?;
    let (color, depth) = (frame.color_type, frame.bit_depth);
    if color != png::ColorType::Rgba && color != png::ColorType::GrayscaleAlpha {
        return Err(failure(format!("Unexpected PNG layout {color:?}")));
    }
    let depth = if depth == png::BitDepth::Sixteen {
        2
    } else {
        1
    };
    let channels = if color == png::ColorType::Rgba { 4 } else { 2 };
    let width = frame.width;
    let line = frame.line_size;
    let mut rows = Vec::with_capacity(frame.height as usize);
    for row in buffer[..line * frame.height as usize].chunks(line) {
        // Gray+alpha becomes RGBA with the same values (lossless).
        if channels == 2 {
            let mut rgba = Vec::with_capacity(width as usize * 4 * depth);
            for px in row.chunks(2 * depth) {
                let (g, a) = px.split_at(depth);
                rgba.extend_from_slice(g);
                rgba.extend_from_slice(g);
                rgba.extend_from_slice(g);
                rgba.extend_from_slice(a);
            }
            rows.push(rgba);
        } else {
            rows.push(row.to_vec());
        }
    }
    Ok(Image { width, depth, rows })
}

fn encode(image: &Image) -> Result<Vec<u8>, Failure> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, image.width, image.rows.len().max(1) as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(if image.depth == 2 {
        png::BitDepth::Sixteen
    } else {
        png::BitDepth::Eight
    });
    let mut writer = encoder.write_header().map_err(failure)?;
    let mut data = Vec::new();
    if image.rows.is_empty() {
        data.resize(image.width as usize * 4 * image.depth, 0);
    }
    for row in &image.rows {
        data.extend_from_slice(row);
    }
    writer.write_image_data(&data).map_err(failure)?;
    writer.finish().map_err(failure)?;
    Ok(out)
}

impl Image {
    fn blank(&self) -> Vec<u8> {
        vec![0; self.width as usize * 4 * self.depth]
    }
    /// Whether a row has no pixel with alpha above zero.
    fn clear(&self, row: &[u8]) -> bool {
        let px = 4 * self.depth;
        row.chunks(px)
            .all(|p| p[3 * self.depth..].iter().all(|&b| b == 0))
    }
    /// Fully transparent rows at the top and at the bottom.
    fn margins(&self) -> (usize, usize) {
        let top = self.rows.iter().take_while(|r| self.clear(r)).count();
        if top == self.rows.len() {
            return (top, 0);
        }
        let bottom = self.rows.iter().rev().take_while(|r| self.clear(r)).count();
        (top, bottom)
    }
}

/// Size and transparent margins of an image (rows, top and bottom).
#[derive(Serialize, Debug, PartialEq)]
pub struct Rows {
    pub width: u32,
    pub height: usize,
    pub top: usize,
    pub bottom: usize,
}
pub fn rows(bytes: &[u8]) -> Result<Rows, Failure> {
    let image = decode(bytes)?;
    let (top, bottom) = image.margins();
    Ok(Rows {
        width: image.width,
        height: image.rows.len(),
        top,
        bottom,
    })
}

/// What to do to an image.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    /// Move the content `up` rows up (negative: down) on a canvas of the
    /// same size. Rows vacated by the move repeat, per pixel column, the
    /// shifted content's adjacent row (edge clamp, alpha included): moving up,
    /// the rows freed at the bottom take the colour above them; moving down,
    /// the rows freed at the top take the colour below them. A solid stage
    /// under a receptor stays seamless; transparent columns stay transparent.
    /// Rows pushed past an edge go (counted when not transparent).
    Shift { up: i32 },
    /// A hold tail: drop transparent rows at the end (`at_top`: the image's
    /// top) that lies on the hold's end time, add `gap` transparent rows
    /// there, and size the far side so the body (drawn to half the tail's
    /// height) reaches the cap: `height ≥ 2 × gap`.
    Tail { gap: u32, at_top: bool },
    /// A transparent image as wide as the source and `rows` tall: a tail
    /// that shows nothing; the body reaches half its height past the end
    /// time (one row: a cut hold end).
    Spacer { rows: u32 },
    /// A percy hold body, `height` rows tall, its top on the hold's tail
    /// end: transparent rows, then the cap (the derive request's `cap`
    /// image, flipped as lazer draws tails in downscroll, transparent margins
    /// trimmed) with its bottom edge on row `cap_bottom`, then the body
    /// texture. The cap's pixels are exact; the body texture is sampled
    /// nearest-row and nearest-column into the new size (lazer stretches a
    /// repeating body over 32800 units anyway: render-core's mania notes).
    Percy { height: u32, cap_bottom: u32 },
}

/// The result of an [`Op`]: the new PNG and what it lost.
pub struct Derived {
    pub bytes: Vec<u8>,
    /// Non-transparent rows removed (a shift down past the bottom edge).
    pub lost: usize,
}

/// The tallest image an operation makes (lazer's 32800-unit body at under one
/// unit per row, with room).
pub const MAX_HEIGHT: u32 = 65_536;

pub fn apply(bytes: &[u8], op: Op, cap: Option<&[u8]>) -> Result<Derived, Failure> {
    let mut image = decode(bytes)?;
    let mut lost = 0;
    match op {
        Op::Shift { up } if up != 0 => {
            let height = image.rows.len();
            let moved = (up.unsigned_abs() as usize).min(height);
            let gone: Vec<_> = if up > 0 {
                image.rows.drain(..moved).collect()
            } else {
                image.rows.drain(height - moved..).collect()
            };
            lost = gone.iter().filter(|row| !image.clear(row)).count();
            // Edge clamp: the content row next to the vacated rows (if the
            // whole image moved out, the last row that left).
            let edge = if up > 0 {
                image
                    .rows
                    .last()
                    .unwrap_or_else(|| gone.last().unwrap())
                    .clone()
            } else {
                image
                    .rows
                    .first()
                    .unwrap_or_else(|| gone.first().unwrap())
                    .clone()
            };
            let fill = (0..moved).map(|_| edge.clone());
            if up > 0 {
                image.rows.extend(fill);
            } else {
                image.rows.splice(0..0, fill);
            }
        }
        Op::Shift { .. } => {}
        Op::Tail { gap, at_top } => {
            if !at_top {
                image.rows.reverse();
            }
            let (top, bottom) = image.margins();
            let height = image.rows.len();
            let cap: Vec<_> = if top == height {
                Vec::new()
            } else {
                image.rows.drain(top..height - bottom).collect()
            };
            let gap = gap as usize;
            let mut rows = Vec::with_capacity(gap * 2 + cap.len());
            let blank = image.blank();
            rows.extend((0..gap).map(|_| blank.clone()));
            let cap_len = cap.len();
            rows.extend(cap);
            rows.extend((gap + cap_len..2 * gap).map(|_| blank.clone()));
            if rows.is_empty() {
                rows.push(blank);
            }
            image.rows = rows;
            if !at_top {
                image.rows.reverse();
            }
        }
        Op::Spacer { rows } => {
            let blank = image.blank();
            image.rows = vec![blank; rows.clamp(1, MAX_HEIGHT) as usize];
        }
        Op::Percy { height, cap_bottom } => {
            if height == 0 || height > MAX_HEIGHT || cap_bottom > height {
                return Err(failure("Invalid percy body size."));
            }
            let mut cap = match cap {
                Some(bytes) => decode(bytes)?,
                None => Image {
                    width: image.width,
                    depth: image.depth,
                    rows: Vec::new(),
                },
            };
            if cap.depth != image.depth {
                return Err(failure("The tail and body images differ in bit depth."));
            }
            let (top, bottom) = cap.margins();
            let len = cap.rows.len();
            let mut cap_rows: Vec<_> = if top == len {
                Vec::new()
            } else {
                cap.rows.drain(top..len - bottom).collect()
            };
            cap_rows.reverse();
            let width = if cap_rows.is_empty() {
                image.width
            } else {
                cap.width
            };
            let px = 4 * image.depth;
            let source = std::mem::take(&mut image.rows);
            let (src_w, src_h) = (image.width as usize, source.len().max(1));
            image.width = width;
            let blank = image.blank();
            let start = (cap_bottom as usize).saturating_sub(cap_rows.len());
            let skipped = cap_rows.len() - (cap_bottom as usize - start);
            let mut rows = vec![blank; start];
            rows.extend(cap_rows.into_iter().skip(skipped));
            for i in cap_bottom as usize..height as usize {
                let src = &source[(i * src_h / height as usize).min(src_h - 1)];
                let row = if src_w == width as usize {
                    src.clone()
                } else {
                    (0..width as usize)
                        .flat_map(|x| {
                            let sx = x * src_w / width as usize;
                            src[sx * px..(sx + 1) * px].to_vec()
                        })
                        .collect()
                };
                rows.push(row);
            }
            image.rows = rows;
        }
    }
    Ok(Derived {
        bytes: encode(&image)?,
        lost,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An 8-bit RGBA image from rows of alpha values (colour = row index).
    fn png(alpha: &[&[u8]]) -> Vec<u8> {
        let image = Image {
            width: alpha[0].len() as u32,
            depth: 1,
            rows: alpha
                .iter()
                .enumerate()
                .map(|(y, row)| row.iter().flat_map(|&a| [y as u8, 7, 9, a]).collect())
                .collect(),
        };
        encode(&image).unwrap()
    }
    fn alpha(bytes: &[u8]) -> Vec<Vec<u8>> {
        decode(bytes)
            .unwrap()
            .rows
            .iter()
            .map(|r| r.chunks(4).map(|p| p[3]).collect())
            .collect()
    }

    /// RGBA rows of `(r, a)` pairs (g = 7, b = 9).
    fn image(rows: &[&[(u8, u8)]]) -> Vec<u8> {
        encode(&Image {
            width: rows[0].len() as u32,
            depth: 1,
            rows: rows
                .iter()
                .map(|row| row.iter().flat_map(|&(r, a)| [r, 7, 9, a]).collect())
                .collect(),
        })
        .unwrap()
    }
    fn pixels(bytes: &[u8]) -> Vec<Vec<(u8, u8)>> {
        decode(bytes)
            .unwrap()
            .rows
            .iter()
            .map(|r| r.chunks(4).map(|p| (p[0], p[3])).collect())
            .collect()
    }

    #[test]
    fn shift_up_fills_the_bottom_with_the_colour_above() {
        // An opaque vertical gradient, two pixel columns of different colour.
        let src = image(&[
            &[(10, 255), (110, 255)],
            &[(20, 255), (120, 200)],
            &[(30, 255), (130, 100)],
        ]);
        let out = apply(&src, Op::Shift { up: 2 }, None).unwrap();
        assert_eq!(
            pixels(&out.bytes),
            [
                vec![(30, 255), (130, 100)],
                vec![(30, 255), (130, 100)],
                vec![(30, 255), (130, 100)]
            ]
        );
        assert_eq!(out.lost, 2);
    }

    #[test]
    fn shift_down_fills_the_top_with_the_colour_below() {
        let src = image(&[&[(10, 255)], &[(20, 255)], &[(30, 255)]]);
        let out = apply(&src, Op::Shift { up: -1 }, None).unwrap();
        assert_eq!(
            pixels(&out.bytes),
            [vec![(10, 255)], vec![(10, 255)], vec![(20, 255)]]
        );
        assert_eq!(out.lost, 1);
    }

    #[test]
    fn transparent_columns_stay_transparent() {
        // A receptor with clear rows above and below it (the user's skin).
        let src = png(&[&[0, 0], &[255, 128], &[0, 0], &[0, 0]]);
        let up = apply(&src, Op::Shift { up: 1 }, None).unwrap();
        assert_eq!(
            alpha(&up.bytes),
            [vec![255, 128], vec![0, 0], vec![0, 0], vec![0, 0]]
        );
        assert_eq!(up.lost, 0);
        let down = apply(&src, Op::Shift { up: -2 }, None).unwrap();
        assert_eq!(
            alpha(&down.bytes),
            [vec![0, 0], vec![0, 0], vec![0, 0], vec![255, 128]]
        );
        // Exact pixels: the moved row keeps its colour.
        assert_eq!(&decode(&down.bytes).unwrap().rows[3][..4], &[1, 7, 9, 255]);
    }

    #[test]
    fn sixteen_bit_and_gray_stay_exact() {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 1, 2);
            encoder.set_color(png::ColorType::GrayscaleAlpha);
            encoder.set_depth(png::BitDepth::Sixteen);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&[0, 0, 0, 0, 0x12, 0x34, 0xfe, 0xdc])
                .unwrap();
        }
        let shifted = apply(&out, Op::Shift { up: 1 }, None).unwrap();
        let image = decode(&shifted.bytes).unwrap();
        assert_eq!(image.depth, 2);
        assert_eq!(
            image.rows[0],
            [0x12, 0x34, 0x12, 0x34, 0x12, 0x34, 0xfe, 0xdc]
        );
    }

    #[test]
    fn tail_gap_trims_and_sizes_for_the_body() {
        // A cap of 2 rows, a clear row before it (at the end line) and after.
        let src = png(&[&[0], &[255], &[200], &[0]]);
        assert_eq!(
            rows(&src).unwrap(),
            Rows {
                width: 1,
                height: 4,
                top: 1,
                bottom: 1
            }
        );
        // No gap: cap on the end line, nothing past it.
        assert_eq!(
            alpha(
                &apply(
                    &src,
                    Op::Tail {
                        gap: 0,
                        at_top: true
                    },
                    None
                )
                .unwrap()
                .bytes
            ),
            [vec![255], vec![200]]
        );
        // Gap 3 > cap: the far side grows to 2 × gap so the body reaches the cap.
        let late = alpha(
            &apply(
                &src,
                Op::Tail {
                    gap: 3,
                    at_top: true,
                },
                None,
            )
            .unwrap()
            .bytes,
        );
        assert_eq!(
            late,
            [vec![0], vec![0], vec![0], vec![255], vec![200], vec![0]]
        );
        // Upscroll: the end line is the image's bottom.
        let up = alpha(
            &apply(
                &src,
                Op::Tail {
                    gap: 1,
                    at_top: false,
                },
                None,
            )
            .unwrap()
            .bytes,
        );
        assert_eq!(up, [vec![255], vec![200], vec![0]]);
        assert_eq!(
            alpha(&apply(&src, Op::Spacer { rows: 1 }, None).unwrap().bytes),
            [vec![0]]
        );
    }

    #[test]
    fn percy_body_puts_the_flipped_cap_above_the_release_row() {
        // Tail cap: rows 10 (top of the file) and 20, a clear row below.
        let cap = image(&[
            &[(10, 255), (11, 255)],
            &[(20, 255), (21, 255)],
            &[(0, 0), (0, 0)],
        ]);
        // A one-row body texture, one pixel wide: sampled to the cap's width.
        let body = image(&[&[(99, 128)]]);
        let out = apply(
            &body,
            Op::Percy {
                height: 6,
                cap_bottom: 3,
            },
            Some(&cap),
        )
        .unwrap();
        assert_eq!(
            pixels(&out.bytes),
            [
                vec![(0, 0), (0, 0)],
                // Flipped: lazer draws the tail file upside down in downscroll.
                vec![(20, 255), (21, 255)],
                vec![(10, 255), (11, 255)],
                vec![(99, 128), (99, 128)],
                vec![(99, 128), (99, 128)],
                vec![(99, 128), (99, 128)],
            ]
        );
        assert!(
            apply(
                &body,
                Op::Percy {
                    height: 2,
                    cap_bottom: 3
                },
                None
            )
            .is_err()
        );
    }
}
