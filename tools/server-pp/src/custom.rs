//! User-supplied pp calculators: sandboxed WebAssembly modules implementing
//! ABI v1 (`CALCULATORS.md`, layout in `abi/v1.rs`), configured through the
//! tool's settings.

// Some constants (ruleset numbers, slot group starts) exist for guests only.
#[allow(dead_code)]
pub mod abi {
    include!("../abi/v1.rs");
}

use crate::engine::{Input, Map};
use rosu_pp::{Difficulty, Performance, any::DifficultyAttributes, model::mode::GameMode};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use wasmi::{
    Config, Engine, ExternType, Linker, Memory, Module, Store, StoreLimits, StoreLimitsBuilder,
    TrapCode, TypedFunc, ValType,
};

/// Difficulty attributes and score states handed to modules come from this
/// calculator, with stable scoring.
pub const ATTRIBUTES: &str = "rosu-pp 4.0.1";
/// Built-in profile ids; custom calculators cannot shadow them.
pub const RESERVED: [&str; 2] = ["akatsuki", "mamestagram"];
const MAX_MODULE_BYTES: u64 = 16 * 1024 * 1024;
const DEFAULT_FUEL_MILLIONS: f64 = 10.0;
const DEFAULT_MEMORY_MIB: f64 = 16.0;
/// Settings and module files are re-read at most this often.
const REFRESH: Duration = Duration::from_secs(1);
const RULESETS: [&str; 4] = ["osu", "taiko", "fruits", "mania"];
const REQUIRED: [&str; 4] = [
    "vosu_pp_abi_version",
    "vosu_pp_input",
    "vosu_pp_output",
    "vosu_pp_calculate",
];
const OPTIONAL: [&str; 2] = ["vosu_pp_info", "vosu_pp_error"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// wasmi fuel per call (about one unit per executed instruction).
    pub fuel: u64,
    pub memory_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            fuel: (DEFAULT_FUEL_MILLIONS * 1e6) as u64,
            memory_bytes: (DEFAULT_MEMORY_MIB as usize) << 20,
        }
    }
}

/// Effective `calculators.*` settings.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub folder: PathBuf,
    /// Explicit module files with an optional id.
    pub files: Vec<(Option<String>, PathBuf)>,
    /// `None` enables every discovered module.
    pub enabled: Option<Vec<String>>,
    pub names: HashMap<String, String>,
    pub limits: Limits,
}

impl Settings {
    pub fn defaults(data_dir: &Path) -> Self {
        Self {
            folder: data_dir.join("calculators"),
            files: Vec::new(),
            enabled: None,
            names: HashMap::new(),
            limits: Limits::default(),
        }
    }

    /// Parses the effective settings object (`/tools/_host/v1/settings`).
    pub fn from_values(values: &Value, data_dir: &Path) -> Result<Self, String> {
        let text = |key: &str| values[key].as_str().unwrap_or("").trim().to_owned();
        let number = |key: &str, default: f64| {
            match &values[key] {
                Value::Number(n) => n.as_f64().ok_or(()),
                Value::String(s) if s.trim().is_empty() => Ok(default),
                Value::String(s) => s.trim().parse::<f64>().map_err(|_| ()),
                Value::Null => Ok(default),
                _ => Err(()),
            }
            .map_err(|()| format!("{key} must be a number"))
        };
        let mut settings = Self::defaults(data_dir);
        let folder = text("calculators.folder");
        if !folder.is_empty() {
            settings.folder = PathBuf::from(folder);
        }
        for line in lines(&text("calculators.files")) {
            let (id, path) = match line.split_once('=') {
                Some((id, path)) => (Some(id.trim().to_owned()), path.trim()),
                None => (None, line),
            };
            let path = Path::new(path);
            settings.files.push((
                id,
                if path.is_absolute() {
                    path.to_owned()
                } else {
                    settings.folder.join(path)
                },
            ));
        }
        let enabled = text("calculators.enabled");
        let enabled: Vec<String> = lines(if values.get("calculators.enabled").is_some() {
            &enabled
        } else {
            "*"
        })
        .map(str::to_owned)
        .collect();
        settings.enabled = (!enabled.iter().any(|id| id == "*")).then_some(enabled);
        for line in lines(&text("calculators.names")) {
            let (id, name) = line
                .split_once('=')
                .ok_or_else(|| format!("calculators.names: expected `id = name`, got {line:?}"))?;
            settings
                .names
                .insert(id.trim().to_owned(), name.trim().to_owned());
        }
        let fuel = number("calculators.fuel", DEFAULT_FUEL_MILLIONS)?;
        if !(0.01..=10_000.0).contains(&fuel) {
            return Err("calculators.fuel must be between 0.01 and 10000 (millions)".into());
        }
        let memory = number("calculators.memory_mib", DEFAULT_MEMORY_MIB)?;
        if !(1.0..=1024.0).contains(&memory) {
            return Err("calculators.memory_mib must be between 1 and 1024".into());
        }
        settings.limits = Limits {
            fuel: (fuel * 1e6) as u64,
            memory_bytes: (memory * 1024.0 * 1024.0) as usize,
        };
        Ok(settings)
    }
}

fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
}

/// Module ids: lowercase ASCII letters, digits, `-`, `_`, `.`; at most 64.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
}

fn id_from_stem(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let id: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    id.trim_matches('-').to_owned()
}

/// What a module declares about itself through `vosu_pp_info`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Info {
    pub name: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    /// Supported rulesets by number; all when the module does not say.
    pub rulesets: [bool; 4],
    /// Breakdown labels per ruleset.
    pub breakdown: [Vec<String>; 4],
}

impl Info {
    fn parse(text: Option<&str>) -> Result<Self, String> {
        let mut info = Self {
            rulesets: [true; 4],
            ..Self::default()
        };
        let Some(text) = text else {
            return Ok(info);
        };
        let value: Value =
            serde_json::from_str(text).map_err(|e| format!("vosu_pp_info is not JSON: {e}"))?;
        let object = value
            .as_object()
            .ok_or("vosu_pp_info must be a JSON object")?;
        let string = |key: &str| -> Result<Option<String>, String> {
            match object.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) if s.chars().count() <= 200 => Ok(Some(s.clone())),
                Some(_) => Err(format!(
                    "vosu_pp_info.{key} must be a string of at most 200 characters"
                )),
            }
        };
        info.name = string("name")?;
        info.version = string("version")?;
        info.author = string("author")?;
        info.description = string("description")?;
        if let Some(rulesets) = object.get("rulesets") {
            let rulesets = rulesets
                .as_array()
                .ok_or("vosu_pp_info.rulesets must be an array")?;
            info.rulesets = [false; 4];
            for ruleset in rulesets {
                info.rulesets[ruleset_index(ruleset).ok_or_else(|| {
                    format!("vosu_pp_info.rulesets: unknown ruleset {ruleset}")
                })?] = true;
            }
        }
        let labels = |value: &Value| -> Result<Vec<String>, String> {
            let labels = value
                .as_array()
                .ok_or("vosu_pp_info.breakdown entries must be arrays of labels")?;
            if labels.len() > abi::BREAKDOWN_SLOTS {
                return Err(format!(
                    "vosu_pp_info.breakdown allows at most {} labels",
                    abi::BREAKDOWN_SLOTS
                ));
            }
            labels
                .iter()
                .map(|label| {
                    label
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 64)
                        .map(str::to_owned)
                        .ok_or_else(|| "breakdown labels must be 1-64 byte strings".to_owned())
                })
                .collect()
        };
        match object.get("breakdown") {
            None | Some(Value::Null) => {}
            Some(Value::Array(_)) => {
                let all = labels(&object["breakdown"])?;
                for (breakdown, supported) in info.breakdown.iter_mut().zip(info.rulesets) {
                    if supported {
                        breakdown.clone_from(&all);
                    }
                }
            }
            Some(Value::Object(map)) => {
                for (ruleset, value) in map {
                    let index =
                        ruleset_index(&Value::String(ruleset.clone())).ok_or_else(|| {
                            format!("vosu_pp_info.breakdown: unknown ruleset {ruleset:?}")
                        })?;
                    info.breakdown[index] = labels(value)?;
                }
            }
            Some(_) => return Err("vosu_pp_info.breakdown must be an array or object".into()),
        }
        Ok(info)
    }
}

fn ruleset_index(value: &Value) -> Option<usize> {
    match value.as_str()? {
        "osu" => Some(0),
        "taiko" => Some(1),
        "fruits" | "catch" => Some(2),
        "mania" => Some(3),
        _ => None,
    }
}

/// One instantiated module. A trap discards it; the next call starts fresh.
struct Live {
    store: Store<StoreLimits>,
    memory: Memory,
    input: usize,
    output: usize,
    calculate: TypedFunc<(), i32>,
    error: Option<TypedFunc<(), i32>>,
    info: Option<TypedFunc<(), i32>>,
    memory_bytes: usize,
}

enum Failure {
    /// The module reported a status code; its instance stays usable.
    Status(i32, String),
    /// The instance trapped or misbehaved and is discarded.
    Trap(String),
}

fn trap(error: wasmi::Error, fuel: u64) -> String {
    if error.as_trap_code() == Some(TrapCode::OutOfFuel) {
        format!("exceeded its fuel budget of {fuel} instructions (setting calculators.fuel)")
    } else {
        format!("trapped: {error}")
    }
}

