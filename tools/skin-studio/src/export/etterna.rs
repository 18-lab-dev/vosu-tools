//! Etterna noteskins: one per key count, under the game Etterna plays that
//! key count in (`NoteSkins/<game>/<name> <N>K/`), plus a judgement sheet
//! for Etterna's Assets screen. A zip to extract into Etterna's folder.
//! Conventions follow Etterna `2d706147cc4bcf95a8ceb24dc4f4129be207f803`:
//! `src/Etterna/Singletons/NoteSkinManager.cpp` (fallback chain, `GetPath`'s
//! `<Button> <Element>*` lookup, NoteSkin.lua loaders), `src/Etterna/Actor/
//! Gameplay/NoteDisplay.cpp` (note parts and their metrics),
//! `ReceptorArrow.cpp` and `GhostArrowRow.cpp` (receptor and explosion
//! commands), `src/Etterna/Singletons/GameManager.cpp` (games, styles,
//! buttons, column spacing) and `src/Etterna/Models/NoteLoaders/
//! NotesLoaderOSU.cpp` (which game an osu!mania key count loads as).
//! Mapping: `EXPORT.md`.
//!
//! Etterna's screen is 480 units tall, the same as osu!'s legacy units:
//! lazer sizes are divided by 1.6. Images are written at two pixels per
//! unit with Etterna's `(doubleres)` file-name hint.

use super::{
    Files, Output, Report, Skipped, Stage, lighting_frame_ms, or_shape,
    raster::{self, Img, Shape},
};
use image::RgbaImage;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fmt::Write};

/// lazer units per legacy (and Etterna) unit.
const LAZER: f32 = 1.6;
/// Pixels per Etterna unit of the written `(doubleres)` images.
const DENSITY: f32 = 2.0;
/// lazer draws note, head and tail frames at 60 fps (`SIXTY_FRAME_TIME`).
const NOTE_FRAME_S: f32 = 1.0 / 60.0;
/// lazer's hold body frames (`LegacyBodyPiece`: 30 ms).
const BODY_FRAME_S: f32 = 0.030;

/// How Etterna plays one osu!mania key count.
pub struct Game {
    pub keys: usize,
    /// NoteSkins folder (`solo` loads dance noteskins: NoteSkinManager).
    pub folder: &'static str,
    /// Game and style, for the notes.
    pub game: &'static str,
    pub style: &'static str,
    /// Column spacing (GameManager's `*_COL_SPACING`).
    pub spacing: f32,
    /// Button and controller (1 or 2) of each column.
    pub columns: &'static [(&'static str, u8)],
}

const DANCE: [(&str, u8); 4] = [("Left", 1), ("Down", 1), ("Up", 1), ("Right", 1)];
const PUMP: [(&str, u8); 5] = [
    ("DownLeft", 1),
    ("UpLeft", 1),
    ("Center", 1),
    ("UpRight", 1),
    ("DownRight", 1),
];
/// NotesLoaderOSU maps CircleSize 3–10 to these step types; 1K and 2K load
/// as nothing.
pub const GAMES: [Game; 8] = [
    Game {
        keys: 3,
        folder: "dance",
        game: "dance",
        style: "threepanel",
        spacing: 64.0,
        columns: &[("Left", 1), ("Down", 1), ("Right", 1)],
    },
    Game {
        keys: 4,
        folder: "dance",
        game: "dance",
        style: "single",
        spacing: 64.0,
        columns: &DANCE,
    },
    Game {
        keys: 5,
        folder: "pump",
        game: "pump",
        style: "single",
        spacing: 48.0,
        columns: &PUMP,
    },
    Game {
        keys: 6,
        folder: "dance",
        game: "solo",
        style: "single",
        spacing: 64.0,
        columns: &[
            ("Left", 1),
            ("UpLeft", 1),
            ("Down", 1),
            ("Up", 1),
            ("UpRight", 1),
            ("Right", 1),
        ],
    },
    Game {
        keys: 7,
        folder: "kb7",
        game: "kb7",
        style: "single",
        spacing: 64.0,
        columns: &[
            ("Key1", 1),
            ("Key2", 1),
            ("Key3", 1),
            ("Key4", 1),
            ("Key5", 1),
            ("Key6", 1),
            ("Key7", 1),
        ],
    },
    Game {
        keys: 8,
        folder: "dance",
        game: "dance",
        style: "double",
        spacing: 64.0,
        columns: &[
            ("Left", 1),
            ("Down", 1),
            ("Up", 1),
            ("Right", 1),
            ("Left", 2),
            ("Down", 2),
            ("Up", 2),
            ("Right", 2),
        ],
    },
    Game {
        keys: 9,
        folder: "popn",
        game: "popn",
        style: "popn-nine",
        spacing: 32.0,
        columns: &[
            ("Left White", 1),
            ("Left Yellow", 1),
            ("Left Green", 1),
            ("Left Blue", 1),
            ("Red", 1),
            ("Right Blue", 1),
            ("Right Green", 1),
            ("Right Yellow", 1),
            ("Right White", 1),
        ],
    },
    Game {
        keys: 10,
        folder: "pump",
        game: "pump",
        style: "double",
        spacing: 48.0,
        columns: &[
            ("DownLeft", 1),
            ("UpLeft", 1),
            ("Center", 1),
            ("UpRight", 1),
            ("DownRight", 1),
            ("DownLeft", 2),
            ("UpLeft", 2),
            ("Center", 2),
            ("UpRight", 2),
            ("DownRight", 2),
        ],
    },
];

