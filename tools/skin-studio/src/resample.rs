//! Resampling for "Keep proportions when changing column width": a scaled
//! receptor or note must look like the original drawn at another size, with
//! no visible filtering artifacts.
//!
//! - **Linear light, premultiplied alpha**: sRGB channels are decoded to
//!   linear light and multiplied by alpha before filtering, so transparent
//!   pixels (whose colour is arbitrary) never bleed dark or coloured fringes
//!   into edges, and edges blend the way light does.
//! - **Lanczos-3, separable**, both directions. Downscaling widens the kernel
//!   by 1/scale (a proper low-pass, so thin lines become fainter instead of
//!   aliasing); upscaling uses it at unit width.
//! - **No ringing**: every output sample is clamped to the range of the
//!   source samples under the kernel's main lobe, which removes Lanczos'
//!   overshoot halos (bright/dark rims on hard edges) while keeping its
//!   sharpness elsewhere.
//! - **Edges clamp**: samples past the image edge repeat the edge pixel, as
//!   lazer's ClampToEdge does (and the receptor shift's edge-clamp fill).
//!
//! Geometry: the output is `width × height`; horizontally the source spans
//! the whole output (key images and notes are stretched to the column width
//! anyway); vertically the content is anchored to the bottom edge, scaled by
//! `scale_y` and moved `up` output pixels (fractions included), since lazer
//! draws key images and notes from their bottom edge.

/// Linear-light premultiplied RGBA, row-major.
pub struct Linear {
    pub width: usize,
    pub height: usize,
    pub px: Vec<[f32; 4]>,
}

fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}
fn linear_to_srgb(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

impl Linear {
    /// From RGBA rows of `depth` bytes per channel (big-endian when 2, as PNG).
    pub fn from_rows(width: usize, depth: usize, rows: &[Vec<u8>]) -> Self {
        let max = if depth == 2 { 65535.0 } else { 255.0 };
        let lut: Vec<f32> = (0..256).map(|v| srgb_to_linear(v as f32 / 255.0)).collect();
        let mut px = Vec::with_capacity(width * rows.len());
        for row in rows {
            for p in row.chunks(4 * depth) {
                let ch = |i: usize| -> u32 {
                    if depth == 2 {
                        u16::from_be_bytes([p[2 * i], p[2 * i + 1]]) as u32
                    } else {
                        p[i] as u32
                    }
                };
                let a = ch(3) as f32 / max;
                let lin = |i: usize| {
                    if depth == 1 {
                        lut[ch(i) as usize]
                    } else {
                        srgb_to_linear(ch(i) as f32 / max)
                    }
                };
                px.push([lin(0) * a, lin(1) * a, lin(2) * a, a]);
            }
        }
        Self {
            width,
            height: rows.len(),
            px,
        }
    }

    /// Back to RGBA rows of `depth` bytes per channel.
    pub fn to_rows(&self, depth: usize) -> Vec<Vec<u8>> {
        let max = if depth == 2 { 65535.0 } else { 255.0 };
        self.px
            .chunks(self.width.max(1))
            .map(|row| {
                let mut out = Vec::with_capacity(row.len() * 4 * depth);
                for &[r, g, b, a] in row {
                    let a = a.clamp(0.0, 1.0);
                    let colour = |c: f32| {
                        if a <= 0.0 {
                            0.0
                        } else {
                            linear_to_srgb((c / a).clamp(0.0, 1.0))
                        }
                    };
                    for v in [colour(r), colour(g), colour(b), a] {
                        let q = (v * max).round() as u32;
                        if depth == 2 {
                            out.extend_from_slice(&(q as u16).to_be_bytes());
                        } else {
                            out.push(q as u8);
                        }
                    }
                }
                out
            })
            .collect()
    }
}

fn lanczos3(x: f32) -> f32 {
    let x = x.abs();
    if x < 1e-6 {
        return 1.0;
    }
    if x >= 3.0 {
        return 0.0;
    }
    let pi = std::f32::consts::PI * x;
    3.0 * pi.sin() * (pi / 3.0).sin() / (pi * pi)
}

/// One output sample's taps: first source index, weights (normalised), and
/// the main-lobe range of taps (for the ringing clamp).
struct Taps {
    first: usize,
    weights: Vec<f32>,
    lobe: (usize, usize),
}

/// Taps for `out_len` outputs over `src_len` sources, where output centre
/// `o + 0.5` maps to source coordinate `map(o)` (pixel centres at `i + 0.5`)
/// and one source pixel spans `scale` output pixels.
fn taps(src_len: usize, out_len: usize, scale: f64, map: impl Fn(usize) -> f64) -> Vec<Taps> {
    let filter = scale.min(1.0); // kernel units per source pixel
    let radius = 3.0 / filter;
    (0..out_len)
        .map(|o| {
            let centre = map(o);
            let lo = (centre - radius).floor() as i64;
            let hi = (centre + radius).ceil() as i64;
            let (mut weights, mut idx) = (Vec::new(), Vec::new());
            for i in lo..=hi {
                let w = lanczos3(((i as f64 + 0.5 - centre) * filter) as f32);
                if w != 0.0 {
                    weights.push(w);
                    idx.push(i.clamp(0, src_len as i64 - 1) as usize);
                }
            }
            let sum: f32 = weights.iter().sum();
            for w in &mut weights {
                *w /= sum;
            }
            // Collapse clamped indices into a contiguous run from `first`.
            let first = *idx.iter().min().unwrap_or(&0);
            let last = *idx.iter().max().unwrap_or(&0);
            let mut dense = vec![0.0; last - first + 1];
            for (w, i) in weights.iter().zip(&idx) {
                dense[i - first] += w;
            }
            // Main lobe: source pixels within one kernel unit of the centre.
            let reach = 1.0 / filter;
            let lobe_lo = ((centre - reach).floor().max(0.0) as usize).clamp(first, last);
            let lobe_hi = (((centre + reach).ceil() as i64 - 1).max(0) as usize).clamp(first, last);
            Taps {
                first,
                weights: dense,
                lobe: (lobe_lo.min(lobe_hi), lobe_hi.max(lobe_lo)),
            }
        })
        .collect()
}

/// One separable pass: `lines` lines of `src_len` samples, stride `step`
/// between samples and `line_step` between lines, into `out_len` samples.
fn pass(
    src: &[[f32; 4]],
    lines: usize,
    src_len: usize,
    taps: &[Taps],
    clamp: bool,
    at: impl Fn(usize, usize) -> usize,
) -> Vec<[f32; 4]> {
    let out_len = taps.len();
    let mut out = vec![[0.0; 4]; lines * out_len];
    for line in 0..lines {
        for (o, t) in taps.iter().enumerate() {
            let mut acc = [0.0f32; 4];
            for (k, w) in t.weights.iter().enumerate() {
                let p = src[at(line, t.first + k)];
                for c in 0..4 {
                    acc[c] += w * p[c];
                }
            }
            // Clamp to the main lobe's range: no overshoot halos.
            if clamp {
                let (mut lo, mut hi) = ([f32::MAX; 4], [f32::MIN; 4]);
                for i in t.lobe.0..=t.lobe.1.min(src_len - 1) {
                    let p = src[at(line, i)];
                    for c in 0..4 {
                        lo[c] = lo[c].min(p[c]);
                        hi[c] = hi[c].max(p[c]);
                    }
                }
                for c in 0..4 {
                    acc[c] = acc[c].clamp(lo[c], hi[c]);
                }
            }
            for v in &mut acc {
                *v = v.max(0.0);
            }
            // Premultiplied colour never exceeds alpha.
            for c in 0..3 {
                acc[c] = acc[c].min(acc[3]);
            }
            out[line * out_len + o] = acc;
        }
    }
    out
}

/// Resamples `src` to `width × height`: horizontally the whole source fits
/// the output; vertically it is anchored to the bottom, scaled by `scale_y`
/// (output pixels per source pixel) and moved up `up` output pixels.
pub fn resize(src: &Linear, width: usize, height: usize, scale_y: f64, up: f64) -> Linear {
    resize_with(src, width, height, scale_y, up, true)
}
pub(crate) fn resize_with(
    src: &Linear,
    width: usize,
    height: usize,
    scale_y: f64,
    up: f64,
    clamp: bool,
) -> Linear {
    let scale_x = width as f64 / src.width as f64;
    let (sw, sh) = (src.width, src.height);
    let xt = taps(sw, width, scale_x, |o| (o as f64 + 0.5) / scale_x);
    let horizontal = pass(&src.px, sh, sw, &xt, clamp, |line, i| line * sw + i);
    // Output row `o` is `height - o - 0.5` above the bottom edge; content
    // `d` above the source's bottom lands at `d * scale_y + up`.
    let yt = taps(sh, height, scale_y, |o| {
        let above = height as f64 - (o as f64 + 0.5);
        sh as f64 - (above - up) / scale_y
    });
    // Columns of the horizontally resampled image.
    let vertical = pass(&horizontal, width, sh, &yt, clamp, |line, i| {
        i * width + line
    });
    let mut px = vec![[0.0; 4]; width * height];
    for x in 0..width {
        for y in 0..height {
            px[y * width + x] = vertical[x * height + y];
        }
    }
    Linear { width, height, px }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Coverage of an anti-aliased disc and thin rings, supersampled 8×8 per
    /// pixel: the analytic ideal at any size. `scale` multiplies all radii;
    /// the shape's centre is `cy` pixels above the bottom edge.
    pub fn rings(width: usize, height: usize, scale: f64, cy: f64) -> Linear {
        let (cx, cy) = (width as f64 / 2.0, height as f64 - cy);
        let mut px = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let (mut disc, mut ring) = (0.0, 0.0);
                for sy in 0..8 {
                    for sx in 0..8 {
                        let dx = x as f64 + (sx as f64 + 0.5) / 8.0 - cx;
                        let dy = y as f64 + (sy as f64 + 0.5) / 8.0 - cy;
                        let r = (dx * dx + dy * dy).sqrt() / scale;
                        if r < 20.0 {
                            disc += 1.0;
                        }
                        // 1 px rings (at scale 1) at radii 26, 32 and 38.
                        if [26.0, 32.0, 38.0].iter().any(|&c| (r - c).abs() < 0.5) {
                            ring += 1.0;
                        }
                    }
                }
                let (disc, ring) = ((disc / 64.0) as f32, (ring / 64.0) as f32);
                // A light disc and dark rings on transparency.
                let a = (disc + ring).min(1.0);
                let lin = |c: f32| srgb_to_linear(c);
                let colour = |d: f32, r: f32| {
                    if a > 0.0 {
                        (d * lin(0.95) + r * lin(0.15)) / (disc + ring).max(1e-6) * a
                    } else {
                        0.0
                    }
                };
                px.push([
                    colour(disc, ring),
                    colour(disc, ring),
                    colour(disc * 0.9, ring),
                    a,
                ]);
            }
        }
        Linear { width, height, px }
    }

    /// Structural similarity of two images (alpha-weighted luminance and
    /// alpha, 8×8 windows), 1 for identical.
    pub fn ssim(a: &Linear, b: &Linear) -> f64 {
        assert_eq!((a.width, a.height), (b.width, b.height));
        let value = |p: [f32; 4]| {
            [
                (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) as f64,
                p[3] as f64,
            ]
        };
        let (c1, c2) = (0.01f64.powi(2), 0.03f64.powi(2));
        let mut total = 0.0;
        let mut count = 0;
        for channel in 0..2 {
            for wy in (0..a.height.saturating_sub(7)).step_by(4) {
                for wx in (0..a.width.saturating_sub(7)).step_by(4) {
                    let (mut ma, mut mb, mut va, mut vb, mut cov) = (0.0, 0.0, 0.0, 0.0, 0.0);
                    for y in wy..wy + 8 {
                        for x in wx..wx + 8 {
                            ma += value(a.px[y * a.width + x])[channel];
                            mb += value(b.px[y * b.width + x])[channel];
                        }
                    }
                    ma /= 64.0;
                    mb /= 64.0;
                    for y in wy..wy + 8 {
                        for x in wx..wx + 8 {
                            let (pa, pb) = (
                                value(a.px[y * a.width + x])[channel] - ma,
                                value(b.px[y * b.width + x])[channel] - mb,
                            );
                            va += pa * pa;
                            vb += pb * pb;
                            cov += pa * pb;
                        }
                    }
                    let (va, vb, cov) = (va / 63.0, vb / 63.0, cov / 63.0);
                    total += ((2.0 * ma * mb + c1) * (2.0 * cov + c2))
                        / ((ma * ma + mb * mb + c1) * (va + vb + c2));
                    count += 1;
                }
            }
        }
        total / count as f64
    }

    /// The largest overshoot of `out` past the ideal's local (5×5) range, per
    /// channel: a bright or dark rim (halo, ringing) the ideal has nowhere
    /// near; plain softening of a 1 px line stays inside that range.
    pub fn halo(out: &Linear, ideal: &Linear) -> f32 {
        let mut worst = 0.0f32;
        for y in 0..out.height {
            for x in 0..out.width {
                let (mut lo, mut hi) = ([f32::MAX; 4], [f32::MIN; 4]);
                for dy in -2i64..=2 {
                    for dx in -2i64..=2 {
                        let (xx, yy) = (
                            (x as i64 + dx).clamp(0, ideal.width as i64 - 1) as usize,
                            (y as i64 + dy).clamp(0, ideal.height as i64 - 1) as usize,
                        );
                        let p = ideal.px[yy * ideal.width + xx];
                        for c in 0..4 {
                            lo[c] = lo[c].min(p[c]);
                            hi[c] = hi[c].max(p[c]);
                        }
                    }
                }
                let p = out.px[y * out.width + x];
                for c in 0..4 {
                    worst = worst.max(p[c] - hi[c]).max(lo[c] - p[c]);
                }
            }
        }
        worst
    }

    #[test]
    fn identity_is_exact() {
        let src = rings(96, 96, 1.0, 48.0);
        let out = resize(&src, 96, 96, 1.0, 0.0);
        for (a, b) in src.px.iter().zip(&out.px) {
            for c in 0..4 {
                assert!((a[c] - b[c]).abs() < 1e-5);
            }
        }
    }

    #[test]
    fn scaled_rings_match_the_ideal_without_halos() {
        // The source is the @2x-sized image (192 px); outputs at 1x and @2x.
        let src = rings(192, 192, 2.0, 96.0);
        for scale in [0.7f64, 0.9, 1.1, 1.5] {
            for base in [96.0, 192.0] {
                let size = (base * scale).round() as usize;
                // The exact scale of the rounded output size.
                let s = size as f64 / 192.0;
                let out = resize(&src, size, size, s, 0.0);
                let ideal = rings(size, size, 2.0 * s, 96.0 * s);
                let (q, h) = (ssim(&out, &ideal), halo(&out, &ideal));
                // Plain Lanczos-3, for comparison: its overshoot is what the clamp removes.
                let plain = resize_with(&src, size, size, s, 0.0, false);
                let raw = halo(&plain, &ideal);
                eprintln!(
                    "METRIC {scale} {size} ssim {q:.4} halo {h:.4} unclamped-halo {raw:.4} unclamped-ssim {:.4}",
                    ssim(&plain, &ideal)
                );
                assert!(q > 0.98, "{scale}× at {size}px: SSIM {q}");
                assert!(
                    h < 0.08 && h <= raw,
                    "{scale}× at {size}px: halo {h} (unclamped {raw})"
                );
            }
        }
    }

    #[test]
    fn bottom_anchor_and_fractional_shift() {
        // A 1-px opaque row 10 px above the bottom, scaled 2× and moved up
        // 3.5 px, lands centred 2 × 10.5 + 3.5 = 24.5 px above the bottom.
        let (w, h) = (4, 40);
        let mut px = vec![[0.0f32; 4]; w * h];
        for x in 0..w {
            px[(h - 11) * w + x] = [1.0; 4];
        }
        let out = resize(
            &Linear {
                width: w,
                height: h,
                px,
            },
            w,
            80,
            2.0,
            3.5,
        );
        let alpha: Vec<f32> = (0..80).map(|y| out.px[y * w].px_alpha()).collect();
        let centre = alpha
            .iter()
            .enumerate()
            .map(|(y, a)| (80.0 - y as f32 - 0.5) * a)
            .sum::<f32>()
            / alpha.iter().sum::<f32>();
        assert!((centre - 24.5).abs() < 0.05, "centre {centre}");
    }

    trait Alpha {
        fn px_alpha(&self) -> f32;
    }
    impl Alpha for [f32; 4] {
        fn px_alpha(&self) -> f32 {
            self[3]
        }
    }
}