impl Live {
    fn new(module: &Module, limits: Limits) -> Result<Self, String> {
        let mut store = Store::new(
            module.engine(),
            StoreLimitsBuilder::new()
                .memory_size(limits.memory_bytes)
                .memories(1)
                .tables(4)
                .table_elements(65_536)
                .instances(1)
                .build(),
        );
        store.limiter(|limits| limits);
        store.set_fuel(limits.fuel).map_err(|e| e.to_string())?;
        let instance = Linker::<StoreLimits>::new(module.engine())
            .instantiate_and_start(&mut store, module)
            .map_err(|e| format!("instantiation failed: {}", trap(e, limits.fuel)))?;
        let memory = instance
            .get_memory(&store, "memory")
            .ok_or("missing exported memory")?;
        let function = |name: &str| {
            instance
                .get_typed_func::<(), i32>(&store, name)
                .map_err(|e| format!("{name}: {e}"))
        };
        let abi_version = function(REQUIRED[0])?;
        let input = function(REQUIRED[1])?;
        let output = function(REQUIRED[2])?;
        let calculate = function(REQUIRED[3])?;
        let optional = |name: &str| instance.get_typed_func::<(), i32>(&store, name).ok();
        let info = optional(OPTIONAL[0]);
        let error = optional(OPTIONAL[1]);
        let version = abi_version
            .call(&mut store, ())
            .map_err(|e| trap(e, limits.fuel))?;
        if version != abi::ABI_VERSION {
            return Err(format!(
                "module implements ABI version {version}; this server-pp supports {}",
                abi::ABI_VERSION
            ));
        }
        let mut pointer = |function: TypedFunc<(), i32>, bytes: usize, name: &str| {
            let offset = function
                .call(&mut store, ())
                .map_err(|e| trap(e, limits.fuel))? as u32 as usize;
            if offset
                .checked_add(bytes)
                .is_none_or(|end| end > memory.data_size(&store))
            {
                return Err(format!("{name} points outside linear memory"));
            }
            Ok(offset)
        };
        let input = pointer(input, abi::INPUT_SLOTS * 8, REQUIRED[1])?;
        let output = pointer(output, abi::OUTPUT_SLOTS * 8, REQUIRED[2])?;
        Ok(Self {
            store,
            memory,
            input,
            output,
            calculate,
            error,
            info,
            memory_bytes: limits.memory_bytes,
        })
    }

    /// Reads a NUL-terminated UTF-8 string of at most `max` bytes.
    fn string(&self, offset: usize, max: usize) -> Result<String, String> {
        let data = self
            .memory
            .data(&self.store)
            .get(offset..)
            .ok_or("string pointer outside linear memory")?;
        let length = data
            .iter()
            .take(max + 1)
            .position(|&b| b == 0)
            .ok_or_else(|| format!("string is not NUL-terminated within {max} bytes"))?;
        String::from_utf8(data[..length].to_vec()).map_err(|_| "string is not UTF-8".to_owned())
    }

    fn info(&mut self, fuel: u64) -> Result<Option<String>, String> {
        let Some(function) = self.info else {
            return Ok(None);
        };
        self.store.set_fuel(fuel).map_err(|e| e.to_string())?;
        let offset = function
            .call(&mut self.store, ())
            .map_err(|e| trap(e, fuel))?;
        self.string(offset as u32 as usize, abi::INFO_MAX_BYTES)
            .map(Some)
            .map_err(|e| format!("vosu_pp_info: {e}"))
    }

    fn call(&mut self, slots: &[f64; abi::INPUT_SLOTS], fuel: u64) -> Result<Outcome, Failure> {
        let mut bytes = [0u8; abi::INPUT_SLOTS * 8];
        for (chunk, value) in bytes.chunks_exact_mut(8).zip(slots) {
            chunk.copy_from_slice(&value.to_le_bytes());
        }
        self.store
            .set_fuel(fuel)
            .map_err(|e| Failure::Trap(e.to_string()))?;
        self.memory
            .write(&mut self.store, self.input, &bytes)
            .map_err(|e| Failure::Trap(e.to_string()))?;
        let status = self
            .calculate
            .call(&mut self.store, ())
            .map_err(|e| Failure::Trap(trap(e, fuel)))?;
        let used = fuel - self.store.get_fuel().unwrap_or(0);
        if status != abi::status::OK {
            let message = match self.error {
                Some(error) => error
                    .call(&mut self.store, ())
                    .map_err(|e| Failure::Trap(trap(e, fuel)))
                    .and_then(|offset| {
                        self.string(offset as u32 as usize, abi::ERROR_MAX_BYTES)
                            .map_err(|e| Failure::Trap(format!("vosu_pp_error: {e}")))
                    })?,
                None => String::new(),
            };
            return Err(Failure::Status(status, message));
        }
        let mut out = [0u8; abi::OUTPUT_SLOTS * 8];
        self.memory
            .read(&self.store, self.output, &mut out)
            .map_err(|e| Failure::Trap(e.to_string()))?;
        let mut values = [0.0; abi::OUTPUT_SLOTS];
        for (value, chunk) in values.iter_mut().zip(out.chunks_exact(8)) {
            *value = f64::from_le_bytes(chunk.try_into().expect("8-byte chunk"));
        }
        Ok(Outcome { values, fuel: used })
    }
}