pub fn game(keys: usize) -> Option<&'static Game> {
    GAMES.iter().find(|g| g.keys == keys)
}

/// StepMania/Etterna sprite-sheet name: `<name> <columns>x<rows>` when
/// animated, with the `(doubleres)` hint (RageTexture ID parsing).
pub fn image_name(base: &str, rows: u32, columns: u32) -> String {
    if rows * columns <= 1 {
        format!("{base} (doubleres).png")
    } else {
        format!("{base} {columns}x{rows} (doubleres).png")
    }
}

/// Etterna-unit size of a column piece: column-spacing wide, its height
/// from the image's aspect at lazer's note-height width, scaled like the
/// column (`k` = spacing / osu! column width).
pub fn piece_height(img: &Img, note_height_width: f32, k: f32) -> f32 {
    img.height() / img.width().max(f32::EPSILON) * note_height_width / LAZER * k
}

/// The receptor's y offset in reverse (downscroll): Etterna hits a note
/// when its centre reaches the receptor, osu! when its bottom edge reaches
/// the hit line, and osu!'s key sits on the stage bottom `hit_position`
/// below that line (all Etterna units but `hit_position`, lazer units).
pub fn receptor_offset(hit_position: f32, key_height: f32, note_height: f32) -> f32 {
    hit_position / LAZER + note_height / 2.0 - key_height / 2.0
}

/// Written images, deduplicated by content under short role names.
#[derive(Default)]
struct Images {
    files: Vec<(String, Vec<u8>)>,
    by_hash: HashMap<[u8; 32], String>,
    counts: HashMap<&'static str, usize>,
}
impl Images {
    /// Writes frames as one image or a sheet; returns the name `GetPath`
    /// finds it by (`_tap 01`), unique as a prefix since numbers have two digits.
    fn put(&mut self, role: &'static str, frames: &[RgbaImage]) -> Result<String, String> {
        let (image, rows, columns) = if frames.len() <= 1 {
            (frames[0].clone(), 1, 1)
        } else {
            raster::fitted_sheet(frames)
        };
        let bytes = raster::encode(&image)?;
        let mut hash = Sha256::new();
        hash.update(role.as_bytes());
        hash.update([rows as u8, columns as u8]);
        hash.update(&bytes);
        let key: [u8; 32] = hash.finalize().into();
        if let Some(name) = self.by_hash.get(&key) {
            return Ok(name.clone());
        }
        let count = self.counts.entry(role).or_default();
        *count += 1;
        let name = format!("_{role} {:02}", count);
        self.files.push((image_name(&name, rows, columns), bytes));
        self.by_hash.insert(key, name.clone());
        Ok(name)
    }
}

/// Frames resampled to `width`×`height` Etterna units at [`DENSITY`].
fn sized(frames: &[Img], width: f32, height: f32) -> Vec<RgbaImage> {
    frames
        .iter()
        .map(|f| {
            raster::resize(
                &f.pixels,
                raster::px(width, DENSITY),
                raster::px(height, DENSITY),
            )
        })
        .collect()
}

fn lua_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => {
                let _ = write!(out, "\\{}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
fn num(value: f32) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded == rounded.trunc() {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}")
    }
}

