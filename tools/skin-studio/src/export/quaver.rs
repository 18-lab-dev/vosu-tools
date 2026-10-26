//! Quaver skin (`.qs`: a zip of the skin folder, which Quaver extracts into
//! `Skins/<file name>`). Layout and keys follow Quaver
//! `d22a4a312479e73cd652a5f4683d3607e6795620`: `Quaver.Shared/Skinning/
//! SkinKeys.cs` (per-mode `[4K]` sections, `/<4k>/<Folder>/<element>.png`),
//! `SkinStore.cs` (`Judgements/judge-*`, `element@RxC.png` sprite sheets),
//! and the playfield code that places them (`GameplayPlayfieldKeys.cs`,
//! `GameplayPlayfieldKeysStage.cs`, `HitLighting.cs`). Mapping: `EXPORT.md`.
//!
//! Quaver skin units are 1366×768 screen units (`QuaverGame.SkinScalingFactor`
//! scales them to the 1920×1080 virtual screen), the same height as lazer's
//! 768-unit mania stage, so lazer sizes carry over unchanged.

use super::{
    Files, Output, Report, Skipped, Stage, lighting_frame_ms, mean, or_shape,
    raster::{self, Img, Shape},
};
use image::RgbaImage;
use std::fmt::Write;

/// Key counts Quaver plays (`Quaver.API/Enums/GameMode.cs`: Keys1–Keys10).
pub const KEYS: std::ops::RangeInclusive<usize> = 1..=10;
/// `QuaverGame.SkinScalingFactor`: virtual pixels per skin unit.
const SKIN_SCALE: f32 = 1920.0 / 1366.0;
/// Quaver's screen height in skin units, as lazer's stage.
const SCREEN: f32 = 768.0;
/// Judgement frame rate: lazer's mania judgements (`ManiaLegacySkinTransformer.getResult`).
const JUDGEMENT_FPS: u32 = 20;

/// `HitPosOffsetY` with `ReceptorPosOffsetY: 0`: the receptor's bottom edge
/// is the screen's, notes' bottom edges are hit `HitPosOffsetY` below its top
/// (`GameplayPlayfieldKeys`: `ReceptorPositionY + HitPosOffsetY`), so the hit
/// line lands `hit_position` above the bottom as in lazer.
pub fn hit_pos_offset(receptor_height: f32, hit_position: f32) -> i32 {
    (receptor_height - hit_position).round() as i32
}
/// `ColumnLightingOffsetY`: the light's bottom edge sits that far above the
/// receptor's top; lazer puts it `light_position` above the stage bottom.
pub fn column_lighting_offset(receptor_height: f32, light_position: f32) -> i32 {
    (light_position - receptor_height).round() as i32
}
/// `HitLightingY`: Quaver centres hit lighting on the receptor, lazer on
/// the hit position (downscroll).
pub fn hit_lighting_y(receptor_height: f32, hit_position: f32) -> i32 {
    (receptor_height / 2.0 - hit_position).round() as i32
}
/// `HitLightingScale` / `HoldLightingScale` (percent of the image's pixel
/// size in virtual pixels) for an image of `density` drawn at `scale` times
/// its display size, as lazer does.
pub fn lighting_scale(scale: f32, density: f32) -> i32 {
    (100.0 * scale * SKIN_SCALE / density).round().max(1.0) as i32
}
/// `HitLightingFps` for `frames` frames of lazer's lighting timing.
pub fn lighting_fps(frames: usize) -> i32 {
    (1000.0 / lighting_frame_ms(frames)).round() as i32
}
/// `JudgementBurstPosY`: offset from the screen's middle; lazer's
/// ScorePosition is the distance from the stage top.
pub fn judgement_pos_y(score_position: f32) -> i32 {
    (score_position - SCREEN / 2.0).round() as i32
}

/// Sprite-sheet file name: `element@RxC.png` (`SkinStore.SpritesheetRegex`;
/// `AssetLoader.SpritesheetToRegions(texture, rows, columns)`), or the plain
/// element for one frame.
pub fn sheet_name(element: &str, rows: u32, columns: u32) -> String {
    if rows * columns <= 1 {
        format!("{element}.png")
    } else {
        format!("{element}@{rows}x{columns}.png")
    }
}