pub(crate) struct Outcome {
    pub(crate) values: [f64; abi::OUTPUT_SLOTS],
    pub(crate) fuel: u64,
}

/// A compiled, validated module plus its (lazily re-created) instance.
pub struct Calculator {
    module: Module,
    pub info: Info,
    pub md5: String,
    pub size: u64,
    live: Mutex<Option<Live>>,
}

fn check_exports(module: &Module) -> Result<(), String> {
    if let Some(import) = module.imports().next() {
        return Err(format!(
            "modules must not import anything (found {}::{})",
            import.module(),
            import.name()
        ));
    }
    let mut found = [false; REQUIRED.len()];
    let mut memory = false;
    for export in module.exports() {
        let name = export.name();
        match export.ty() {
            ExternType::Memory(_) if name == "memory" => memory = true,
            ExternType::Func(function) if REQUIRED.contains(&name) || OPTIONAL.contains(&name) => {
                if !function.params().is_empty() || function.results() != [ValType::I32] {
                    return Err(format!("export {name} must have type () -> i32"));
                }
                if let Some(index) = REQUIRED.iter().position(|r| *r == name) {
                    found[index] = true;
                }
            }
            _ => {}
        }
    }
    if !memory {
        return Err("module must export its linear memory as \"memory\"".into());
    }
    match REQUIRED.iter().zip(found).find(|(_, found)| !found) {
        Some((name, _)) => Err(format!("missing export {name}")),
        None => Ok(()),
    }
}

fn status_message(code: i32, message: &str) -> String {
    let kind = match code {
        abi::status::UNSUPPORTED_RULESET => "unsupported ruleset",
        abi::status::UNSUPPORTED_MODS => "unsupported mods",
        abi::status::INVALID_INPUT => "invalid input",
        _ => "calculation failed",
    };
    if message.is_empty() {
        format!("{kind} (status {code})")
    } else {
        format!("{kind} (status {code}): {message}")
    }
}

impl Calculator {
    pub fn load(engine: &Engine, bytes: &[u8], limits: Limits) -> Result<Self, String> {
        let module =
            Module::new(engine, bytes).map_err(|e| format!("invalid WebAssembly module: {e}"))?;
        check_exports(&module)?;
        let mut live = Live::new(&module, limits)?;
        let info = Info::parse(live.info(limits.fuel)?.as_deref())?;
        Ok(Self {
            module,
            info,
            md5: format!("{:x}", md5::compute(bytes)),
            size: bytes.len() as u64,
            live: Mutex::new(Some(live)),
        })
    }

    pub(crate) fn run(
        &self,
        slots: &[f64; abi::INPUT_SLOTS],
        limits: Limits,
    ) -> Result<Outcome, String> {
        let mut live = self.live.lock().map_err(|_| "calculator unavailable")?;
        if live
            .as_ref()
            .is_none_or(|l| l.memory_bytes != limits.memory_bytes)
        {
            *live = Some(Live::new(&self.module, limits)?);
        }
        match live
            .as_mut()
            .expect("instantiated above")
            .call(slots, limits.fuel)
        {
            Ok(outcome) => Ok(outcome),
            Err(Failure::Status(code, message)) => Err(status_message(code, &message)),
            Err(Failure::Trap(message)) => {
                *live = None;
                Err(message)
            }
        }
    }
}