/// Per column: the image names and placement the Lua loader uses.
struct ColumnOut {
    tap: String,
    head: String,
    body: String,
    cap: String,
    key: String,
    key_down: String,
    receptor_y: f32,
    hit_zoom: f32,
    hold_zoom: f32,
    /// Frame counts (for animation lengths).
    frames: [usize; 4],
}
/// One explosion image: its name and frame delays.
struct Lighting {
    name: String,
    frames: usize,
    frame_s: f32,
}

/// One noteskin folder's files.
fn noteskin(
    stage: &Stage,
    game: &Game,
    name: &str,
    files: &Files,
    notes: &mut Vec<String>,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let keys = stage.keys;
    let spacing = game.spacing;
    let mut images = Images::default();
    let mut generated = 0;
    let mut columns = Vec::new();
    for column in &stage.columns {
        let k = spacing / (column.width / LAZER).max(1.0);
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
        let key = or_shape(
            files.frames(&column.key)?,
            Shape::Key,
            column.kind,
            &mut generated,
        );
        let key_down = or_shape(
            files.frames(&column.key_down)?,
            Shape::KeyDown,
            column.kind,
            &mut generated,
        );
        let note_height = piece_height(&note[0], stage.note_height_width, k);
        let piece = |frames: &[Img]| {
            let height = piece_height(&frames[0], stage.note_height_width, k);
            sized(&raster_centred(frames), spacing, height)
        };
        let tap = images.put("tap", &piece(&note))?;
        let head_name = images.put("head", &piece(&head))?;
        let cap = images.put("cap", &piece(&tail))?;
        let body_height = body[0].height() / body[0].width().max(f32::EPSILON) * spacing;
        let body_name = images.put("body", &sized(&raster_centred(&body), spacing, body_height))?;
        // Keys: column wide at their own height (lazer's LegacyKeyArea).
        let key_height = key[0].height() / LAZER;
        let key_name = images.put("key", &sized(&key[..1], spacing, key_height))?;
        let down_height = key_down[0].height() / LAZER;
        let down_name = images.put("keyd", &sized(&key_down[..1], spacing, down_height))?;
        columns.push(ColumnOut {
            tap,
            head: head_name,
            body: body_name,
            cap,
            key: key_name,
            key_down: down_name,
            receptor_y: receptor_offset(stage.hit_position, key_height, note_height),
            hit_zoom: column.explosion_scale * k,
            hold_zoom: column.hold_light_scale * k,
            frames: [note.len(), head.len(), body.len(), tail.len()],
        });
    }
    // Explosions: one image for every column, at the display size; each
    // column zooms it by its LightingN/LWidth scale and column scale.
    let mut lighting = |drawn, role: &'static str| -> Result<Option<Lighting>, String> {
        let Some(frames) = files.frames(drawn)? else {
            return Ok(None);
        };
        let raw: Vec<_> = frames.iter().map(|f| f.pixels.clone()).collect();
        let pixels = raster::centred(&raw);
        let first = &frames[0];
        let (w, h) = (
            pixels[0].width() as f32 / first.density / LAZER,
            pixels[0].height() as f32 / first.density / LAZER,
        );
        let sized: Vec<_> = pixels
            .iter()
            .map(|p| raster::resize(p, raster::px(w, DENSITY), raster::px(h, DENSITY)))
            .collect();
        Ok(Some(Lighting {
            name: images.put(role, &sized)?,
            frames: frames.len(),
            frame_s: lighting_frame_ms(frames.len()) / 1000.0,
        }))
    };
    let hit = lighting(&stage.lighting_n, "hit")?;
    let hold = lighting(&stage.lighting_l, "hold")?;

    let mut out = images.files;
    out.push((
        "_blank (doubleres).png".into(),
        raster::encode(&RgbaImage::new(2, 2))?,
    ));
    out.push((
        "NoteSkin.lua".into(),
        lua(stage, game, name, &columns, hit.as_ref(), hold.as_ref()).into_bytes(),
    ));
    out.push((
        "metrics.ini".into(),
        metrics(stage, game, &columns, notes).into_bytes(),
    ));

    if generated > 0 {
        notes.push(format!(
            "{keys}K: {generated} images osu! takes from its built-in look are drawn as plain shapes."
        ));
    }
    Ok(out)
}

