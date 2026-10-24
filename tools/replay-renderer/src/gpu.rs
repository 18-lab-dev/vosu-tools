//! Opt-in Linux/NVIDIA pinning. Missing devices fail closed, never select another GPU.
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug)]
pub(super) struct Gpu {
    pub pci: String,
    pub index: u32,
    pub uuid: String,
    nodes: Vec<PathBuf>,
}

fn pci(value: &str) -> Result<String, String> {
    let value = value.trim();
    let value = if value.len() == 16 && value.starts_with("0000") {
        &value[4..]
    } else {
        value
    };
    let bytes = value.as_bytes();
    if bytes.len() != 12
        || bytes[4] != b':'
        || bytes[7] != b':'
        || bytes[10] != b'.'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, b)| ![4, 7, 10].contains(&i) && !b.is_ascii_hexdigit())
        || u8::from_str_radix(&value[8..10], 16).map_or(true, |slot| slot > 31)
        || !matches!(bytes[11], b'0'..=b'7')
    {
        return Err("render_gpu must be a PCI bus id such as 0000:01:00.0".into());
    }
    Ok(value.to_ascii_lowercase())
}

pub(super) async fn resolve(value: &str) -> Result<Option<Gpu>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    if !cfg!(target_os = "linux") {
        return Err("Explicit render_gpu currently requires Linux, NVIDIA and bubblewrap; leave it empty to use the system default GPU".into());
    }
    let pci = pci(value)?;
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=index,pci.bus_id,uuid",
            "--format=csv,noheader,nounits",
        ])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("Cannot resolve render_gpu with nvidia-smi: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let (index, uuid) = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let mut fields = line.split(',').map(str::trim);
            let index = fields.next()?.parse::<u32>().ok()?;
            let address = self::pci(fields.next()?).ok()?;
            let uuid = fields.next()?;
            (address == pci && uuid.starts_with("GPU-")).then(|| (index, uuid.to_owned()))
        })
        .ok_or_else(|| format!("render_gpu {pci} is not available on the NVIDIA host driver"))?;
    let info = tokio::fs::read_to_string(format!("/proc/driver/nvidia/gpus/{pci}/information"))
        .await
        .map_err(|e| format!("Cannot inspect render_gpu {pci}: {e}"))?;
    let minor: u32 = info
        .lines()
        .find_map(|line| {
            line.strip_prefix("Device Minor:")
                .and_then(|v| v.trim().parse().ok())
        })
        .ok_or("NVIDIA GPU information has no Device Minor")?;
    let mut nodes = vec![
        PathBuf::from("/dev/nvidiactl"),
        PathBuf::from("/dev/nvidia-uvm"),
        PathBuf::from(format!("/dev/nvidia{minor}")),
    ];
    let mut drm = tokio::fs::read_dir(format!("/sys/bus/pci/devices/{pci}/drm"))
        .await
        .map_err(|e| format!("render_gpu has no DRM render node: {e}"))?;
    let mut render = None;
    while let Some(entry) = drm.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name();
        if name.to_str().is_some_and(|name| {
            name.strip_prefix("renderD")
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        }) {
            render = Some(PathBuf::from("/dev/dri").join(name));
        }
    }
    nodes.push(
        render
            .ok_or("render_gpu has no DRM render node; bind it to the host NVIDIA driver first")?,
    );
    for node in &nodes {
        if !node.exists() {
            return Err(format!(
                "render_gpu device {} is missing; no fallback GPU will be used",
                node.display()
            ));
        }
    }
    for optional in ["/dev/nvidia-modeset", "/dev/nvidia-uvm-tools"] {
        if Path::new(optional).exists() {
            nodes.push(PathBuf::from(optional));
        }
    }
    Ok(Some(Gpu {
        pci,
        index,
        uuid,
        nodes,
    }))
}

impl Gpu {
    pub fn describe(&self) -> serde_json::Value {
        serde_json::json!({"pci":self.pci,"index":self.index,"uuid":self.uuid,"device_nodes":self.nodes})
    }
    pub fn browser(&self, executable: &Path, writable: &Path) -> Command {
        let mut command = Command::new("bwrap");
        command
            .env("CUDA_VISIBLE_DEVICES", &self.uuid)
            .env("CUDA_DEVICE_ORDER", "PCI_BUS_ID");
        command.args([
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--bind",
            "/tmp",
            "/tmp",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/dev/shm",
            "--dir",
            "/dev/dri",
        ]);
        for node in &self.nodes {
            command.arg("--dev-bind").arg(node).arg(node);
        }
        command
            .arg("--bind")
            .arg(writable)
            .arg(writable)
            .arg("--")
            .arg(executable);
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pci_ids_are_canonical_and_not_paths() {
        assert_eq!(pci("0000:01:00.0").unwrap(), "0000:01:00.0");
        assert_eq!(pci("00000000:12:00.0").unwrap(), "0000:12:00.0");
        for value in [
            "../dev/nvidia0",
            "0000:01:00.8",
            "0000:01:ff.0",
            "0000:01:00.0/x",
            "auto",
        ] {
            assert!(pci(value).is_err());
        }
    }
}
