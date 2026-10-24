//! How many parallel workers an export runs, and how export processes yield
//! to the game. Auto picks the smallest of what the CPU threads, the free
//! memory, the free hardware-encoder sessions and the export itself allow, and
//! says which one set the count.
/// Memory one worker (its Chrome, FFmpeg and frame buffers) may hold at
/// `width` x `height`: a fixed part plus 48 frames' worth of RGBA. Measured at
/// 1920x1080: a worker peaks near 0.6 GiB with an overlay (8 workers: 4.9 GiB)
/// and 1.2 GiB without one at 70 fps; this estimate gives 0.75 GiB there.
pub(crate) fn worker_bytes(width: u32, height: u32) -> u64 {
    (384 << 20) + 48 * 4 * u64::from(width) * u64::from(height)
}
/// Memory left for everything else on the machine.
const HEADROOM: u64 = 1 << 30;
/// CPU threads kept for a running game (its update, draw and audio threads).
const GAME_THREADS: usize = 2;
/// CPU threads one worker keeps busy (Chrome's main, raster and GPU threads,
/// plus FFmpeg).
const THREADS_PER_WORKER: usize = 4;
/// Concurrent NVENC sessions a GeForce driver allows (NVIDIA's limit since
/// driver 550; professional cards allow more, and exports use at most 8).
const NVENC_SESSIONS: u32 = 8;

/// What the machine offers an export when it starts.
#[derive(Clone, Debug, Default)]
pub(crate) struct Machine {
    /// Logical CPUs this process may run on.
    pub threads: usize,
    /// Memory that can still be used, after cgroup limits; `None`: unknown.
    pub available: Option<u64>,
    /// vosu has an osu! instance (the game is running).
    pub game: bool,
    /// NVENC sessions not already open; `None`: no NVIDIA encoder to count.
    pub nvenc_free: Option<u32>,
}

/// The chosen worker count, why, and the CPU threads the export may use.
#[derive(Clone, Debug)]
pub(crate) struct Workers {
    pub count: u32,
    pub reason: String,
    /// CPU threads for the export (all of them, less the game's).
    pub threads: usize,
}

fn gib(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / f64::from(1 << 30))
}

impl Machine {
    pub(crate) fn export_threads(&self) -> usize {
        if self.game {
            self.threads.saturating_sub(GAME_THREADS).max(1)
        } else {
            self.threads.max(1)
        }
    }

    /// A fixed count from the "Parallel jobs" setting.
    pub(crate) fn fixed(&self, count: u32) -> Workers {
        Workers {
            count,
            reason: format!(
                "{count} worker{} (set in Parallel jobs)",
                if count == 1 { "" } else { "s" }
            ),
            threads: self.export_threads(),
        }
    }

    /// Auto: the smallest of the limits below, each named in the reason.
    pub(crate) fn auto(&self, width: u32, height: u32, overlays: bool) -> Workers {
        let threads = self.export_threads();
        let mut limits: Vec<(u32, String)> = Vec::new();
        limits.push((
            u32::try_from(threads / THREADS_PER_WORKER)
                .unwrap_or(u32::MAX)
                .max(1),
            if self.game {
                format!(
                    "{threads} of {} CPU threads ({GAME_THREADS} kept for osu!)",
                    self.threads
                )
            } else {
                format!("{threads} CPU threads")
            },
        ));
        if let Some(available) = self.available {
            let each = worker_bytes(width, height);
            limits.push((
                u32::try_from(available.saturating_sub(HEADROOM) / each)
                    .unwrap_or(u32::MAX)
                    .max(1),
                format!("{} memory free, ~{} per worker", gib(available), gib(each)),
            ));
        }
        if let Some(free) = self.nvenc_free {
            limits.push((free.max(1), format!("{free} NVENC sessions free")));
        }
        // Raw-frame-only workers saturate transfer and encoding beyond four;
        // overlay screenshots keep gaining up to eight.
        limits.push(if overlays {
            (8, "at most 8 workers".to_owned())
        } else {
            (4, "at most 4 workers without overlays".to_owned())
        });
        let count = limits.iter().map(|(n, _)| *n).min().unwrap_or(1);
        let binding = limits
            .iter()
            .filter(|(n, _)| *n == count)
            .map(|(_, why)| why.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        Workers {
            count,
            reason: format!(
                "{count} worker{} (auto: {binding})",
                if count == 1 { "" } else { "s" }
            ),
            threads,
        }
    }
}

/// What this machine offers now. `game` comes from vosu's context, `gpu` is
/// the pinned render GPU (else every NVIDIA GPU counts), and `hardware` is
/// false when the export is set to the software encoder.
pub(crate) async fn machine(game: bool, gpu: Option<&str>, hardware: bool) -> Machine {
    Machine {
        threads: std::thread::available_parallelism().map_or(1, usize::from),
        available: available_memory(),
        game,
        nvenc_free: if hardware {
            nvenc_free(gpu).await
        } else {
            None
        },
    }
}

/// Free NVENC sessions on the pinned GPU, or the busiest NVIDIA GPU.
async fn nvenc_free(gpu: Option<&str>) -> Option<u32> {
    let mut command = tokio::process::Command::new("nvidia-smi");
    if let Some(pci) = gpu {
        command.args(["-i", pci]);
    }
    command
        .args([
            "--query-gpu=encoder.stats.sessionCount",
            "--format=csv,noheader,nounits",
        ])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let busiest = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .max()?;
    Some(NVENC_SESSIONS.saturating_sub(busiest))
}

#[cfg(target_os = "linux")]
fn available_memory() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let mut available = field(&meminfo, "MemAvailable:")? * 1024;
    // cgroup v2: every ancestor's memory.max applies, less what it holds
    // (reclaimable page cache excluded).
    if let Some(path) = std::fs::read_to_string("/proc/self/cgroup")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("0::").map(str::to_owned))
        })
    {
        let root = std::path::Path::new("/sys/fs/cgroup");
        let mut dir = root.join(path.trim_start_matches('/'));
        while dir.starts_with(root) && dir != root {
            if let Some(room) = cgroup_room(&dir) {
                available = available.min(room);
            }
            dir.pop();
        }
    }
    Some(available)
}