fn raster_centred(frames: &[Img]) -> Vec<Img> {
    let pixels: Vec<_> = frames.iter().map(|f| f.pixels.clone()).collect();
    raster::centred(&pixels)
        .into_iter()
        .zip(frames)
        .map(|(pixels, f)| Img {
            pixels,
            density: f.density,
        })
        .collect()
}

/// `metrics.ini`: falls back to `common` only (not the game's `default`, whose
/// NoteSkin.lua redirects and rotates buttons), seconds-based animation, and
/// hold settings matching osu!'s bodies and tails.
fn metrics(stage: &Stage, game: &Game, columns: &[ColumnOut], notes: &mut Vec<String>) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "[Global]\r\nFallbackNoteSkin=common\r");
    let _ = writeln!(s, "[NoteDisplay]\r");
    for line in [
        "AnimationIsBeatBased=0",
        "TapNoteAnimationIsVivid=0",
        "StartDrawingHoldBodyOffsetFromHead=0",
        "StopDrawingHoldBodyOffsetFromTail=0",
        "FlipHeadAndTailWhenReverse=0",
        "FlipHoldBodyWhenReverse=1",
        "TopHoldAnchorWhenReverse=1",
        "HoldActiveIsAddLayer=0",
    ] {
        let _ = writeln!(s, "{line}\r");
    }
    let _ = writeln!(
        s,
        "UseStretchHolds={}\r",
        if stage.note_body_style == 0 { 1 } else { 0 }
    );
    // Animation lengths per button (NoteDisplay reads `<Button>` before
    // `[NoteDisplay]`); a double style's second side shares the first's.
    let mut seen: Vec<&str> = Vec::new();
    let mut differs = false;
    for (column, (button, _)) in columns.iter().zip(game.columns) {
        if let Some(i) = seen.iter().position(|b| b == button) {
            differs |= columns[i].frames != column.frames;
            continue;
        }
        seen.push(button);
        let [tap, head, body, tail] = column.frames;
        let parts = [
            ("TapNote", tap, NOTE_FRAME_S),
            ("HoldHead", head, NOTE_FRAME_S),
            ("HoldBody", body, BODY_FRAME_S),
            ("HoldBottomCap", tail, NOTE_FRAME_S),
        ];
        if parts.iter().all(|(_, n, _)| *n <= 1) {
            continue;
        }
        let _ = writeln!(s, "\r\n[{button}]\r");
        for (part, frames, frame_s) in parts {
            if frames > 1 {
                let _ = writeln!(
                    s,
                    "{part}AnimationLength={}\r",
                    num(frames as f32 * frame_s)
                );
            }
        }
    }
    if differs {
        notes.push(format!(
            "{}K: Etterna times animations per button; the second side uses the first side's frame counts.",
            stage.keys
        ));
    }
    s
}

/// `NoteSkin.lua`: receives the fallback chain's loader (`...`), draws this
/// noteskin's column images for every part it maps, and passes everything
/// else (mines, lifts, fakes, mine explosions) to `common`.
fn lua(
    stage: &Stage,
    game: &Game,
    name: &str,
    columns: &[ColumnOut],
    hit: Option<&Lighting>,
    hold: Option<&Lighting>,
) -> String {
    let mut s = String::new();
    let _ = writeln!(
        s,
        "-- Generated by Skin studio (vosu tools by 18-LAB) from the osu!mania {}K stage of {}.",
        stage.keys,
        lua_string(name)
    );
    let _ = writeln!(
        s,
        "-- Etterna game \"{}\", style \"{}\". Every column draws its own images; nothing is rotated.\n",
        game.game, game.style
    );
    s.push_str("local ret = ... or {}\nlocal fallback = ret.Load\n\n");
    s.push_str(
        "-- Column of each button, by controller (double styles use both).\nlocal buttons = {\n",
    );
    let mut by_button: Vec<(&str, [usize; 2])> = Vec::new();
    for (i, (button, controller)) in game.columns.iter().enumerate() {
        let entry = match by_button.iter_mut().find(|(b, _)| b == button) {
            Some(entry) => entry,
            None => {
                by_button.push((button, [0, 0]));
                by_button.last_mut().expect("just pushed")
            }
        };
        entry.1[(*controller - 1) as usize] = i + 1;
    }
    for (button, [first, second]) in &by_button {
        let second = if *second == 0 { *first } else { *second };
        let _ = writeln!(s, "\t[{}] = {{ {first}, {second} }},", lua_string(button));
    }
    s.push_str("}\n\nlocal columns = {\n");
    for c in columns {
        let _ = writeln!(
            s,
            "\t{{ tap = {}, head = {}, body = {}, cap = {}, key = {}, keyDown = {}, y = {}, hit = {}, hold = {} }},",
            lua_string(&c.tap),
            lua_string(&c.head),
            lua_string(&c.body),
            lua_string(&c.cap),
            lua_string(&c.key),
            lua_string(&c.key_down),
            num(c.receptor_y),
            num(c.hit_zoom),
            num(c.hold_zoom),
        );
    }
    s.push_str("}\n\n");
    let lighting = |l: Option<&Lighting>, hold_last: bool| match l {
        None => "nil".to_owned(),
        Some(l) => {
            let delays: Vec<_> = (0..l.frames)
                .map(|i| {
                    // A hit explosion plays once: its last frame holds.
                    let delay = if !hold_last && i + 1 == l.frames {
                        10.0
                    } else {
                        l.frame_s
                    };
                    format!("{{ Frame = {i}, Delay = {} }}", num(delay))
                })
                .collect();
            format!(
                "{{ file = {}, frames = {{ {} }} }}",
                lua_string(&l.name),
                delays.join(", ")
            )
        }
    };
    let _ = writeln!(s, "local hitLight = {}", lighting(hit, false));
    let _ = writeln!(s, "local holdLight = {}\n", lighting(hold, true));
    s.push_str(LOADER);
    s
}

