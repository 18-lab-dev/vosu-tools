//! Converting a mix's osu!mania stages into other games' skins: a Quaver
//! skin (`.qs`) or Etterna noteskins (a `.zip` to extract into Etterna's
//! folder). The page resolves every `[Mania]` lookup of the composed mix
//! the way lazer does (render-core) and sends the stages with the plan; the
//! service reads the images through the plan, converts them, and keeps the
//! finished archive for one download. Mapping and sources: `EXPORT.md`.

pub mod etterna;
pub mod quaver;
pub mod raster;

use crate::{
    App, Failure,
    build::{self, BlankKind, Plan},
    failure, library,
};
use raster::{Img, Kind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// What `POST /v1/exports` produces.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    #[default]
    Osk,
    Quaver,
    Etterna,
}

/// One frame file of an image in the mix (a path the plan produces).
#[derive(Deserialize, Clone, Debug)]
pub struct Frame {
    pub path: String,
    /// An `@2x` file: its display size is half its pixel size.
    #[serde(default)]
    pub hd: bool,
}
/// The image a lookup draws: the mix's frames (one for a still image), or
/// osu!'s built-in look. `null` in the request when nothing is drawn.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Drawn {
    #[serde(default)]
    pub frames: Vec<Frame>,
    #[serde(default)]
    pub builtin: bool,
}

/// One column as lazer draws it; sizes in lazer stage units (768 tall).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub width: f32,
    /// Gap after this column (0 for the last).
    #[serde(default)]
    pub spacing: f32,
    pub kind: Kind,
    pub key: Option<Drawn>,
    pub key_down: Option<Drawn>,
    pub note: Option<Drawn>,
    pub head: Option<Drawn>,
    pub tail: Option<Drawn>,
    pub body: Option<Drawn>,
    /// Column background, alpha as lazer draws it (doubled).
    pub colour: [u8; 4],
    /// Column light tint (`ColourLight#`).
    pub light: [u8; 4],
    pub explosion_scale: f32,
    pub hold_light_scale: f32,
}
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Judgements {
    pub perfect: Option<Drawn>,
    pub great: Option<Drawn>,
    pub good: Option<Drawn>,
    pub ok: Option<Drawn>,
    pub meh: Option<Drawn>,
    pub miss: Option<Drawn>,
}
impl Judgements {
    /// In order: 300g (MAX), 300, 200, 100, 50, miss.
    pub fn all(&self) -> [&Option<Drawn>; 6] {
        [
            &self.perfect,
            &self.great,
            &self.good,
            &self.ok,
            &self.meh,
            &self.miss,
        ]
    }
}
/// One `[Mania]` stage of the mix, resolved.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub keys: usize,
    /// Distance of the hit position from the stage's bottom edge.
    pub hit_position: f32,
    /// Distance of the column light's bottom edge from the stage's bottom edge.
    pub light_position: f32,
    /// Judgement centre's distance from the stage's top edge.
    pub score_position: f32,
    pub note_height_width: f32,
    /// 0 stretches the hold body; anything else repeats it.
    pub note_body_style: i32,
    #[serde(default)]
    pub keys_under_notes: bool,
    /// `ColourJudgementLine` when `JudgementLine: 1`.
    pub judgement_line: Option<[u8; 4]>,
    pub barline: [u8; 4],
    pub columns: Vec<Column>,
    pub stage_left: Option<Drawn>,
    pub stage_right: Option<Drawn>,
    pub hint: Option<Drawn>,
    pub stage_light: Option<Drawn>,
    pub lighting_n: Option<Drawn>,
    pub lighting_l: Option<Drawn>,
    #[serde(default)]
    pub judgements: Judgements,
}

