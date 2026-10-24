//! Where an MP4 is going. Every export is H.264 High (level for its size and
//! frame rate), yuv420p with BT.709 matrix and tags, closed GOPs of at most
//! two seconds, AAC-LC 48 kHz stereo and the index first (`+faststart`), so
//! any player or site accepts it. "Export for" then adds a site's limits:
//!
//! - X / Twitter (help.x.com/en/using-x/x-videos; the size, aspect and frame
//!   rate limits are in that page's FAQ, e.g. help.x.com/id/using-x/x-videos):
//!   at most 1920×1200 landscape or 1200×1900 portrait, aspect 1:2.39 to
//!   2.39:1, 40 fps, 25 Mbps; 140 s and 512 MB without Premium.
//! - Discord (support.discord.com/hc/en-us/articles/25444343291031): a file
//!   size limit of 20 MB (free), 50 MB (Nitro Basic) or 1 GB (Nitro).
//! - YouTube: no limits, a higher quality target.
use super::*;
use std::path::Path as FsPath;

/// "Export for" choices, as settings and request values.
pub(super) const TARGETS: [&str; 4] = ["standard", "x", "discord", "youtube"];
/// Discord's upload limits, megabytes (decimal, as Discord counts them).
pub(super) const DISCORD_MB: [u32; 3] = [20, 50, 1000];
/// X: longest upload without Premium, seconds.
const X_SECONDS: f64 = 140.0;
/// X: the documented bitrate limit is 25 Mbps; the cap leaves headroom.
const X_MAXRATE: &str = "20M";
const X_BUFSIZE: &str = "40M";
const X_ASPECT: f64 = 2.39;
const TAGS: &str = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
/// Bits per pixel below which a Discord fit is scaled down rather than blurred.
const FIT_BPP: f64 = 0.04;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Target {
    Standard,
    X,
    Discord { megabytes: u32 },
    YouTube,
}

impl Target {
    pub fn parse(name: &str, megabytes: u32) -> Result<Self, String> {
        Ok(match name {
            "standard" => Self::Standard,
            "x" => Self::X,
            "discord" if DISCORD_MB.contains(&megabytes) => Self::Discord { megabytes },
            "discord" => return Err("Discord size must be 20, 50 or 1000 MB".into()),
            "youtube" => Self::YouTube,
            _ => return Err("Export for must be standard, x, discord or youtube".into()),
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::X => "x",
            Self::Discord { .. } => "discord",
            Self::YouTube => "youtube",
        }
    }
    /// The frame rate rendered for this target: X takes at most 40 fps, so
    /// faster outputs drop to the largest whole fraction of their rate that
    /// fits (120 → 40, 60 → 30, 144 → 36), else 30.
    pub fn fps(self, fps: u32) -> u32 {
        if self == Self::X {
            capped_fps(fps, 40)
        } else {
            fps
        }
    }
    /// Constant quality per target (x264 CRF; the same scale for hardware).
    fn quality(self) -> u32 {
        if self == Self::YouTube { 14 } else { 18 }
    }
    fn audio_kbps(self) -> u32 {
        match self {
            Self::X => 128,
            Self::YouTube => 320,
            _ => 192,
        }
    }
}

/// Picture geometry of one export: the rendered frame (`input`), the picture
/// inside the encoded frame (`content`, after scaling) and the encoded frame
/// (`output`, with bars when an aspect limit pads it).
/// The largest whole fraction of `fps` within `max` (120 → 40 under 40,
/// 144 → 36), else 30: frames stay evenly paced.
fn capped_fps(fps: u32, max: u32) -> u32 {
    if fps <= max {
        return fps;
    }
    (2..=fps)
        .filter(|d| fps.is_multiple_of(*d))
        .map(|d| fps / d)
        .find(|&f| f <= max)
        .filter(|&f| f >= 24)
        .unwrap_or(30)
}
/// Discord fits play at most 60 fps: high rates spend a small file's bits
/// on frames rather than detail.
const FIT_FPS: u32 = 60;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Plan {
    pub target: Target,
    pub input: (u32, u32),
    pub content: (u32, u32),
    pub output: (u32, u32),
    pub fps: u32,
}

fn even(value: f64) -> u32 {
    let v = (value / 2.0).round() as u32 * 2;
    if v < 2 { 2 } else { v }
}

impl Plan {
    /// `fps` is the rate actually rendered (`Target::fps` applied).
    pub fn new(target: Target, width: u32, height: u32, fps: u32) -> Self {
        let (w, h) = (f64::from(width), f64::from(height));
        let (content, output) = if target == Target::X {
            // Pad past X's aspect bounds, then fit the box for the orientation.
            let (pw, ph) = if w / h > X_ASPECT {
                (w, (w / X_ASPECT).ceil())
            } else if h / w > X_ASPECT {
                ((h / X_ASPECT).ceil(), h)
            } else {
                (w, h)
            };
            let (bw, bh) = if pw >= ph {
                (1920.0, 1200.0)
            } else {
                (1200.0, 1900.0)
            };
            let s = (bw / pw).min(bh / ph).min(1.0);
            let content = (even(w * s), even(h * s));
            let output = (even(pw * s).max(content.0), even(ph * s).max(content.1));
            (content, output)
        } else {
            ((width, height), (width, height))
        };
        Self {
            target,
            input: (width, height),
            content,
            output,
            fps,
        }
    }