/// The loader shared by every generated noteskin.
const LOADER: &str = r#"local parts = {
	["Tap Note"] = "tap",
	["Hold Head Active"] = "head", ["Hold Head Inactive"] = "head",
	["Roll Head Active"] = "head", ["Roll Head Inactive"] = "head",
	["Hold Body Active"] = "body", ["Hold Body Inactive"] = "body",
	["Roll Body Active"] = "body", ["Roll Body Inactive"] = "body",
	["Hold Bottomcap Active"] = "cap", ["Hold Bottomcap Inactive"] = "cap",
	["Roll Bottomcap Active"] = "cap", ["Roll Bottomcap Inactive"] = "cap",
}
-- osu! has no top caps, and its tails are drawn as bottom caps.
local hidden = {
	["Hold Topcap Active"] = true, ["Hold Topcap Inactive"] = true,
	["Roll Topcap Active"] = true, ["Roll Topcap Inactive"] = true,
	["Hold Tail Active"] = true, ["Hold Tail Inactive"] = true,
	["Roll Tail Active"] = true, ["Roll Tail Inactive"] = true,
}

local function path(file)
	return NOTESKIN:GetPath("", file)
end

local function column()
	local list = buttons[Var "Button"]
	if not list then
		return nil
	end
	local controller = Var "Controller"
	local second
	if type(controller) == "number" then
		second = controller == 1
	else
		second = tostring(controller):sub(-1) == "2"
	end
	return columns[second and list[2] or list[1]]
end

-- osu!'s key image under the hit line; mirrored for upscroll.
local function key(c, file, pressed)
	local function place(self, reverse)
		self:y(reverse and c.y or -c.y):zoomy(reverse and 1 or -1)
	end
	return Def.Sprite {
		Texture = path(file),
		InitCommand = function(self)
			self:visible(not pressed)
		end,
		ReverseOnCommand = function(self)
			place(self, true)
		end,
		ReverseOffCommand = function(self)
			place(self, false)
		end,
		PressCommand = function(self)
			self:visible(pressed)
		end,
		LiftCommand = function(self)
			self:visible(not pressed)
		end,
	}
end

local function receptor(c)
	return Def.ActorFrame {
		key(c, c.key, false),
		key(c, c.keyDown, true),
	}
end