pub fn engine() -> Engine {
    let mut config = Config::default();
    config.consume_fuel(true);
    Engine::new(&config)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

struct Entry {
    id: String,
    path: PathBuf,
    enabled: bool,
    loaded: Result<Arc<Calculator>, String>,
}

struct Cached {
    stamp: Stamp,
    limits: Limits,
    loaded: Result<Arc<Calculator>, String>,
}

struct State {
    settings: Settings,
    settings_error: Option<String>,
    folder_error: Option<String>,
    entries: Vec<Entry>,
    files: HashMap<PathBuf, Cached>,
    refreshed: Option<Instant>,
}

/// The configured calculators, re-validated against settings and files at
/// most once per [`REFRESH`].
pub struct Calculators {
    engine: Engine,
    data_dir: PathBuf,
    state: Mutex<State>,
}

/// A resolved custom calculator ready to run.
pub struct Resolved {
    pub id: String,
    pub name: String,
    pub calculator: Arc<Calculator>,
    pub limits: Limits,
}

impl Calculators {
    pub fn new(data_dir: &Path) -> Self {
        let settings = Settings::defaults(data_dir);
        // The default folder is where users are told to drop modules.
        let _ = std::fs::create_dir_all(&settings.folder);
        Self {
            engine: engine(),
            data_dir: data_dir.to_owned(),
            state: Mutex::new(State {
                settings,
                settings_error: None,
                folder_error: None,
                entries: Vec::new(),
                files: HashMap::new(),
                refreshed: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn stale(&self) -> bool {
        self.lock().refreshed.is_none_or(|t| t.elapsed() >= REFRESH)
    }

    /// Applies the effective settings (or keeps the previous ones when they
    /// could not be read) and reloads added or changed module files.
    pub fn refresh(&self, values: Result<Value, String>) {
        let mut state = self.lock();
        match values.and_then(|v| Settings::from_values(&v, &self.data_dir)) {
            Ok(settings) => {
                state.settings = settings;
                state.settings_error = None;
            }
            Err(error) => state.settings_error = Some(error),
        }
        let settings = state.settings.clone();
        let mut candidates: Vec<(String, PathBuf)> = Vec::new();
        state.folder_error = None;
        match std::fs::read_dir(&settings.folder) {
            Ok(dir) => {
                let mut paths: Vec<PathBuf> = dir
                    .filter_map(|entry| entry.ok().map(|e| e.path()))
                    .filter(|path| {
                        path.extension()
                            .is_some_and(|e| e.eq_ignore_ascii_case("wasm"))
                            && path.is_file()
                    })
                    .collect();
                paths.sort();
                candidates.extend(paths.into_iter().map(|p| (id_from_stem(&p), p)));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                state.folder_error = Some(format!("{}: {error}", settings.folder.display()))
            }
        }
        for (id, path) in &settings.files {
            candidates.push((
                id.clone().unwrap_or_else(|| id_from_stem(path)),
                path.clone(),
            ));
        }
        let mut seen: HashMap<String, PathBuf> = HashMap::new();
        let mut entries = Vec::with_capacity(candidates.len());
        for (id, path) in candidates {
            let loaded = if !valid_id(&id) {
                Err(format!(
                    "invalid id {id:?}: use lowercase letters, digits, '-', '_' or '.' (at most 64)"
                ))
            } else if RESERVED.contains(&id.as_str()) {
                Err(format!("id {id:?} is reserved for a built-in profile"))
            } else if let Some(other) = seen.get(&id) {
                Err(format!(
                    "duplicate id {id:?}, also used by {}",
                    other.display()
                ))
            } else {
                seen.insert(id.clone(), path.clone());
                self.load_file(&mut state.files, &path, settings.limits)
            };
            let enabled = settings
                .enabled
                .as_ref()
                .is_none_or(|ids| ids.contains(&id));
            entries.push(Entry {
                id,
                path,
                enabled,
                loaded,
            });
        }
        state
            .files
            .retain(|path, _| entries.iter().any(|e| &e.path == path));
        state.entries = entries;
        state.refreshed = Some(Instant::now());
    }

    fn load_file(
        &self,
        files: &mut HashMap<PathBuf, Cached>,
        path: &Path,
        limits: Limits,
    ) -> Result<Arc<Calculator>, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if !meta.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }
        if meta.len() > MAX_MODULE_BYTES {
            return Err("module is larger than 16 MiB".into());
        }
        let stamp = Stamp {
            len: meta.len(),
            modified: meta.modified().ok(),
        };
        // Load failures may depend on the limits (initial memory, start
        // function fuel), so they are retried when the limits change.
        if let Some(cached) = files.get(path)
            && cached.stamp == stamp
            && (cached.loaded.is_ok() || cached.limits == limits)
        {
            return cached.loaded.clone();
        }
        let loaded = std::fs::read(path)
            .map_err(|e| format!("{}: {e}", path.display()))
            .and_then(|bytes| Calculator::load(&self.engine, &bytes, limits))
            .map(Arc::new);
        files.insert(
            path.to_owned(),
            Cached {
                stamp,
                limits,
                loaded: loaded.clone(),
            },
        );
        loaded
    }

    pub fn resolve(&self, id: &str) -> Result<Resolved, String> {
        let state = self.lock();
        let entry = state
            .entries
            .iter()
            .find(|e| e.id == id && !e.loaded.as_ref().is_err_and(|e| e.starts_with("duplicate")))
            .ok_or_else(|| {
                "unsupported server; GET /v1/servers lists built-in profiles and custom calculators"
                    .to_owned()
            })?;
        if !entry.enabled {
            return Err(format!(
                "custom calculator {id:?} is disabled (setting calculators.enabled)"
            ));
        }
        let calculator = entry
            .loaded
            .clone()
            .map_err(|e| format!("custom calculator {id:?} failed to load: {e}"))?;
        Ok(Resolved {
            id: entry.id.clone(),
            name: display_name(&state.settings, &entry.id, &calculator.info),
            calculator,
            limits: state.settings.limits,
        })
    }

    /// `/v1/servers` entries for every discovered module, and the overall
    /// configuration.
    pub fn describe(&self) -> (Vec<Value>, Value) {
        let state = self.lock();
        let servers = state
            .entries
            .iter()
            .map(|entry| {
                let mut value = json!({
                    "id": entry.id,
                    "kind": "custom",
                    "path": entry.path,
                    "enabled": entry.enabled,
                    "abi": abi::ABI_VERSION,
                    "attributes": ATTRIBUTES,
                    "deployment_verified": false,
                });
                match &entry.loaded {
                    Ok(calculator) => {
                        let info = &calculator.info;
                        value["status"] = json!(if entry.enabled { "ready" } else { "disabled" });
                        value["name"] = json!(display_name(&state.settings, &entry.id, info));
                        value["version"] = json!(info.version);
                        value["author"] = json!(info.author);
                        value["description"] = json!(info.description);
                        value["rulesets"] = json!(
                            RULESETS
                                .iter()
                                .zip(info.rulesets)
                                .filter(|(_, on)| *on)
                                .map(|(name, _)| *name)
                                .collect::<Vec<_>>()
                        );
                        value["breakdown"] = json!(
                            RULESETS
                                .iter()
                                .zip(&info.breakdown)
                                .filter(|(_, labels)| !labels.is_empty())
                                .map(|(name, labels)| (name.to_string(), labels.clone()))
                                .collect::<BTreeMap<_, _>>()
                        );
                        value["md5"] = json!(calculator.md5);
                        value["size"] = json!(calculator.size);
                    }
                    Err(error) => {
                        value["status"] = json!("error");
                        value["name"] =
                            json!(state.settings.names.get(&entry.id).unwrap_or(&entry.id));
                        value["error"] = json!(error);
                    }
                }
                value
            })
            .collect();
        let config = json!({
            "folder": state.settings.folder,
            "abi": abi::ABI_VERSION,
            "attributes": ATTRIBUTES,
            "fuel": state.settings.limits.fuel,
            "memory_bytes": state.settings.limits.memory_bytes,
            "settings_error": state.settings_error,
            "folder_error": state.folder_error,
        });
        (servers, config)
    }
}

fn display_name(settings: &Settings, id: &str, info: &Info) -> String {
    settings
        .names
        .get(id)
        .or(info.name.as_ref())
        .cloned()
        .unwrap_or_else(|| id.to_owned())
}

/// One module result.
pub struct Evaluation {
    pub pp: f64,
    pub stars: f64,
    pub breakdown: Vec<(String, f64)>,
    pub fuel: u64,
    /// rosu-pp 4.0.1's own stable pp for the same attributes and score state:
    /// the formula most server forks start from.
    pub base_pp: f64,
}

fn game_mode(mode: u8) -> GameMode {
    match mode {
        0 => GameMode::Osu,
        1 => GameMode::Taiko,
        2 => GameMode::Catch,
        _ => GameMode::Mania,
    }
}

/// Everything about a map at a ruleset, mods and passed-object count that
/// does not depend on the score: the expensive rosu-pp difficulty
/// calculation plus map values.
pub struct Prepared {
    settings: Difficulty,
    difficulty: DifficultyAttributes,
    clock_rate: f64,
    ar: f64,
    od: f64,
    cs: f64,
    hp: f64,
    total: u32,
    is_convert: bool,
}

/// Full-map preparations per (ruleset, mods), kept with the parsed map so
/// if-FC projections and repeated queries skip the difficulty calculation.
pub type PreparedCache = Mutex<HashMap<(u8, u32), Arc<Prepared>>>;
const PREPARED_PER_MAP: usize = 64;

fn prepare(map: &Map, mode: u8, bits: u32, passed: Option<u32>) -> Result<Arc<Prepared>, String> {
    let key = (mode, bits);
    if passed.is_none()
        && let Some(prepared) = map.prepared.lock().ok().and_then(|c| c.get(&key).cloned())
    {
        return Ok(prepared);
    }
    let beatmap = map
        .official()?
        .convert_ref(game_mode(mode), &bits.into())
        .map_err(|e| format!("cannot play this map as {}: {e}", RULESETS[mode as usize]))?;
    let mut builder = beatmap.attributes();
    builder.mods(bits);
    let attributes = builder.build();
    let adjusted = attributes.apply_clock_rate();
    // rosu-pp's generic `Performance::lazer` skips taiko (and catch), which
    // would score taiko as lazer (non-classic HD). The difficulty setting
    // reaches every ruleset, so all scores here use stable semantics.
    let mut settings = Difficulty::new().lazer(false).mods(bits);
    if let Some(v) = passed {
        settings = settings.passed_objects(v)
    }
    let prepared = Arc::new(Prepared {
        difficulty: settings.calculate(beatmap.as_ref()),
        settings,
        clock_rate: attributes.clock_rate(),
        ar: adjusted.ar,
        od: adjusted.od,
        cs: f64::from(adjusted.cs),
        hp: f64::from(adjusted.hp),
        total: beatmap.hit_objects.len() as u32,
        is_convert: beatmap.is_convert,
    });
    if passed.is_none()
        && let Ok(mut cache) = map.prepared.lock()
    {
        if cache.len() >= PREPARED_PER_MAP {
            cache.clear();
        }
        cache.insert(key, prepared.clone());
    }
    Ok(prepared)
}

/// Runs `resolved` on `input` against `map` played as ruleset `mode`.
pub fn evaluate(
    resolved: &Resolved,
    map: &Map,
    input: &Input,
    bits: u32,
    mode: u8,
    projection: bool,
) -> Result<Evaluation, String> {
    let info = &resolved.calculator.info;
    if !info.rulesets[mode as usize] {
        return Err(format!(
            "{} does not support {}",
            resolved.name, RULESETS[mode as usize]
        ));
    }
    let prepared = prepare(map, mode, bits, input.passed_objects)?;
    let difficulty = &prepared.difficulty;
    let mut performance = Performance::new(difficulty.clone())
        .difficulty(prepared.settings.clone())
        .misses(input.misses);
    if let Some(v) = input.combo {
        performance = performance.combo(v)
    }
    if let Some(v) = input.acc {
        performance = performance.accuracy(v)
    } else {
        if let Some(v) = input.n300 {
            performance = performance.n300(v)
        }
        if let Some(v) = input.n100 {
            performance = performance.n100(v)
        }
        if let Some(v) = input.n50 {
            performance = performance.n50(v)
        }
        if let Some(v) = input.n_geki {
            performance = performance.n_geki(v)
        }
        if let Some(v) = input.n_katu {
            performance = performance.n_katu(v)
        }
    }
    // Generating a state stores it back into the builder, and regenerating
    // from stored judgements can differ (observed for catch droplets). So the
    // module gets the state of an untouched copy, the one rosu-pp's own
    // `calculate` derives.
    let state = performance.clone().generate_state();
    let reference = performance.calculate();

    use abi::input as at;
    let mut s = [0.0; abi::INPUT_SLOTS];
    let flag = |on: bool| if on { 1.0 } else { 0.0 };
    s[at::ABI] = f64::from(abi::ABI_VERSION);
    s[at::RULESET] = f64::from(mode);
    s[at::MODS] = f64::from(bits);
    s[at::CLOCK_RATE] = prepared.clock_rate;
    s[at::RELAX] = flag(bits & 128 != 0);
    s[at::AUTOPILOT] = flag(bits & 8192 != 0);
    s[at::SCORE_V2] = flag(bits & (1 << 29) != 0);
    s[at::PROJECTION] = flag(projection);

    let [geki, katu, n300, n100, n50, misses] = [
        state.n_geki,
        state.n_katu,
        state.n300,
        state.n100,
        state.n50,
        state.misses,
    ]
    .map(f64::from);
    let (numerator, denominator) = match mode {
        0 => (
            6.0 * n300 + 2.0 * n100 + n50,
            6.0 * (n300 + n100 + n50 + misses),
        ),
        1 => (2.0 * n300 + n100, 2.0 * (n300 + n100 + misses)),
        2 => (n300 + n100 + n50, n300 + n100 + n50 + katu + misses),
        _ => (
            300.0 * (geki + n300) + 200.0 * katu + 100.0 * n100 + 50.0 * n50,
            300.0 * (geki + n300 + katu + n100 + n50 + misses),
        ),
    };
    s[at::ACCURACY] = if denominator > 0.0 {
        numerator / denominator
    } else {
        0.0
    };
    // rosu-pp's mania state carries no combo; pass the requested one instead.
    s[at::COMBO] = f64::from(if mode == 3 {
        input
            .combo
            .unwrap_or(difficulty.max_combo())
            .min(difficulty.max_combo())
    } else {
        state.max_combo
    });
    s[at::N300] = n300;
    s[at::N100] = n100;
    s[at::N50] = n50;
    s[at::N_GEKI] = geki;
    s[at::N_KATU] = katu;
    s[at::MISSES] = misses;
    let total = prepared.total;
    s[at::PASSED_OBJECTS] = f64::from(input.passed_objects.unwrap_or(total).min(total));
    s[at::TOTAL_OBJECTS] = f64::from(total);
    s[at::SLIDER_END_HITS] = f64::from(state.slider_end_hits);
    s[at::LARGE_TICK_HITS] = f64::from(state.osu_large_tick_hits);
    s[at::SMALL_TICK_HITS] = f64::from(state.osu_small_tick_hits);

    s[at::STARS] = difficulty.stars();
    s[at::MAX_COMBO] = f64::from(difficulty.max_combo());
    s[at::IS_CONVERT] = flag(prepared.is_convert);
    s[at::AR] = prepared.ar;
    s[at::OD] = prepared.od;
    s[at::CS] = prepared.cs;
    s[at::HP] = prepared.hp;

    s[at::LIVE] = flag(input.live);
    s[at::BEATMAP_ID] = map.beatmap_id.map_or(f64::NAN, f64::from);
    s[at::BEATMAPSET_ID] = map.beatmapset_id.map_or(f64::NAN, f64::from);

    match difficulty {
        DifficultyAttributes::Osu(a) => {
            use abi::osu as o;
            s[o::AIM] = a.aim;
            s[o::AIM_DIFFICULT_SLIDER_COUNT] = a.aim_difficult_slider_count;
            s[o::SPEED] = a.speed;
            s[o::FLASHLIGHT] = a.flashlight;
            s[o::SLIDER_FACTOR] = a.slider_factor;
            s[o::AIM_TOP_WEIGHTED_SLIDER_FACTOR] = a.aim_top_weighted_slider_factor;
            s[o::SPEED_TOP_WEIGHTED_SLIDER_FACTOR] = a.speed_top_weighted_slider_factor;
            s[o::SPEED_NOTE_COUNT] = a.speed_note_count;
            s[o::AIM_DIFFICULT_STRAIN_COUNT] = a.aim_difficult_strain_count;
            s[o::SPEED_DIFFICULT_STRAIN_COUNT] = a.speed_difficult_strain_count;
            s[o::NESTED_SCORE_PER_OBJECT] = a.nested_score_per_object;
            s[o::LEGACY_SCORE_BASE_MULTIPLIER] = a.legacy_score_base_multiplier;
            s[o::MAXIMUM_LEGACY_COMBO_SCORE] = a.maximum_legacy_combo_score;
            s[o::AR] = a.ar;
            s[o::GREAT_HIT_WINDOW] = a.great_hit_window;
            s[o::OK_HIT_WINDOW] = a.ok_hit_window;
            s[o::MEH_HIT_WINDOW] = a.meh_hit_window;
            s[o::HP] = a.hp;
            s[o::N_CIRCLES] = f64::from(a.n_circles);
            s[o::N_SLIDERS] = f64::from(a.n_sliders);
            s[o::N_LARGE_TICKS] = f64::from(a.n_large_ticks);
            s[o::N_SPINNERS] = f64::from(a.n_spinners);
        }
        DifficultyAttributes::Taiko(a) => {
            use abi::taiko as t;
            s[t::STAMINA] = a.stamina;
            s[t::RHYTHM] = a.rhythm;
            s[t::COLOR] = a.color;
            s[t::READING] = a.reading;
            s[t::GREAT_HIT_WINDOW] = a.great_hit_window;
            s[t::OK_HIT_WINDOW] = a.ok_hit_window;
            s[t::MONO_STAMINA_FACTOR] = a.mono_stamina_factor;
            s[t::MECHANICAL_DIFFICULTY] = a.mechanical_difficulty;
            s[t::CONSISTENCY_FACTOR] = a.consistency_factor;
        }
        DifficultyAttributes::Catch(a) => {
            use abi::catch as c;
            s[c::PREEMPT] = a.preempt;
            s[c::N_FRUITS] = f64::from(a.n_fruits);
            s[c::N_DROPLETS] = f64::from(a.n_droplets);
            s[c::N_TINY_DROPLETS] = f64::from(a.n_tiny_droplets);
        }
        DifficultyAttributes::Mania(a) => {
            use abi::mania as m;
            s[m::N_OBJECTS] = f64::from(a.n_objects);
            s[m::N_HOLD_NOTES] = f64::from(a.n_hold_notes);
        }
    }

    let outcome = resolved.calculator.run(&s, resolved.limits)?;
    let pp = outcome.values[0];
    if !pp.is_finite() || pp < 0.0 {
        return Err(format!(
            "{} returned an invalid pp value ({pp})",
            resolved.name
        ));
    }
    let breakdown = info.breakdown[mode as usize]
        .iter()
        .zip(&outcome.values[1..])
        .map(|(label, value)| (label.clone(), *value))
        .collect();
    Ok(Evaluation {
        pp,
        stars: difficulty.stars(),
        breakdown,
        fuel: outcome.fuel,
        base_pp: reference.pp(),
    })
}

/// A JSON object of breakdown values (NaN becomes null).
pub fn breakdown_json(breakdown: &[(String, f64)]) -> Value {
    Value::Object(
        breakdown
            .iter()
            .map(|(label, value)| (label.clone(), json!(value.is_finite().then_some(*value))))
            .collect(),
    )
}

/// Ruleset number from a query value (`osu`, `taiko`, `fruits`/`catch`,
/// `mania`, or 0-3).
pub fn parse_mode(text: &str) -> Result<u8, String> {
    match text.trim().to_ascii_lowercase().as_str() {
        "0" | "osu" | "std" => Ok(0),
        "1" | "taiko" => Ok(1),
        "2" | "fruits" | "catch" => Ok(2),
        "3" | "mania" => Ok(3),
        other => Err(format!("unknown ruleset {other:?}")),
    }
}