/// Writes a PNG, longer sides scaled to [`raster::MAX_SIDE`] (osu! hold
/// bodies can be 40000 px tall; Quaver stretches bodies to the hold anyway).
fn png(out: &mut Vec<(String, Vec<u8>)>, path: String, image: &RgbaImage) -> Result<(), String> {
    out.push((path, raster::encode(&raster::within(image))?));
    Ok(())
}
/// Frames as one image or a sheet; returns the frame count.
fn frames_out(
    out: &mut Vec<(String, Vec<u8>)>,
    dir: &str,
    element: &str,
    frames: &[RgbaImage],
) -> Result<usize, String> {
    if frames.len() <= 1 {
        png(out, format!("{dir}/{element}.png"), &frames[0])?;
    } else {
        let (sheet, rows, columns) = raster::fitted_sheet(frames);
        png(
            out,
            format!("{dir}/{}", sheet_name(element, rows, columns)),
            &sheet,
        )?;
    }
    Ok(frames.len())
}
fn rgba(c: [u8; 4]) -> String {
    format!("{},{},{},{}", c[0], c[1], c[2], c[3])
}
fn rgb(c: [u8; 4]) -> String {
    format!("{},{},{}", c[0], c[1], c[2])
}
fn flag(value: bool) -> &'static str {
    if value { "True" } else { "False" }
}