    /// The RGBA frames' conversion: scale and pad when the target needs it,
    /// then BT.709 limited-range 4:2:0, the matrix the tags declare.
    /// `upload` finishes the chain for encoders fed through hardware frames.
    pub fn video_filter(&self, upload: Option<&str>) -> String {
        let mut chain = Vec::new();
        if self.content != self.input {
            chain.push(format!(
                "scale={}:{}:flags=lanczos",
                self.content.0, self.content.1
            ));
        }
        if self.output != self.content {
            chain.push(format!(
                "pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black",
                self.output.0, self.output.1
            ));
        }
        chain.push("scale=out_color_matrix=bt709:out_range=tv".into());
        // Frame properties win over encoder options in current FFmpeg: tag
        // the frames themselves so every encoder writes all three in its VUI.
        chain.push(TAGS.into());
        chain.push(match upload {
            Some(upload) => upload.to_owned(),
            None => "format=yuv420p".into(),
        });
        chain.join(",")
    }

    /// Codec-independent video options: tags, closed GOPs of one second.
    pub fn common_args(&self) -> Vec<String> {
        [
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-colorspace",
            "bt709",
            "-color_range",
            "tv",
            "-g",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain([self.fps.max(1).to_string(), "-flags".into(), "+cgop".into()])
        .collect()
    }

    /// Rate control and profile for one encoder.
    pub fn codec_args(&self, encoder: &str) -> Vec<String> {
        let q = self.target.quality().to_string();
        let q = q.as_str();
        let level = h264_level(self.output.0, self.output.1, self.fps);
        let mut args: Vec<String> = match encoder {
            "libx264" => vec![
                "-preset",
                "veryfast",
                "-crf",
                q,
                "-profile:v",
                "high",
                "-level",
                level,
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            "h264_nvenc" => [
                "-preset",
                "p4",
                "-rc",
                "vbr",
                "-cq",
                q,
                "-b:v",
                "0",
                "-profile:v",
                "high",
                "-level",
                level,
                "-bf",
                "2",
                "-b_ref_mode",
                "disabled",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            "h264_qsv" => [
                "-preset",
                "veryfast",
                "-global_quality",
                q,
                "-profile:v",
                "high",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            "h264_amf" => [
                "-quality",
                "speed",
                "-rc",
                "cqp",
                "-qp_i",
                q,
                "-qp_p",
                q,
                "-profile:v",
                "high",
                "-level",
                level,
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            // VAAPI spells whole levels without ".0".
            _ => [
                "-qp",
                q,
                "-profile:v",
                "high",
                "-level",
                level.trim_end_matches(".0"),
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        };
        if self.target == Target::X && !matches!(encoder, "h264_amf" | "h264_vaapi") {
            args.extend(["-maxrate", X_MAXRATE, "-bufsize", X_BUFSIZE].map(str::to_owned));
        }
        args
    }

    /// Width, height and frame rate of the file delivered: a Discord fit's
    /// (`fit`), else this plan's.
    pub fn delivered(&self, fit: &Value) -> (u32, u32, u32) {
        let field = |key: &str, default: u32| {
            fit[key]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(default)
        };
        (
            field("width", self.output.0),
            field("height", self.output.1),
            field("fps", self.fps),
        )
    }

    /// AAC-LC, 48 kHz stereo.
    pub fn audio_args(&self) -> Vec<String> {
        audio(self.target.audio_kbps())
    }

    /// One line when the composition breaks the target's limits.
    pub fn warning(&self, seconds: f64) -> Option<String> {
        match self.target {
            Target::X if seconds > X_SECONDS => Some(format!(
                "Longer than X's {} s limit ({}); X rejects it without Premium",
                X_SECONDS as u32,
                clock(seconds)
            )),
            Target::Discord { megabytes } => {
                let fit = Fit::new(self, megabytes, seconds);
                (fit.video_kbps < MIN_FIT_KBPS).then(|| {
                    format!(
                        "Too long for {}: choose a larger size or shorten it",
                        size_label(megabytes)
                    )
                })
            }
            _ => None,
        }
    }

    /// What the studio shows under "Export for".
    pub fn describe(&self, seconds: f64) -> Value {
        let fit = match self.target {
            Target::Discord { megabytes } => Some(Fit::new(self, megabytes, seconds)),
            _ => None,
        };
        let (width, height) = fit.as_ref().map_or(self.output, |f| f.size);
        json!({
            "export_for": self.target.name(),
            "width": width,
            "height": height,
            "fps": fit.as_ref().map_or(self.fps, |f| f.fps),
            "video_kbps": fit.as_ref().map(|f| f.video_kbps),
            "warning": self.warning(seconds),
        })
    }
}

fn audio(kbps: u32) -> Vec<String> {
    [
        "-c:a".to_owned(),
        "aac".into(),
        "-profile:a".into(),
        "aac_low".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        format!("{kbps}k"),
    ]
    .into()
}

fn clock(seconds: f64) -> String {
    let s = seconds.round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}
fn size_label(megabytes: u32) -> String {
    if megabytes >= 1000 {
        format!("{} GB", megabytes / 1000)
    } else {
        format!("{megabytes} MB")
    }
}

/// The lowest H.264 level whose macroblock rate, frame size and frame
/// dimensions hold the stream (Rec. ITU-T H.264 Table A-1). 4.1 rather
/// than 4.0 for its bitrate headroom; 3.1 at least.
pub(super) fn h264_level(width: u32, height: u32, fps: u32) -> &'static str {
    const LEVELS: [(&str, u64, u64); 10] = [
        ("3.1", 108_000, 3_600),
        ("3.2", 216_000, 5_120),
        ("4.1", 245_760, 8_192),
        ("4.2", 522_240, 8_704),
        ("5.0", 589_824, 22_080),
        ("5.1", 983_040, 36_864),
        ("5.2", 2_073_600, 36_864),
        ("6.0", 4_177_920, 139_264),
        ("6.1", 8_355_840, 139_264),
        ("6.2", 16_711_680, 139_264),
    ];
    let (mw, mh) = (
        u64::from(width.div_ceil(16)),
        u64::from(height.div_ceil(16)),
    );
    let frame = mw * mh;
    LEVELS
        .iter()
        .find(|(_, rate, size)| {
            frame <= *size && frame * u64::from(fps) <= *rate && mw.max(mh).pow(2) <= 8 * size
        })
        .map_or("6.2", |(name, ..)| name)
}

const MIN_FIT_KBPS: u32 = 100;

/// A Discord size fit: bitrates for the file to stay under the limit and the
/// picture size those bits can carry.
struct Fit {
    video_kbps: u32,
    audio_kbps: u32,
    size: (u32, u32),
    fps: u32,
    limit: u64,
}
impl Fit {
    fn new(plan: &Plan, megabytes: u32, seconds: f64) -> Self {
        // 3 % below the limit, 1 % of the rest for the MP4 container.
        let limit = u64::from(megabytes) * 970_000;
        let audio_kbps = if megabytes <= 20 { 96 } else { 128 };
        let total = limit as f64 * 8.0 * 0.99 / seconds.max(0.1) / 1000.0;
        let video_kbps = (total - f64::from(audio_kbps)).max(0.0) as u32;
        let (w, h) = (f64::from(plan.output.0), f64::from(plan.output.1));
        let fps = capped_fps(plan.fps, FIT_FPS);
        let bpp = f64::from(video_kbps) * 1000.0 / (w * h * f64::from(fps));
        // Too few bits for the frame: scale down (not below 360 on the short side).
        let s = if bpp < FIT_BPP {
            (bpp / FIT_BPP).sqrt().max(360.0 / w.min(h)).min(1.0)
        } else {
            1.0
        };
        Self {
            video_kbps,
            audio_kbps,
            size: (even(w * s), even(h * s)),
            fps,
            limit,
        }
    }
}

/// Re-encodes a finished export to fit Discord's size limit: two-pass x264
/// at the bitrate the duration allows, smaller if those bits can't carry the
/// frame, then checks the size and retries lower if it overshot.
pub(super) async fn fit(
    executable: &str,
    file: &FsPath,
    plan: &Plan,
    seconds: f64,
) -> Result<Value, String> {
    let Target::Discord { megabytes } = plan.target else {
        return Ok(Value::Null);
    };
    let fit = Fit::new(plan, megabytes, seconds);
    if fit.video_kbps < MIN_FIT_KBPS {
        return Err(format!(
            "A {} video can't fit {}; choose a larger Discord size",
            clock(seconds),
            size_label(megabytes)
        ));
    }
    let staged = file.with_extension("fit.mp4");
    let log = file.with_extension("passlog");
    let level = h264_level(fit.size.0, fit.size.1, fit.fps);
    let rate_filter = if fit.fps < plan.fps {
        format!("fps={},", fit.fps)
    } else {
        String::new()
    };
    let mut kbps = fit.video_kbps;
    let mut result = Err("Discord fit did not run".to_owned());
    for _ in 0..3 {
        let rate = format!("{kbps}k");
        let video = |pass: &str| -> Vec<String> {
            [
                "-vf".to_owned(),
                format!(
                    "{rate_filter}scale={}:{}:flags=lanczos:in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,{TAGS},format=yuv420p",
                    fit.size.0, fit.size.1
                ),
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-b:v".into(),
                rate.clone(),
                "-maxrate".into(),
                format!("{}k", kbps * 3 / 2),
                "-bufsize".into(),
                format!("{}k", kbps * 2),
                "-profile:v".into(),
                "high".into(),
                "-level".into(),
                level.into(),
                "-pass".into(),
                pass.into(),
                "-passlogfile".into(),
                log.display().to_string(),
            ]
            .into_iter()
            .chain(Plan { fps: fit.fps, ..*plan }.common_args())
            .collect()
        };
        for pass in ["1", "2"] {
            let mut command = tokio::process::Command::new(executable);
            crate::budget::background(&mut command)
                .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
                .arg(file)
                .args(video(pass));
            if pass == "1" {
                command.args(["-an", "-f", "null", "-"]);
            } else {
                command
                    .args(audio(fit.audio_kbps))
                    .args(["-movflags", "+faststart"])
                    .arg(&staged);
            }
            let output = command
                .kill_on_drop(true)
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                cleanup(&log, &staged).await;
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
        }
        let bytes = tokio::fs::metadata(&staged)
            .await
            .map_err(|e| e.to_string())?
            .len();
        if bytes <= fit.limit {
            tokio::fs::rename(&staged, file)
                .await
                .map_err(|e| e.to_string())?;
            result = Ok(
                json!({"bytes":bytes,"video_kbps":kbps,"width":fit.size.0,"height":fit.size.1,"fps":fit.fps}),
            );
            break;
        }
        kbps = (f64::from(kbps) * fit.limit as f64 / bytes as f64 * 0.97) as u32;
        result = Err(format!("Could not fit {}", size_label(megabytes)));
        if kbps < MIN_FIT_KBPS {
            break;
        }
    }
    cleanup(&log, &staged).await;
    result
}

async fn cleanup(log: &FsPath, staged: &FsPath) {
    let _ = tokio::fs::remove_file(staged).await;
    for suffix in [
        "-0.log",
        "-0.log.mbtree",
        "-0.log.temp",
        "-0.log.mbtree.temp",
    ] {
        let _ = tokio::fs::remove_file(format!("{}{suffix}", log.display())).await;
    }
}

#[derive(Deserialize)]
pub(super) struct PlanQuery {
    export_for: String,
    #[serde(default)]
    discord_mb: Option<u32>,
    width: u32,
    height: u32,
    fps: u32,
    seconds: f64,
}
/// `GET /v1/render/plan`: what an export for a target becomes, for the studio.
pub(super) async fn plan(Query(query): Query<PlanQuery>) -> Result<Json<Value>, Error> {
    crate::output::check_size(query.width, query.height)?;
    if !(1..=240).contains(&query.fps) || !query.seconds.is_finite() || query.seconds < 0.0 {
        return Err(error("Invalid frame rate or duration"));
    }
    let target = Target::parse(&query.export_for, query.discord_mb.unwrap_or(DISCORD_MB[0]))
        .map_err(error)?;
    let plan = Plan::new(target, query.width, query.height, target.fps(query.fps));
    Ok(Json(plan.describe(query.seconds)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_follow_size_and_rate() {
        assert_eq!(h264_level(1280, 720, 30), "3.1");
        assert_eq!(h264_level(1920, 1080, 30), "4.1");
        assert_eq!(h264_level(1920, 1080, 60), "4.2");
        assert_eq!(h264_level(1080, 1920, 60), "4.2");
        assert_eq!(h264_level(2560, 1080, 60), "5.1");
        assert_eq!(h264_level(2560, 1080, 120), "5.2");
        assert_eq!(h264_level(3840, 2160, 60), "5.2");
        assert_eq!(h264_level(7680, 4320, 60), "6.1");
    }

    #[test]
    fn x_caps_rate_size_and_aspect() {
        assert_eq!(Target::X.fps(120), 40);
        assert_eq!(Target::X.fps(60), 30);
        assert_eq!(Target::X.fps(144), 36);
        assert_eq!(Target::X.fps(30), 30);
        assert_eq!(Target::X.fps(41), 30);
        assert_eq!(Target::Standard.fps(120), 120);
        // The user's 2560×1080 at 120: 1920×810 at 40 fps, within 2.39:1.
        let plan = Plan::new(Target::X, 2560, 1080, Target::X.fps(120));
        assert_eq!(
            (plan.output, plan.content, plan.fps),
            ((1920, 810), (1920, 810), 40)
        );
        // 32:9 is wider than 2.39:1: letterboxed, then fitted.
        let plan = Plan::new(Target::X, 3840, 1080, 60);
        assert_eq!(plan.content, (1920, 540));
        assert_eq!(plan.output, (1920, 804));
        assert!(plan.video_filter(None).contains("pad=1920:804:"));
        // Portrait fits 1200×1900.
        let plan = Plan::new(Target::X, 1080, 1920, 60);
        assert_eq!(plan.output, (1068, 1900));
        // Small outputs are left alone.
        let plan = Plan::new(Target::X, 1280, 720, 30);
        assert_eq!(plan.output, (1280, 720));
        assert_eq!(
            plan.video_filter(None),
            "scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p"
        );
        assert!(plan.warning(141.0).unwrap().contains("140 s"));
        assert!(plan.warning(140.0).is_none());
    }

    #[test]
    fn encoder_arguments_per_target() {
        let has = |args: &[String], pair: [&str; 2]| {
            args.windows(2).any(|w| w[0] == pair[0] && w[1] == pair[1])
        };
        let standard = Plan::new(Target::Standard, 2560, 1080, 120);
        let x264 = standard.codec_args("libx264");
        assert!(
            has(&x264, ["-profile:v", "high"])
                && has(&x264, ["-level", "5.2"])
                && has(&x264, ["-crf", "18"])
        );
        assert!(!x264.iter().any(|a| a == "-maxrate"));
        let nvenc = standard.codec_args("h264_nvenc");
        assert!(
            has(&nvenc, ["-b_ref_mode", "disabled"])
                && has(&nvenc, ["-level", "5.2"])
                && has(&nvenc, ["-cq", "18"])
        );
        let x = Plan::new(Target::X, 2560, 1080, 40);
        assert!(has(&x.codec_args("libx264"), ["-maxrate", "20M"]));
        assert!(has(&x.codec_args("h264_nvenc"), ["-bufsize", "40M"]));
        assert!(has(&x.codec_args("libx264"), ["-level", "4.1"]));
        let youtube = Plan::new(Target::YouTube, 1920, 1080, 60);
        assert!(has(&youtube.codec_args("libx264"), ["-crf", "14"]));
        assert!(has(&youtube.audio_args(), ["-b:a", "320k"]));
        assert!(has(
            &Plan::new(Target::Standard, 64, 64, 60).codec_args("h264_vaapi"),
            ["-level", "3.1"]
        ));
        assert!(has(
            &Plan::new(Target::Standard, 2560, 1440, 60).codec_args("h264_vaapi"),
            ["-level", "5.1"]
        ));
        assert!(has(
            &Plan::new(Target::Standard, 2560, 1440, 30).codec_args("h264_vaapi"),
            ["-level", "5"]
        ));
        let common = standard.common_args();
        for pair in [
            ["-colorspace", "bt709"],
            ["-color_range", "tv"],
            ["-g", "120"],
            ["-flags", "+cgop"],
        ] {
            assert!(has(&common, pair), "{pair:?}");
        }
        let audio = standard.audio_args();
        for pair in [["-profile:a", "aac_low"], ["-ar", "48000"], ["-ac", "2"]] {
            assert!(has(&audio, pair));
        }
        assert_eq!(
            standard.video_filter(Some("format=nv12,hwupload")),
            "scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=nv12,hwupload"
        );
    }

    #[test]
    fn discord_fits_the_size_and_scales_down_long_videos() {
        assert!(Target::parse("discord", 10).is_err());
        assert!(Target::parse("tiktok", 20).is_err());
        let target = Target::parse("discord", 20).unwrap();
        let plan = Plan::new(target, 1920, 1080, 60);
        let fit = Fit::new(&plan, 20, 60.0);
        // 20 MB over a minute: about 2.4 Mbps of video, carried at a smaller size.
        assert!((2400..2600).contains(&fit.video_kbps), "{}", fit.video_kbps);
        assert!(fit.size.0 < 1920 && fit.size.1 >= 360 && fit.size.0.is_multiple_of(2));
        let big = Fit::new(&plan, 1000, 60.0);
        assert_eq!((big.size, big.fps), ((1920, 1080), 60));
        // 120 fps halves before the picture shrinks.
        let fast = Fit::new(&Plan::new(target, 2560, 1080, 120), 20, 50.0);
        assert_eq!(fast.fps, 60);
        assert!(fast.size.0 > 1600, "{:?}", fast.size);
        assert_eq!(capped_fps(144, 60), 48);
        assert!(plan.warning(60.0).is_none());
        assert!(plan.warning(3600.0).unwrap().contains("20 MB"));
        assert_eq!(plan.describe(60.0)["video_kbps"], json!(fit.video_kbps));
    }
}
