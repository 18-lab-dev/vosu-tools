//! Select an encoder by actually opening it, not merely trusting FFmpeg's build flags.
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;

#[derive(Debug)]
pub(super) struct Encoder {
    pub name: &'static str,
    device: Option<PathBuf>,
    pub output: &'static [&'static str],
    gpu: Option<String>,
}
impl Encoder {
    fn new(name: &'static str, options: &'static [&'static str]) -> Self {
        Self {
            name,
            device: None,
            output: options,
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
    pub fn configure(&self, command: &mut Command) {
        command.args(["-c:v", self.name]).args(self.output);
        if self.gpu.is_some() {
            command.args(["-gpu", "0"]);
        }
    }
}
fn software() -> Encoder {
    Encoder::new("libx264", &["-preset", "veryfast", "-crf", "18"])
}
fn hardware() -> Vec<Encoder> {
    let mut encoders = vec![Encoder::new(
        "h264_nvenc",
        &["-preset", "p4", "-rc", "vbr", "-cq", "18", "-b:v", "0"],
    )];
    if cfg!(windows) {
        encoders.push(Encoder::new(
            "h264_qsv",
            &["-preset", "veryfast", "-global_quality", "18"],
        ));
        encoders.push(Encoder::new(
            "h264_amf",
            &[
                "-quality", "speed", "-rc", "cqp", "-qp_i", "18", "-qp_p", "18",
            ],
        ));
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
            let mut encoder = Encoder::new(
                "h264_vaapi",
                &[
                    "-vf",
                    "format=nv12,hwupload",
                    "-qp",
                    "18",
                    "-pix_fmt",
                    "vaapi",
                ],
            );
            encoder.device = Some(device);
            encoders.push(encoder);
        }
    }
    encoders
}
async fn available(
    executable: &str,
    encoder: &Encoder,
    width: u32,
    height: u32,
) -> Result<bool, String> {
    let mut command = encoder.command(executable);
    command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
        .args([
            "-f",
            "lavfi",
            "-i",
            &format!("color=size={width}x{height}:rate=60,format=rgba"),
            "-frames:v",
            "1",
        ])
        .args(["-pix_fmt", "yuv420p"]);
    encoder.configure(&mut command);
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
    width: u32,
    height: u32,
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
            if available(executable, &encoder, width, height).await? {
                return Ok(encoder);
            }
        }
        if preference == "hardware" {
            return Err("No working hardware H.264 encoder for this size; choose auto or software in settings".into());
        }
    }
    let encoder = software();
    if available(executable, &encoder, width, height).await? {
        Ok(encoder)
    } else {
        Err("FFmpeg has no working libx264 encoder; install an FFmpeg build with H.264 encoding support".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quality_and_input_options_are_explicit() {
        assert_eq!(software().name, "libx264");
        assert!(
            software()
                .output
                .windows(2)
                .any(|pair| pair == ["-crf", "18"])
        );
        let nvenc = &hardware()[0];
        assert_eq!(nvenc.name, "h264_nvenc");
        assert!(nvenc.device.is_none());
        assert!(nvenc.output.windows(2).any(|pair| pair == ["-cq", "18"]));
    }
    #[tokio::test]
    async fn invalid_preference_does_not_launch_a_process() {
        assert!(
            select("does-not-exist", "typo", 1920, 1080, None)
                .await
                .unwrap_err()
                .contains("auto")
        );
    }
}