/// One mode's folder and `[nK]` section.
fn mode(
    stage: &Stage,
    files: &Files,
    out: &mut Vec<(String, Vec<u8>)>,
    ini: &mut String,
    notes: &mut Vec<String>,
    judgement_height: Option<f32>,
) -> Result<(), String> {
    let keys = stage.keys;
    let dir = format!("{keys}k");
    let size = mean(stage.columns.iter().map(|c| c.width));
    let padding = mean(stage.columns.iter().take(keys - 1).map(|c| c.spacing));
    let mut generated = 0;

    // Receptors: column wide at their own height, as lazer's LegacyKeyArea;
    // padded to one height so every lane shares the hit line.
    let mut up = Vec::new();
    let mut down = Vec::new();
    for column in &stage.columns {
        up.push(
            or_shape(
                files.frames(&column.key)?,
                Shape::Key,
                column.kind,
                &mut generated,
            )
            .remove(0),
        );
        down.push(
            or_shape(
                files.frames(&column.key_down)?,
                Shape::KeyDown,
                column.kind,
                &mut generated,
            )
            .remove(0),
        );
    }
    let receptor_height = up.iter().chain(&down).map(Img::height).fold(0.0, f32::max);
    for (lane, (up, down)) in up.iter().zip(&down).enumerate() {
        for (element, img) in [("receptor-up", up), ("receptor-down", down)] {
            let resized = raster::resize(
                &img.pixels,
                raster::px(size, img.density),
                img.pixels.height(),
            );
            let padded = raster::pad_top(&resized, raster::px(receptor_height, img.density));
            png(
                out,
                format!("{dir}/Receptors/{element}-{}.png", lane + 1),
                &padded,
            )?;
        }
    }

    // Notes, hold heads, bodies and ends: Quaver draws them lane wide with
    // the image's aspect at WidthForNoteHeightScale, as lazer does.
    for (lane, column) in stage.columns.iter().enumerate() {
        let n = lane + 1;
        let note = or_shape(
            files.frames(&column.note)?,
            Shape::Note,
            column.kind,
            &mut generated,
        );
        let head = or_shape(
            files.frames(&column.head)?,
            Shape::Note,
            column.kind,
            &mut generated,
        );
        let tail = or_shape(
            files.frames(&column.tail)?,
            Shape::Tail,
            column.kind,
            &mut generated,
        );
        let body = or_shape(
            files.frames(&column.body)?,
            Shape::Body,
            column.kind,
            &mut generated,
        );
        // Quaver notes do not animate: the first frame.
        png(
            out,
            format!("{dir}/HitObjects/note-hitobject-{n}.png"),
            &note[0].pixels,
        )?;
        png(
            out,
            format!("{dir}/HitObjects/note-holdhitobject-{n}.png"),
            &head[0].pixels,
        )?;
        // lazer flips tails in downscroll (LegacyHoldNoteTailPiece); Quaver
        // flips ends in upscroll (FlipNoteEndImagesOnUpscroll), so the end
        // is stored flipped.
        let end = raster::flip_vertical(&tail[0].pixels);
        png(out, format!("{dir}/HitObjects/note-holdend-{n}.png"), &end)?;
        // Bodies animate while held in both games (30 ms frames in lazer,
        // 30 fps in Quaver's StartLongNoteAnimation).
        let bodies: Vec<_> = body.iter().map(|f| f.pixels.clone()).collect();
        frames_out(
            out,
            &format!("{dir}/HitObjects"),
            &format!("note-holdbody-{n}"),
            &bodies,
        )?;
        png(
            out,
            format!("{dir}/Editor/note-hitobject-{n}.png"),
            &note[0].pixels,
        )?;
        png(
            out,
            format!("{dir}/Editor/note-holdbody-{n}.png"),
            &body[0].pixels,
        )?;
        png(out, format!("{dir}/Editor/note-holdend-{n}.png"), &end)?;
    }

    // Column light (StageLight): column wide at its own height.
    let light = match files.first(&stage.stage_light)? {
        Some(img) => raster::resize(
            &img.pixels,
            raster::px(size, img.density),
            img.pixels.height(),
        ),
        None => raster::transparent(),
    };
    png(out, format!("{dir}/Lighting/column-lighting.png"), &light)?;
    // Hit and hold lighting (LightingN, LightingL), one image for every lane.
    let mut lighting = |drawn, element: &str| -> Result<(usize, f32), String> {
        Ok(match files.frames(drawn)? {
            Some(frames) => {
                let density = frames[0].density;
                let pixels: Vec<_> = frames.iter().map(|f| f.pixels.clone()).collect();
                let count = frames_out(
                    out,
                    &format!("{dir}/Lighting"),
                    element,
                    &raster::centred(&pixels),
                )?;
                (count, density)
            }
            None => {
                png(
                    out,
                    format!("{dir}/Lighting/{element}.png"),
                    &raster::transparent(),
                )?;
                (1, 1.0)
            }
        })
    };
    let (hit_frames, hit_density) = lighting(&stage.lighting_n, "hitlighting")?;
    let (hold_frames, hold_density) = lighting(&stage.lighting_l, "holdlighting")?;

    // Stage: sides at their own width over the full height, the hit target
    // over the stage width, column backgrounds as a stretched strip.
    for (drawn, element) in [
        (&stage.stage_left, "stage-left-border"),
        (&stage.stage_right, "stage-right-border"),
    ] {
        let side = match files.first(drawn)? {
            Some(img) => raster::resize(
                &img.pixels,
                img.pixels.width(),
                raster::px(SCREEN, img.density),
            ),
            None => raster::transparent(),
        };
        png(out, format!("{dir}/Stage/{element}.png"), &side)?;
    }
    let stage_width = size * keys as f32 + padding * (keys - 1) as f32;
    png(
        out,
        format!("{dir}/Stage/stage-hitposition-overlay.png"),
        &hit_target(stage, files, stage_width)?,
    )?;
    let colours: Vec<_> = stage.columns.iter().map(|c| c.colour).collect();
    png(
        out,
        format!("{dir}/Stage/stage-bgmask.png"),
        &raster::strip(&colours, 64),
    )?;
    png(
        out,
        format!("{dir}/Stage/stage-distant-overlay.png"),
        &raster::transparent(),
    )?;
    png(
        out,
        format!("{dir}/Stage/stage-timingbar.png"),
        &RgbaImage::from_pixel(1, 1, image::Rgba([255; 4])),
    )?;

    let explosion = mean(stage.columns.iter().map(|c| c.explosion_scale));
    let hold_light = mean(stage.columns.iter().map(|c| c.hold_light_scale));
    let mut s = String::new();
    let _ = write!(s, "[{keys}K]\r\n");
    let mut key = |k: &str, v: String| {
        let _ = write!(s, "{k} = {v}\r\n");
    };
    key("ColumnSize", format!("{}", size.round() as i32));
    key("NotePadding", format!("{}", padding.round() as i32));
    key("StageReceptorPadding", "0".into());
    key("ColumnAlignment", "0".into());
    key("ReceptorPosOffsetY", "0".into());
    key(
        "HitPosOffsetY",
        hit_pos_offset(receptor_height, stage.hit_position).to_string(),
    );
    key(
        "WidthForNoteHeightScale",
        format!("{}", stage.note_height_width.round() as i32),
    );
    key(
        "ReceptorsOverHitObjects",
        flag(!stage.keys_under_notes).into(),
    );
    key("FlipNoteImagesOnUpscroll", "True".into());
    key("FlipNoteEndImagesOnUpscroll", "True".into());
    key("DrawLongNoteEnd", "True".into());
    key("ColorObjectsBySnapDistance", "False".into());
    key("UseHitObjectSheet", "False".into());
    key("RotateHitObjectsByColumn", "False".into());
    key("RotateReceptorsByColumn", "False".into());
    key("ColumnLightingScale", "1".into());
    key(
        "ColumnLightingOffsetY",
        column_lighting_offset(receptor_height, stage.light_position).to_string(),
    );
    key("HitLightingX", "0".into());
    key(
        "HitLightingY",
        hit_lighting_y(receptor_height, stage.hit_position).to_string(),
    );
    key(
        "HitLightingScale",
        lighting_scale(explosion, hit_density).to_string(),
    );
    key(
        "HoldLightingScale",
        lighting_scale(hold_light, hold_density).to_string(),
    );
    key("HitLightingFps", lighting_fps(hit_frames).to_string());
    key("HoldLightingFps", lighting_fps(hold_frames).to_string());
    key("HitLightingColumnRotation", "False".into());
    key("HoldLightingColumnRotation", "False".into());
    key("BgMaskAlpha", "1".into());
    key("TimingLineColor", rgb(stage.barline));
    key(
        "JudgementBurstPosY",
        judgement_pos_y(stage.score_position).to_string(),
    );
    if let Some(height) = judgement_height {
        key(
            "JudgementHitBurstScale",
            (height.round().clamp(1.0, 255.0) as i32).to_string(),
        );
    }
    key("JudgementHitBurstFps", JUDGEMENT_FPS.to_string());
    for (lane, column) in stage.columns.iter().enumerate() {
        key(&format!("ColumnColor{}", lane + 1), rgba(column.light));
    }
    ini.push_str(&s);
    ini.push_str("\r\n");

    if generated > 0 {
        notes.push(format!(
            "{keys}K: {generated} images osu! takes from its built-in look are drawn as plain shapes."
        ));
    }
    if stage.columns.iter().any(|c| (c.width - size).abs() > 0.5)
        || stage
            .columns
            .iter()
            .take(keys - 1)
            .any(|c| (c.spacing - padding).abs() > 0.5)
    {
        notes.push(format!(
            "{keys}K: Quaver has one lane width and gap; columns use their average."
        ));
    }
    Ok(())
}