local function explosion(c)
	local t = Def.ActorFrame {}
	if hitLight then
		local function flash(self)
			self:finishtweening():setstate(0):diffusealpha(0):linear(0.08):diffusealpha(1):linear(0.12):diffusealpha(0)
		end
		t[#t + 1] = Def.Sprite {
			Texture = path(hitLight.file),
			Frames = hitLight.frames,
			InitCommand = function(self)
				self:blend("BlendMode_Add"):zoom(c.hit):diffusealpha(0)
			end,
			W1Command = flash, W2Command = flash, W3Command = flash, W4Command = flash, W5Command = flash,
		}
	end
	if holdLight then
		local function show(self)
			self:visible(true)
		end
		local function hide(self)
			self:visible(false)
		end
		t[#t + 1] = Def.Sprite {
			Texture = path(holdLight.file),
			Frames = holdLight.frames,
			InitCommand = function(self)
				self:blend("BlendMode_Add"):zoom(c.hold):visible(false)
			end,
			HoldingOnCommand = show, HoldingOffCommand = hide,
			RollOnCommand = show, RollOffCommand = hide,
		}
	end
	-- Mines are Etterna's own: common's mine explosion.
	t[#t + 1] = NOTESKIN:LoadActor(Var "Button", "HitMine Explosion") .. {
		InitCommand = function(self)
			self:blend("BlendMode_Add"):diffusealpha(0)
		end,
		HitMineCommand = NOTESKIN:GetMetricA("GhostArrowBright", "HitMineCommand"),
	}
	return t
end

ret.Load = function()
	local element = Var "Element"
	local c = column()
	if c then
		local part = parts[element]
		if part then
			return Def.Sprite { Texture = path(c[part]) }
		end
		if hidden[element] then
			return Def.Sprite {
				Texture = path("_blank"),
				InitCommand = function(self)
					self:visible(false)
				end,
			}
		end
		if element == "Receptor" then
			return receptor(c)
		end
		if element == "Explosion" then
			return explosion(c)
		end
	end
	return fallback()
end
ret.CommonLoad = ret.Load

return ret
"#;

/// Etterna's judgement asset (`Assets/Judgments/<name> 1x6 (doubleres).png`,
/// rows W1–W5 then Miss, as `Themes/*/Graphics/Player judgment` index it):
/// the first frame of each osu! judgement on one cell size.
fn judgement_sheet(stage: &Stage, files: &Files) -> Result<Option<RgbaImage>, String> {
    let mut firsts = Vec::new();
    for drawn in stage.judgements.all() {
        match files.first(drawn)? {
            Some(img) => firsts.push(img),
            None => return Ok(None),
        }
    }
    let width = firsts.iter().map(Img::width).fold(0.0, f32::max) / LAZER;
    let height = firsts.iter().map(Img::height).fold(0.0, f32::max) / LAZER;
    let (cell_w, cell_h) = (raster::px(width, DENSITY), raster::px(height, DENSITY));
    let cells: Vec<_> = firsts
        .iter()
        .map(|img| {
            let scaled = raster::resize(
                &img.pixels,
                raster::px(img.width() / LAZER, DENSITY),
                raster::px(img.height() / LAZER, DENSITY),
            );
            let mut cell = RgbaImage::new(cell_w, cell_h);
            image::imageops::replace(
                &mut cell,
                &scaled,
                (cell_w.saturating_sub(scaled.width()) / 2) as i64,
                (cell_h.saturating_sub(scaled.height()) / 2) as i64,
            );
            cell
        })
        .collect();
    Ok(Some(raster::sheet(&cells, 6, 1)))
}