/// `POST /v1/exports`: a build plan, and for Quaver and Etterna the stages.
#[derive(Deserialize, Debug)]
pub struct Request {
    #[serde(flatten)]
    pub plan: Plan,
    #[serde(default)]
    pub target: Target,
    #[serde(default)]
    pub stages: Vec<Stage>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Skipped {
    pub keys: usize,
    pub reason: String,
}
/// What an export contains and what it left out or approximated.
#[derive(Serialize, Debug, Default, Clone)]
pub struct Report {
    pub exported: Vec<usize>,
    pub skipped: Vec<Skipped>,
    pub notes: Vec<String>,
}
/// A finished export: archive entries in order, and the report.
pub struct Output {
    pub files: Vec<(String, Vec<u8>)>,
    pub report: Report,
}

/// Largest finished archive kept in memory for its download.
pub const MAX_ARCHIVE: usize = 512 * 1024 * 1024;
const MAX_FRAMES: usize = 240;

/// The mix's image files the stages draw, read through the plan.
#[derive(Default)]
pub struct Files(HashMap<String, Vec<u8>>);
impl Files {
    pub fn insert(&mut self, path: &str, bytes: Vec<u8>) {
        self.0.insert(path.to_lowercase(), bytes);
    }
    /// The frames of `drawn`, decoded with their density, or `None` when
    /// nothing or the built-in look is drawn.
    pub fn frames(&self, drawn: &Option<Drawn>) -> Result<Option<Vec<Img>>, String> {
        let Some(drawn) = drawn else { return Ok(None) };
        if drawn.builtin || drawn.frames.is_empty() {
            return Ok(None);
        }
        drawn
            .frames
            .iter()
            .map(|frame| {
                let bytes = self
                    .0
                    .get(&frame.path.to_lowercase())
                    .ok_or_else(|| format!("{} is not in the mix", frame.path))?;
                let pixels = raster::decode(bytes).map_err(|e| format!("{}: {e}", frame.path))?;
                Ok(Img {
                    pixels,
                    density: if frame.hd { 2.0 } else { 1.0 },
                })
            })
            .collect::<Result<Vec<_>, String>>()
            .map(Some)
    }
    /// The first frame of `drawn`.
    pub fn first(&self, drawn: &Option<Drawn>) -> Result<Option<Img>, String> {
        Ok(self.frames(drawn)?.and_then(|f| f.into_iter().next()))
    }
}

/// Every image `drawn` lookup a stage makes.
fn drawn_of(stage: &Stage) -> Vec<&Option<Drawn>> {
    let mut all = Vec::new();
    for c in &stage.columns {
        all.extend([&c.key, &c.key_down, &c.note, &c.head, &c.tail, &c.body]);
    }
    all.extend([
        &stage.stage_left,
        &stage.stage_right,
        &stage.hint,
        &stage.stage_light,
        &stage.lighting_n,
        &stage.lighting_l,
    ]);
    all.extend(stage.judgements.all());
    all
}

fn finite(value: f32, low: f32, high: f32, what: &str) -> Result<(), Failure> {
    if value.is_finite() && (low..=high).contains(&value) {
        Ok(())
    } else {
        Err(failure(format!("{what} is out of range.")))
    }
}

/// Checks the stages' shape and numbers; every image they name must be a
/// file of the plan.
pub fn validate(stages: &[Stage], plan_paths: &HashMap<String, ()>) -> Result<(), Failure> {
    if stages.len() > 18 {
        return Err(failure("Too many stages."));
    }
    for stage in stages {
        if !(1..=18).contains(&stage.keys) || stage.columns.len() != stage.keys {
            return Err(failure("A stage's columns do not match its key count."));
        }
        if stages.iter().filter(|s| s.keys == stage.keys).count() > 1 {
            return Err(failure(format!("{}K appears twice.", stage.keys)));
        }
        finite(stage.hit_position, -2000.0, 2000.0, "HitPosition")?;
        finite(stage.light_position, -2000.0, 2000.0, "LightPosition")?;
        finite(stage.score_position, -2000.0, 2000.0, "ScorePosition")?;
        finite(
            stage.note_height_width,
            0.0,
            2000.0,
            "WidthForNoteHeightScale",
        )?;
        for column in &stage.columns {
            finite(column.width, 0.0, 2000.0, "ColumnWidth")?;
            finite(column.spacing, -2000.0, 2000.0, "ColumnSpacing")?;
            finite(column.explosion_scale, 0.0, 100.0, "LightingNWidth")?;
            finite(column.hold_light_scale, 0.0, 100.0, "LightingLWidth")?;
        }
        for drawn in drawn_of(stage).into_iter().flatten() {
            if drawn.frames.len() > MAX_FRAMES {
                return Err(failure("An image has too many frames."));
            }
            for frame in &drawn.frames {
                if !plan_paths.contains_key(&frame.path.to_lowercase()) {
                    return Err(failure(format!("{} is not in the mix.", frame.path)));
                }
            }
        }
    }
    Ok(())
}

/// `Author:` from the mix's skin.ini `[General]`.
pub fn ini_author(text: &str) -> Option<String> {
    let mut general = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[') {
            general = header.trim_end_matches(']').trim() == "General";
        } else if general
            && let Some((key, value)) = line.split_once(':')
            && key.trim() == "Author"
            && !value.trim().is_empty()
        {
            return Some(value.trim().to_owned());
        }
    }
    None
}

