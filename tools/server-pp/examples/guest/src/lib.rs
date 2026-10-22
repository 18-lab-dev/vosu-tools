//! Rust helper for server-pp custom calculator modules (ABI v1).
//!
//! A module is a `cdylib` built for `wasm32-unknown-unknown` that calls
//! [`export_calculator!`] once:
//!
//! ```ignore
//! use vosu_pp_guest::{Error, Input, Output, Ruleset};
//!
//! fn calculate(input: &Input) -> Result<Output, Error> {
//!     if input.ruleset() != Some(Ruleset::Osu) {
//!         return Err(Error::unsupported_ruleset("osu! only"));
//!     }
//!     Ok(Output::new(input.get(vosu_pp_guest::input::STARS) * 100.0))
//! }
//!
//! vosu_pp_guest::export_calculator! {
//!     info: r#"{"name":"Stars x 100","rulesets":["osu"]}"#,
//!     calculate: calculate,
//! }
//! ```
//!
//! The crate is `no_std` and has no dependencies, so it works with and without
//! `std`. The ABI itself is documented in `tools/server-pp/CALCULATORS.md`.
#![no_std]

use core::cell::UnsafeCell;

/// The shared slot layout (identical to the host's).
pub mod abi {
    include!("../../../abi/v1.rs");
}
pub use abi::{catch, input, mania, osu, ruleset, status, taiko};

/// Legacy mod bits as carried in [`input::MODS`].
pub mod mods {
    pub const NF: u32 = 1;
    pub const EZ: u32 = 1 << 1;
    pub const TD: u32 = 1 << 2;
    pub const HD: u32 = 1 << 3;
    pub const HR: u32 = 1 << 4;
    pub const SD: u32 = 1 << 5;
    pub const DT: u32 = 1 << 6;
    pub const RX: u32 = 1 << 7;
    pub const HT: u32 = 1 << 8;
    pub const NC: u32 = 1 << 9;
    pub const FL: u32 = 1 << 10;
    pub const SO: u32 = 1 << 12;
    pub const AP: u32 = 1 << 13;
    pub const PF: u32 = 1 << 14;
    pub const V2: u32 = 1 << 29;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ruleset {
    Osu,
    Taiko,
    Catch,
    Mania,
}

/// The input block the host fills before every `vosu_pp_calculate` call.
#[repr(C, align(8))]
pub struct Input([f64; abi::INPUT_SLOTS]);

impl Input {
    /// Raw slot value; see [`input`] and the ruleset modules for indices.
    pub fn get(&self, slot: usize) -> f64 {
        self.0[slot]
    }

    pub fn ruleset(&self) -> Option<Ruleset> {
        match self.0[input::RULESET] as u32 {
            0 => Some(Ruleset::Osu),
            1 => Some(Ruleset::Taiko),
            2 => Some(Ruleset::Catch),
            3 => Some(Ruleset::Mania),
            _ => None,
        }
    }

    pub fn mods(&self) -> u32 {
        self.0[input::MODS] as u32
    }

    /// Whether every bit of `bits` (see [`mods`]) is set.
    pub fn has_mods(&self, bits: u32) -> bool {
        self.mods() & bits == bits
    }

    /// A 0/1 flag slot such as [`input::RELAX`] or [`input::PROJECTION`].
    pub fn flag(&self, slot: usize) -> bool {
        self.0[slot] != 0.0
    }

    /// A count slot as an integer (NaN and negatives read as 0).
    pub fn count(&self, slot: usize) -> u32 {
        self.0[slot] as u32
    }
}

/// pp plus up to [`abi::BREAKDOWN_SLOTS`] breakdown values, in the order of the
/// module's declared breakdown labels. Unused entries stay NaN.
pub struct Output {
    pub pp: f64,
    pub breakdown: [f64; abi::BREAKDOWN_SLOTS],
}

impl Output {
    pub const fn new(pp: f64) -> Self {
        Self {
            pp,
            breakdown: [f64::NAN; abi::BREAKDOWN_SLOTS],
        }
    }