/// Etterna noteskins for `stages`: key counts Etterna cannot load are
/// skipped.
pub fn export(
    name: &str,
    _author: Option<&str>,
    stages: &[Stage],
    files: &Files,
) -> Result<Output, String> {
    let mut out = Vec::new();
    let mut report = Report::default();
    let mut playable: Vec<(&Stage, &Game)> = Vec::new();
    for stage in stages {
        match game(stage.keys) {
            Some(game) => playable.push((stage, game)),
            None => report.skipped.push(Skipped {
                keys: stage.keys,
                reason: "Etterna loads osu!mania 3K to 10K (NotesLoaderOSU)".into(),
            }),
        }
    }
    playable.sort_by_key(|(s, _)| s.keys);
    for (stage, game) in &playable {
        let folder = format!("NoteSkins/{}/{} {}K", game.folder, name, stage.keys);
        for (file, bytes) in noteskin(stage, game, name, files, &mut report.notes)? {
            out.push((format!("{folder}/{file}"), bytes));
        }
        report.exported.push(stage.keys);
    }
    if let Some((stage, _)) = playable
        .iter()
        .find(|(s, _)| s.keys == 4)
        .or(playable.first())
    {
        match judgement_sheet(stage, files)? {
            Some(sheet) => {
                out.push((
                    format!("Assets/Judgments/{name} 1x6 (doubleres).png"),
                    raster::encode(&sheet)?,
                ));
                report.notes.push(format!(
                    "Judgements ({}K's) are an Etterna asset: choose \"{name}\" under Assets → Judgments.",
                    stage.keys
                ));
            }
            None => report.notes.push(
                "No judgement asset: the mix draws osu!'s built-in look or nothing for some judgements."
                    .into(),
            ),
        }
    }
    Ok(Output { files: out, report })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::tests::{image, stage};

    #[test]
    fn games_cover_three_to_ten_keys() {
        for keys in 3..=10 {
            let game = game(keys).unwrap();
            assert_eq!(game.columns.len(), keys, "{keys}K");
        }
        assert!(game(1).is_none() && game(2).is_none() && game(11).is_none());
        assert_eq!(game(6).unwrap().folder, "dance");
        assert_eq!(game(7).unwrap().folder, "kb7");
        assert_eq!(game(9).unwrap().columns[4].0, "Red");
    }
    #[test]
    fn names_and_offsets() {
        assert_eq!(image_name("_tap 01", 1, 1), "_tap 01 (doubleres).png");
        assert_eq!(image_name("_hit 01", 2, 4), "_hit 01 4x2 (doubleres).png");
        // Default HitPosition 402 (124.8 lazer units = 78 Etterna units), a
        // 78-unit key and a 16-unit note: the key centre 47 units down.
        assert_eq!(receptor_offset(124.8, 78.0, 16.0), 47.0);
        let note = Img {
            pixels: RgbaImage::new(100, 40),
            density: 1.0,
        };
        // 0.4 aspect at a 48-unit (30 legacy) note width, columns 64/30 wider.
        assert!((piece_height(&note, 48.0, 64.0 / 30.0) - 25.6).abs() < 1e-4);
        assert_eq!(lua_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(num(2.5), "2.5");
        assert_eq!(num(3.0), "3");
    }
    #[test]
    fn exports_noteskins_per_game() {
        let (four, mut files) = stage(4);
        let (mut eight, _) = stage(8);
        // The second side of 8K differs: its own note.
        files.insert(
            "other.png",
            crate::export::tests::png(100, 50, [1, 2, 3, 255]),
        );
        for c in &mut eight.columns[4..] {
            c.note = image("other.png", false);
        }
        let (two, _) = stage(2);
        let output = export("Mix", None, &[eight, two, four], &files).unwrap();
        assert_eq!(output.report.exported, [4, 8]);
        assert_eq!(output.report.skipped[0].keys, 2);
        let names: Vec<_> = output.files.iter().map(|(p, _)| p.as_str()).collect();
        for expected in [
            "NoteSkins/dance/Mix 4K/NoteSkin.lua",
            "NoteSkins/dance/Mix 4K/metrics.ini",
            "NoteSkins/dance/Mix 4K/_tap 01 (doubleres).png",
            "NoteSkins/dance/Mix 4K/_key 01 (doubleres).png",
            "NoteSkins/dance/Mix 4K/_hit 01 2x1 (doubleres).png",
            "NoteSkins/dance/Mix 8K/_tap 02 (doubleres).png",
        ] {
            assert!(names.contains(&expected), "{expected} in {names:?}");
        }
        // Columns sharing an image share one file.
        assert!(!names.contains(&"NoteSkins/dance/Mix 4K/_tap 02 (doubleres).png"));
        let lua = String::from_utf8(
            output
                .files
                .iter()
                .find(|(p, _)| p == "NoteSkins/dance/Mix 8K/NoteSkin.lua")
                .unwrap()
                .1
                .clone(),
        )
        .unwrap();
        assert!(lua.contains("[\"Left\"] = { 1, 5 },"), "{lua}");
        assert!(lua.contains("tap = \"_tap 02\""));
        // Not every judgement is the mix's: no judgement asset.
        assert!(!names.iter().any(|n| n.starts_with("Assets/")));
        let tap = raster::decode(
            &output
                .files
                .iter()
                .find(|(p, _)| p == "NoteSkins/dance/Mix 4K/_tap 01 (doubleres).png")
                .unwrap()
                .1,
        )
        .unwrap();
        // 64 units × 2 px wide; 0.4 aspect × 30 legacy × (64/30) = 25.6 units.
        assert_eq!(tap.dimensions(), (128, 51));
    }
}