/// Where each plan output comes from.
enum Origin {
    Source { skin: usize, from: String },
    Blank,
}

/// Reads every image the stages draw through the plan (each source skin
/// resolved once).
async fn collect(app: &App, plan: &Plan, stages: &[Stage]) -> Result<Files, Failure> {
    let mut origins = HashMap::new();
    for (skin, source) in plan.sources.iter().enumerate() {
        for file in &source.files {
            let (from, to) = file.parts();
            origins.insert(
                to.to_lowercase(),
                Origin::Source {
                    skin,
                    from: from.to_owned(),
                },
            );
        }
    }
    for blank in &plan.blanks {
        if blank.kind == BlankKind::Png {
            origins.insert(blank.to.to_lowercase(), Origin::Blank);
        }
    }
    let mut resolved = HashMap::new();
    let mut files = Files::default();
    let all: Vec<&Drawn> = stages.iter().flat_map(drawn_of).flatten().collect();
    for drawn in all {
        for frame in &drawn.frames {
            let lower = frame.path.to_lowercase();
            if files.0.contains_key(&lower) {
                continue;
            }
            let bytes = match origins.get(&lower) {
                Some(Origin::Source { skin, from }) => {
                    if !resolved.contains_key(skin) {
                        let (source, _) = library::resolve(app, &plan.sources[*skin].skin).await?;
                        resolved.insert(*skin, source);
                    }
                    resolved[skin]
                        .read(app, from)
                        .await
                        .map_err(|(status, error)| {
                            (
                                status,
                                format!("{from} from {}: {error}", plan.sources[*skin].skin),
                            )
                        })?
                }
                Some(Origin::Blank) => build::blank_png(),
                None => return Err(failure(format!("{} is not in the mix.", frame.path))),
            };
            files.insert(&frame.path, bytes);
        }
    }
    Ok(files)
}

/// Lower-cased output paths of a plan.
fn plan_paths(plan: &Plan) -> HashMap<String, ()> {
    plan.sources
        .iter()
        .flat_map(|s| s.files.iter().map(|f| f.parts().1.to_lowercase()))
        .chain(plan.blanks.iter().map(|b| b.to.to_lowercase()))
        .map(|p| (p, ()))
        .collect()
}

/// Entries zipped in order; images stored, text deflated.
pub fn zip(files: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, bytes) in files {
        let method = if path.to_ascii_lowercase().ends_with(".png") {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        };
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(method)
            .last_modified_time(zip::DateTime::default());
        writer
            .start_file(path, options)
            .map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut writer, bytes).map_err(|e| e.to_string())?;
    }
    Ok(writer.finish().map_err(|e| e.to_string())?.into_inner())
}

/// A finished archive waiting for its download.
pub struct Archive {
    pub filename: String,
    pub bytes: Vec<u8>,
    pub report: Report,
}