/// The hit target (StageHint at lazer's 0.9 × 1.6025 height over the stage
/// width) with the judgement line along its bottom edge, where Quaver draws
/// the overlay's bottom on the hit line.
fn hit_target(stage: &Stage, files: &Files, width: f32) -> Result<RgbaImage, String> {
    const DENSITY: f32 = 2.0;
    let hint = files.first(&stage.hint)?;
    let hint_height = hint.as_ref().map_or(0.0, |h| h.height() * 0.9 * 1.6025);
    let height = hint_height.max(if stage.judgement_line.is_some() {
        1.0
    } else {
        0.0
    });
    if height <= 0.0 {
        return Ok(raster::transparent());
    }
    let (w, h) = (raster::px(width, DENSITY), raster::px(height, DENSITY));
    let mut canvas = RgbaImage::new(w, h);
    if let Some(hint) = hint {
        let scaled = raster::resize(&hint.pixels, w, raster::px(hint_height, DENSITY));
        image::imageops::overlay(&mut canvas, &scaled, 0, (h - scaled.height()) as i64);
    }
    if let Some(colour) = stage.judgement_line {
        // lazer draws the line at 90% of ColourJudgementLine's alpha.
        let alpha = (colour[3] as f32 * 0.9).round() as u8;
        let line = RgbaImage::from_pixel(
            w,
            DENSITY as u32,
            image::Rgba([colour[0], colour[1], colour[2], alpha]),
        );
        image::imageops::overlay(&mut canvas, &line, 0, (h - line.height()) as i64);
    }
    Ok(canvas)
}