    /// Sets breakdown entry `index` (0-based, matching the declared labels).
    pub const fn with(mut self, index: usize, value: f64) -> Self {
        self.breakdown[index] = value;
        self
    }
}

/// A failed calculation: a non-zero status code and a short message.
#[derive(Clone, Copy, Debug)]
pub struct Error {
    code: i32,
    message: &'static str,
}

impl Error {
    pub const fn unsupported_ruleset(message: &'static str) -> Self {
        Self {
            code: status::UNSUPPORTED_RULESET,
            message,
        }
    }

    pub const fn unsupported_mods(message: &'static str) -> Self {
        Self {
            code: status::UNSUPPORTED_MODS,
            message,
        }
    }

    pub const fn invalid_input(message: &'static str) -> Self {
        Self {
            code: status::INVALID_INPUT,
            message,
        }
    }

    /// A module-defined failure. `code` 0 is reserved for success and is
    /// reported as [`status::INVALID_INPUT`].
    pub const fn other(code: i32, message: &'static str) -> Self {
        Self {
            code: if code == 0 {
                status::INVALID_INPUT
            } else {
                code
            },
            message,
        }
    }
}

#[doc(hidden)]
pub mod __rt {
    use super::{Error, Input, Output, UnsafeCell, abi};

    // wasm32-unknown-unknown modules are single-threaded and the host never
    // calls into an instance concurrently.
    pub struct Global<T>(UnsafeCell<T>);
    unsafe impl<T> Sync for Global<T> {}

    #[repr(C, align(8))]
    pub struct OutputBlock([f64; abi::OUTPUT_SLOTS]);

    pub static INPUT: Global<Input> = Global(UnsafeCell::new(Input([0.0; abi::INPUT_SLOTS])));
    pub static OUTPUT: Global<OutputBlock> =
        Global(UnsafeCell::new(OutputBlock([f64::NAN; abi::OUTPUT_SLOTS])));
    pub static ERROR: Global<[u8; abi::ERROR_MAX_BYTES + 1]> =
        Global(UnsafeCell::new([0; abi::ERROR_MAX_BYTES + 1]));

    pub fn input() -> *mut f64 {
        INPUT.0.get().cast()
    }

    pub fn output() -> *const f64 {
        OUTPUT.0.get().cast_const().cast()
    }

    pub fn error() -> *const u8 {
        ERROR.0.get().cast_const().cast()
    }

    pub fn run(calculate: fn(&Input) -> Result<Output, Error>) -> i32 {
        // SAFETY: single-threaded module; no other reference is live while the
        // host is inside vosu_pp_calculate.
        let (input, output, error) =
            unsafe { (&*INPUT.0.get(), &mut *OUTPUT.0.get(), &mut *ERROR.0.get()) };
        error[0] = 0;
        match calculate(input) {
            Ok(result) => {
                output.0[0] = result.pp;
                output.0[1..].copy_from_slice(&result.breakdown);
                abi::status::OK
            }
            Err(failure) => {
                let bytes = failure.message.as_bytes();
                let mut length = bytes.len().min(abi::ERROR_MAX_BYTES);
                // Never cut a UTF-8 sequence in half.
                while length > 0 && length < bytes.len() && bytes[length] & 0xC0 == 0x80 {
                    length -= 1;
                }
                error[..length].copy_from_slice(&bytes[..length]);
                error[length] = 0;
                failure.code
            }
        }
    }
}

/// Exports the ABI v1 entry points for `calculate`.
///
/// `info` is a JSON object literal (see CALCULATORS.md) with the module's name,
/// version, supported rulesets and breakdown labels.
#[macro_export]
macro_rules! export_calculator {
    (info: $info:literal, calculate: $calculate:path $(,)?) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn vosu_pp_abi_version() -> i32 {
            $crate::abi::ABI_VERSION
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn vosu_pp_input() -> *mut f64 {
            $crate::__rt::input()
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn vosu_pp_output() -> *const f64 {
            $crate::__rt::output()
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn vosu_pp_error() -> *const u8 {
            $crate::__rt::error()
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn vosu_pp_info() -> *const u8 {
            concat!($info, "\0").as_ptr()
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn vosu_pp_calculate() -> i32 {
            $crate::__rt::run($calculate)
        }
    };
}