/// Converts a plan's stages for `target` (Quaver or Etterna) into a finished
/// archive: everything is read, converted and zipped before the request
/// answers, so a failure never leaves a partial download.
pub async fn convert(app: &App, request: Request) -> Result<Archive, Failure> {
    let name = build::skin_name(&request.plan.name)?.to_owned();
    // The same checks as a stable build or .osk: safe, unique outputs, and
    // every source skin still in the library.
    let plan = build::prepare(app, request.plan).await?;
    validate(&request.stages, &plan_paths(&plan))?;
    let files = collect(app, &plan, &request.stages).await?;
    let author = ini_author(&plan.ini);
    let target = request.target;
    let stages = request.stages;
    let filename = match target {
        Target::Quaver => format!("{name}.qs"),
        Target::Etterna => format!("{name} (Etterna).zip"),
        Target::Osk => return Err(failure("An .osk export has no stages to convert.")),
    };
    let (output, bytes) = tokio::task::spawn_blocking(move || {
        let output = match target {
            Target::Quaver => quaver::export(&name, author.as_deref(), &stages, &files),
            _ => etterna::export(&name, author.as_deref(), &stages, &files),
        }?;
        if output.report.exported.is_empty() {
            return Err("The mix has no key count this game can load.".to_owned());
        }
        let bytes = zip(&output.files)?;
        if bytes.len() > MAX_ARCHIVE {
            return Err("The converted skin exceeds 512 MiB.".to_owned());
        }
        Ok((output, bytes))
    })
    .await
    .map_err(failure)?
    .map_err(failure)?;
    Ok(Archive {
        filename,
        bytes,
        report: output.report,
    })
}

/// Mean of the values (0 when empty).
pub fn mean(values: impl IntoIterator<Item = f32>) -> f32 {
    let (sum, count) = values
        .into_iter()
        .fold((0.0, 0u32), |(s, c), v| (s + v, c + 1));
    if count == 0 { 0.0 } else { sum / count as f32 }
}

/// The frames to draw for a column image: the mix's, else the built-in
/// shape (counted in `generated`).
pub fn or_shape(
    frames: Option<Vec<Img>>,
    shape: raster::Shape,
    kind: Kind,
    generated: &mut usize,
) -> Vec<Img> {
    frames.unwrap_or_else(|| {
        *generated += 1;
        vec![raster::shape(shape, kind)]
    })
}