#[cfg(target_os = "linux")]
fn cgroup_room(dir: &std::path::Path) -> Option<u64> {
    let max = std::fs::read_to_string(dir.join("memory.max")).ok()?;
    let max = max.trim().parse::<u64>().ok()?;
    let current = std::fs::read_to_string(dir.join("memory.current"))
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    let reclaimable = std::fs::read_to_string(dir.join("memory.stat"))
        .ok()
        .and_then(|stat| field(&stat, "inactive_file"))
        .unwrap_or(0);
    Some(max.saturating_sub(current.saturating_sub(reclaimable)))
}

#[cfg(target_os = "linux")]
fn field(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let rest = line.strip_prefix(name)?;
        rest.split_whitespace().next()?.parse().ok()
    })
}

#[cfg(windows)]
fn available_memory() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    // SAFETY: `status` is a correctly sized, writable MEMORYSTATUSEX.
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullAvailPhys)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn available_memory() -> Option<u64> {
    None
}

/// Runs an export process below normal CPU priority (children inherit it), so
/// a game sharing the CPUs keeps its frame rate.
pub(crate) fn background(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(unix)]
    // SAFETY: `nice` is async-signal-safe; a failure keeps the priority.
    unsafe {
        command.pre_exec(|| {
            libc::nice(10);
            Ok(())
        });
    }
    #[cfg(windows)]
    command.creation_flags(0x0000_4000); // BELOW_NORMAL_PRIORITY_CLASS
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    fn machine(
        threads: usize,
        available: Option<u64>,
        game: bool,
        nvenc_free: Option<u32>,
    ) -> Machine {
        Machine {
            threads,
            available,
            game,
            nvenc_free,
        }
    }

    #[test]
    fn auto_takes_the_tightest_limit_and_names_it() {
        let big = machine(32, Some(64 * GIB), false, Some(8)).auto(1920, 1080, true);
        assert_eq!(big.count, 8);
        assert_eq!(
            big.reason,
            "8 workers (auto: 32 CPU threads, 8 NVENC sessions free, at most 8 workers)"
        );
        let six = machine(12, Some(16 * GIB), false, Some(8)).auto(1920, 1080, true);
        assert_eq!(
            (six.count, six.reason.as_str()),
            (3, "3 workers (auto: 12 CPU threads)")
        );
        let small = machine(4, Some(4 * GIB), false, None).auto(1920, 1080, false);
        assert_eq!(small.count, 1);
        assert!(small.reason.contains("4 CPU threads"), "{}", small.reason);
        let tight = machine(32, Some(3 * GIB), false, Some(8)).auto(1920, 1080, true);
        assert_eq!(tight.count, 2);
        assert!(
            tight
                .reason
                .contains("3.0 GiB memory free, ~0.7 GiB per worker"),
            "{}",
            tight.reason
        );
        let sessions = machine(32, Some(64 * GIB), false, Some(2)).auto(1920, 1080, true);
        assert_eq!(
            (sessions.count, sessions.reason.as_str()),
            (2, "2 workers (auto: 2 NVENC sessions free)")
        );
        let none_free = machine(32, Some(64 * GIB), false, Some(0)).auto(1920, 1080, true);
        assert_eq!(none_free.count, 1);
    }

    #[test]
    fn a_running_game_keeps_cpu_threads() {
        let playing = machine(12, Some(16 * GIB), true, None).auto(1920, 1080, true);
        assert_eq!(playing.count, 2);
        assert_eq!(playing.threads, 10);
        assert_eq!(
            playing.reason,
            "2 workers (auto: 10 of 12 CPU threads (2 kept for osu!))"
        );
        assert_eq!(machine(2, None, true, None).export_threads(), 1);
        assert_eq!(
            machine(12, None, true, None).fixed(5).reason,
            "5 workers (set in Parallel jobs)"
        );
    }

    #[test]
    fn bigger_frames_cost_more_per_worker() {
        assert!(worker_bytes(3840, 2160) > 3 * worker_bytes(1280, 720));
        let uhd = machine(32, Some(8 * GIB), false, None).auto(3840, 2160, true);
        assert_eq!(uhd.count, 3);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_machine_reports_memory() {
        assert!(available_memory().is_some_and(|bytes| bytes > 0));
    }
}