/// Judgements (shared by every mode): `Judgements/judge-*`, frames on one
/// canvas so every judgement keeps the box Quaver sizes from the miss frame.
/// Returns the canvas height in skin units.
fn judgements(
    stage: &Stage,
    files: &Files,
    out: &mut Vec<(String, Vec<u8>)>,
    notes: &mut Vec<String>,
) -> Result<Option<f32>, String> {
    const NAMES: [&str; 6] = ["marv", "perf", "great", "good", "okay", "miss"];
    let mut loaded = Vec::new();
    let mut fallback = Vec::new();
    for (name, drawn) in NAMES.iter().zip(stage.judgements.all()) {
        match files.frames(drawn)? {
            Some(frames) => loaded.push((name, frames)),
            None => fallback.push(*name),
        }
    }
    if !fallback.is_empty() {
        notes.push(format!(
            "Judgements {} use Quaver's default skin: the mix draws osu!'s built-in look or nothing.",
            fallback.join(", ")
        ));
    }
    if loaded.is_empty() {
        return Ok(None);
    }
    let width = loaded
        .iter()
        .flat_map(|(_, f)| f.iter().map(Img::width))
        .fold(0.0, f32::max);
    let height = loaded
        .iter()
        .flat_map(|(_, f)| f.iter().map(Img::height))
        .fold(0.0, f32::max);
    for (name, frames) in loaded {
        let canvas: Vec<_> = frames
            .iter()
            .map(|f| {
                let (w, h) = (raster::px(width, f.density), raster::px(height, f.density));
                let mut c = RgbaImage::new(w.max(f.pixels.width()), h.max(f.pixels.height()));
                let (x, y) = (
                    (c.width() - f.pixels.width()) / 2,
                    (c.height() - f.pixels.height()) / 2,
                );
                image::imageops::replace(&mut c, &f.pixels, x as i64, y as i64);
                c
            })
            .collect();
        // One density per sheet: the first frame's.
        let canvas: Vec<_> = canvas
            .iter()
            .map(|c| raster::resize(c, canvas[0].width(), canvas[0].height()))
            .collect();
        frames_out(out, "Judgements", &format!("judge-{name}"), &canvas)?;
    }
    Ok(Some(height))
}