/// Lazer's hit explosion / hold light frame length (LegacyHitExplosion,
/// LegacyBodyPiece): `max(1000 / 60, 170 / frames)` ms.
pub fn lighting_frame_ms(frames: usize) -> f32 {
    (1000.0f32 / 60.0).max(170.0 / frames.max(1) as f32)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        raster::encode(&image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba(rgba),
        ))
        .unwrap()
    }
    pub fn image(path: &str, hd: bool) -> Option<Drawn> {
        Some(Drawn {
            frames: vec![Frame {
                path: path.into(),
                hd,
            }],
            builtin: false,
        })
    }
    pub fn builtin() -> Option<Drawn> {
        Some(Drawn {
            frames: vec![],
            builtin: true,
        })
    }
    /// A stage of `keys` default-width columns drawing `note.png`,
    /// `key.png` (@2x) and a builtin hold body, plus 2-frame lightingN.
    pub fn stage(keys: usize) -> (Stage, Files) {
        let mut files = Files::default();
        files.insert("note.png", png(100, 40, [255, 255, 255, 255]));
        files.insert("key@2x.png", png(60, 300, [20, 20, 20, 255]));
        files.insert("keyd@2x.png", png(60, 300, [200, 20, 20, 255]));
        files.insert("lightingn-0.png", png(80, 80, [255, 255, 0, 128]));
        files.insert("lightingn-1.png", png(90, 90, [255, 255, 0, 64]));
        files.insert("hit300.png", png(120, 60, [0, 255, 0, 255]));
        let column = Column {
            width: 48.0,
            spacing: 0.0,
            kind: Kind::One,
            key: image("key@2x.png", true),
            key_down: image("keyd@2x.png", true),
            note: image("note.png", false),
            head: image("note.png", false),
            tail: image("note.png", false),
            body: builtin(),
            colour: [0, 0, 0, 255],
            light: [255, 255, 255, 255],
            explosion_scale: 1.0,
            hold_light_scale: 1.0,
        };
        let stage = Stage {
            keys,
            hit_position: 124.8,
            light_position: 107.2,
            score_position: 480.0,
            note_height_width: 48.0,
            note_body_style: 0,
            keys_under_notes: false,
            judgement_line: Some([255, 255, 255, 255]),
            barline: [255, 255, 255, 255],
            columns: vec![column; keys],
            stage_left: None,
            stage_right: None,
            hint: None,
            stage_light: None,
            lighting_n: Some(Drawn {
                frames: vec![
                    Frame {
                        path: "lightingN-0.png".into(),
                        hd: false,
                    },
                    Frame {
                        path: "lightingN-1.png".into(),
                        hd: false,
                    },
                ],
                builtin: false,
            }),
            lighting_l: None,
            judgements: Judgements {
                great: image("hit300.png", false),
                miss: builtin(),
                ..Default::default()
            },
        };
        (stage, files)
    }

    #[test]
    fn request_parses_with_the_plan_flattened() {
        let request: Request = serde_json::from_str(
            r#"{"name":"M","ini":"","sources":[],"target":"quaver","stages":[{"keys":1,"hitPosition":124.8,"lightPosition":107.2,"scorePosition":480,"noteHeightWidth":48,"noteBodyStyle":0,"judgementLine":null,"barline":[255,255,255,255],"columns":[{"width":48,"kind":"S","key":{"frames":[{"path":"a.png","hd":true}]},"keyDown":null,"note":{"builtin":true},"head":null,"tail":null,"body":null,"colour":[0,0,0,255],"light":[255,255,255,255],"explosionScale":1,"holdLightScale":1}],"stageLeft":null,"stageRight":null,"hint":null,"stageLight":null,"lightingN":null,"lightingL":null}]}"#,
        )
        .unwrap();
        assert_eq!(request.target, Target::Quaver);
        assert_eq!(request.plan.name, "M");
        let column = &request.stages[0].columns[0];
        assert_eq!(column.kind, Kind::Special);
        assert!(column.key.as_ref().unwrap().frames[0].hd);
        assert!(column.note.as_ref().unwrap().builtin);
        let osk: Request = serde_json::from_str(r#"{"name":"M","ini":""}"#).unwrap();
        assert_eq!(osk.target, Target::Osk);
    }
    #[test]
    fn validation_requires_plan_files_and_sane_numbers() {
        let (stage, _) = stage(4);
        let paths: HashMap<String, ()> = ["note.png", "key@2x.png", "keyd@2x.png"]
            .into_iter()
            .chain(["lightingn-0.png", "lightingn-1.png", "hit300.png"])
            .map(|p| (p.to_owned(), ()))
            .collect();
        validate(std::slice::from_ref(&stage), &paths).unwrap();
        let mut missing = paths.clone();
        missing.remove("note.png");
        assert!(validate(std::slice::from_ref(&stage), &missing).is_err());
        let mut bad = stage.clone();
        bad.hit_position = f32::NAN;
        assert!(validate(&[bad], &paths).is_err());
        let mut short = stage.clone();
        short.columns.pop();
        assert!(validate(&[short], &paths).is_err());
        assert!(validate(&[stage.clone(), stage], &paths).is_err());
    }
    #[test]
    fn author_and_lighting_rules() {
        assert_eq!(
            ini_author("[General]\r\nName: X\r\nAuthor: sxlvia\r\n").as_deref(),
            Some("sxlvia")
        );
        assert_eq!(ini_author("[General]\nAuthor:\n"), None);
        assert_eq!(lighting_frame_ms(1), 170.0);
        assert!((lighting_frame_ms(30) - 1000.0 / 60.0).abs() < 1e-4);
        assert_eq!(mean([1.0, 2.0, 6.0]), 3.0);
        assert_eq!(mean([]), 0.0);
    }
    #[test]
    fn zip_stores_images_and_deflates_text() {
        let bytes = zip(&[
            ("a/b.png".into(), png(1, 1, [0; 4])),
            ("skin.ini".into(), b"[General]\n".to_vec()),
        ])
        .unwrap();
        let mut archive = ::zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(
            archive.by_name("a/b.png").unwrap().compression(),
            ::zip::CompressionMethod::Stored
        );
        assert_eq!(
            archive.by_name("skin.ini").unwrap().compression(),
            ::zip::CompressionMethod::Deflated
        );
    }
}
