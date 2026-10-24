//! Select an encoder by actually opening it, not merely trusting FFmpeg's build flags.
//! Its options come from the export plan (`share.rs`), so the probe opens it
//! exactly as the export will: profile, level, size and frame rate.
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;

#[derive(Debug)]
pub(super) struct Encoder {
    pub name: &'static str,
    device: Option<PathBuf>,
    /// Filter that hands frames to the encoder's hardware (VAAPI).
    upload: Option<&'static str>,
    gpu: Option<String>,
}
impl Encoder {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            device: None,
            upload: None,
            gpu: None,
        }
    }
    pub fn command(&self, executable: &str) -> Command {
        let mut command = Command::new(executable);
        if let Some(uuid) = &self.gpu {
            command
                .env("CUDA_VISIBLE_DEVICES", uuid)
                .env("CUDA_DEVICE_ORDER", "PCI_BUS_ID");
        }
        if let Some(device) = &self.device {
            command.arg("-vaapi_device").arg(device);
        }
        command
    }
    /// Video filter, pixel format, codec and tags for `plan`.
    pub fn configure(&self, command: &mut Command, plan: &crate::share::Plan) {
        command.arg("-vf").arg(plan.video_filter(self.upload));
        if self.upload.is_none() {
            command.args(["-pix_fmt", "yuv420p"]);
        }
        command
            .args(["-c:v", self.name])
            .args(plan.codec_args(self.name))
            .args(plan.common_args());
        if self.gpu.is_some() {
            command.args(["-gpu", "0"]);
        }
    }
}
fn software() -> Encoder {
    Encoder::new("libx264")
}
fn hardware() -> Vec<Encoder> {
    let mut encoders = vec![Encoder::new("h264_nvenc")];
    if cfg!(windows) {
        encoders.push(Encoder::new("h264_qsv"));
        encoders.push(Encoder::new("h264_amf"));
    }
    if cfg!(target_os = "linux")
        && let Ok(devices) = std::fs::read_dir("/dev/dri")
    {
        let mut devices = devices
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("renderD"))
            })
            .collect::<Vec<_>>();
        devices.sort();
        for device in devices {
            let mut encoder = Encoder::new("h264_vaapi");
            encoder.upload = Some("format=nv12,hwupload");
            encoder.device = Some(device);
            encoders.push(encoder);
        }
    }
    encoders
}
async fn available(
    executable: &str,
    encoder: &Encoder,
    plan: &crate::share::Plan,
) -> Result<bool, String> {
    let mut command = encoder.command(executable);
    command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
        .args([
            "-f",
            "lavfi",
            "-i",
            &format!(
                "color=size={}x{}:rate={},format=rgba",
                plan.input.0, plan.input.1, plan.fps
            ),
            "-frames:v",
            "1",
        ]);
    encoder.configure(&mut command, plan);
    command
        .args(["-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let child = command.spawn().map_err(|e| {
        format!("Cannot launch FFmpeg ({e}); set the FFmpeg path in the tool's settings")
    })?;
    Ok(
        tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
            .await
            .is_ok_and(|result| result.is_ok_and(|output| output.status.success())),
    )
}
pub(super) async fn select(
    executable: &str,
    preference: &str,
    plan: &crate::share::Plan,
    gpu: Option<&crate::gpu::Gpu>,
) -> Result<Encoder, String> {
    if !matches!(preference, "auto" | "hardware" | "software") {
        return Err("Encoder must be auto, hardware or software".into());
    }
    if preference != "software" {
        for mut encoder in hardware() {
            if let Some(gpu) = gpu {
                if encoder.name != "h264_nvenc" {
                    continue;
                }
                encoder.gpu = Some(gpu.uuid.clone());
            }
            if available(executable, &encoder, plan).await? {
                return Ok(encoder);
            }
        }
        if preference == "hardware" {
            return Err("No working hardware H.264 encoder for this size; choose auto or software in settings".into());
        }
    }
    let encoder = software();
    if available(executable, &encoder, plan).await? {
        Ok(encoder)
    } else {
        Err("FFmpeg has no working libx264 encoder; install an FFmpeg build with H.264 encoding support".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::share::{Plan, Target};
    fn args(encoder: &Encoder, plan: &Plan) -> Vec<String> {
        let mut command = encoder.command("ffmpeg");
        encoder.configure(&mut command, plan);
        command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }
    #[test]
    fn pinned_nvenc_uses_uuid_and_local_ordinal_zero() {
        let mut encoder = Encoder::new("h264_nvenc");
        encoder.gpu = Some("GPU-spare".into());
        let command = encoder.command("ffmpeg");
        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(key, value)| key == "CUDA_VISIBLE_DEVICES"
                    && value == Some(std::ffi::OsStr::new("GPU-spare")))
        );
        let plan = Plan::new(Target::Standard, 1920, 1080, 60);
        assert!(
            args(&encoder, &plan)
                .windows(2)
                .any(|pair| pair == ["-gpu", "0"])
        );
    }
    #[test]
    fn every_encoder_gets_profile_tags_and_conversion() {
        let plan = Plan::new(Target::X, 2560, 1080, 40);
        for encoder in [software(), Encoder::new("h264_nvenc")] {
            let args = args(&encoder, &plan);
            let pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
            assert!(pair("-c:v", encoder.name));
            assert!(pair("-profile:v", "high") && pair("-pix_fmt", "yuv420p"));
            assert!(pair("-colorspace", "bt709") && pair("-g", "40"));
            assert!(pair(
                "-vf",
                "scale=1920:810:flags=lanczos,scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p"
            ));
        }
        let mut vaapi = Encoder::new("h264_vaapi");
        vaapi.upload = Some("format=nv12,hwupload");
        vaapi.device = Some("/dev/dri/renderD128".into());
        let args = args(&vaapi, &plan);
        assert!(!args.iter().any(|a| a == "-pix_fmt"));
        assert!(args.iter().any(|a| a.ends_with("format=nv12,hwupload")));
    }
    #[tokio::test]
    async fn invalid_preference_does_not_launch_a_process() {
        let plan = Plan::new(Target::Standard, 1920, 1080, 60);
        assert!(
            select("does-not-exist", "typo", &plan, None)
                .await
                .unwrap_err()
                .contains("auto")
        );
    }
}