/// The Quaver skin for `stages`: key counts Quaver does not play are skipped.
pub fn export(
    name: &str,
    author: Option<&str>,
    stages: &[Stage],
    files: &Files,
) -> Result<Output, String> {
    let mut out = Vec::new();
    let mut report = Report::default();
    let mut ini = format!(
        "[General]\r\nName = {name}\r\nAuthor = {}\r\nVersion = Skin studio export\r\n\r\n",
        author.unwrap_or("Skin studio")
    );
    let mut playable: Vec<&Stage> = Vec::new();
    for stage in stages {
        if KEYS.contains(&stage.keys) {
            playable.push(stage);
        } else {
            report.skipped.push(Skipped {
                keys: stage.keys,
                reason: "Quaver plays 1K to 10K".into(),
            });
        }
    }
    playable.sort_by_key(|s| s.keys);
    // Judgements are one set for every mode: 4K's, else the smallest count's.
    let judged = playable.iter().find(|s| s.keys == 4).or(playable.first());
    let judgement_height = match judged {
        Some(stage) => {
            let height = judgements(stage, files, &mut out, &mut report.notes)?;
            if playable.len() > 1 {
                report.notes.push(format!(
                    "Quaver has one set of judgements: {}K's are used for every key count.",
                    stage.keys
                ));
            }
            height
        }
        None => None,
    };
    for stage in playable {
        mode(
            stage,
            files,
            &mut out,
            &mut ini,
            &mut report.notes,
            judgement_height,
        )?;
        report.exported.push(stage.keys);
    }
    out.insert(0, ("skin.ini".into(), ini.into_bytes()));
    Ok(Output { files: out, report })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::tests::stage;

    #[test]
    fn hit_position_conversion() {
        // lazer's default: HitPosition 402 → 124.8 units above the bottom; the
        // classic key is 124.8 tall, so the hit line is the receptor's top.
        assert_eq!(hit_pos_offset(124.8, 124.8), 0);
        // A 300-unit receptor and HitPosition 380 (160 units above the bottom).
        assert_eq!(hit_pos_offset(300.0, (480.0 - 380.0) * 1.6), 140);
        assert_eq!(column_lighting_offset(124.8, 107.2), -18);
        assert_eq!(hit_lighting_y(124.8, 124.8), -62);
        assert_eq!(judgement_pos_y(480.0), 96);
        // A 1x explosion at scale 1: 140.6% of its pixels in 1080p virtual pixels.
        assert_eq!(lighting_scale(1.0, 1.0), 141);
        assert_eq!(lighting_scale(1.0, 2.0), 70);
        assert_eq!(lighting_fps(1), 6);
        assert_eq!(lighting_fps(20), 60);
    }
    #[test]
    fn names_follow_quaver() {
        assert_eq!(sheet_name("hitlighting", 1, 1), "hitlighting.png");
        assert_eq!(sheet_name("judge-marv", 1, 8), "judge-marv@1x8.png");
    }
    #[test]
    fn exports_modes_and_skips_unsupported() {
        let (four, files) = stage(4);
        let (mut twelve, _) = stage(12);
        twelve.keys = 12;
        let output = export("Mix", Some("me"), &[twelve, four], &files).unwrap();
        assert_eq!(output.report.exported, [4]);
        assert_eq!(output.report.skipped[0].keys, 12);
        let names: Vec<_> = output.files.iter().map(|(p, _)| p.as_str()).collect();
        for expected in [
            "skin.ini",
            "4k/Receptors/receptor-up-1.png",
            "4k/Receptors/receptor-down-4.png",
            "4k/HitObjects/note-hitobject-3.png",
            "4k/HitObjects/note-holdhitobject-2.png",
            "4k/HitObjects/note-holdbody-1.png",
            "4k/HitObjects/note-holdend-4.png",
            "4k/Lighting/hitlighting@1x2.png",
            "4k/Lighting/holdlighting.png",
            "4k/Lighting/column-lighting.png",
            "4k/Stage/stage-bgmask.png",
            "4k/Stage/stage-hitposition-overlay.png",
            "4k/Editor/note-hitobject-1.png",
            "Judgements/judge-perf.png",
        ] {
            assert!(names.contains(&expected), "{expected} in {names:?}");
        }
        assert!(!names.contains(&"Judgements/judge-miss.png"));
        let ini = String::from_utf8(output.files[0].1.clone()).unwrap();
        assert!(ini.contains("[4K]\r\nColumnSize = 48\r\n"), "{ini}");
        // Receptors are the @2x key: 300 px / 2 = 150 units tall.
        assert!(ini.contains("HitPosOffsetY = 25\r\n"), "{ini}");
        assert!(ini.contains("ColumnColor4 = 255,255,255,255\r\n"));
        assert!(ini.contains("JudgementHitBurstScale = 60\r\n"));
        assert!(ini.contains("HitLightingFps = 12\r\n"), "{ini}");
        assert!(
            output
                .report
                .notes
                .iter()
                .any(|n| n.contains("built-in look"))
        );
        // Receptors: lane wide (48 units × 2 px) at the key's own height.
        let receptor = raster::decode(
            &output
                .files
                .iter()
                .find(|(p, _)| p == "4k/Receptors/receptor-up-1.png")
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(receptor.dimensions(), (96, 300));
    }
}
