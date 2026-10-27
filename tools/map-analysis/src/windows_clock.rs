//! POSIX `clock_gettime` for Windows builds.
//!
//! The vendored Prism `jsmath` crate (unmodified upstream) declares
//! `clock_gettime` for `jsmath::js::thread_cpu_seconds`, a CPU-time helper that
//! nothing in Prism calls. The MSVC C runtime has no such function, so Windows
//! builds that keep that code (debug and test binaries) failed to link
//! (LNK2019). This supplies the one clock jsmath asks for, the calling thread's
//! CPU time, from `GetThreadTimes`; it never touches a rating.

use std::ffi::c_void;

/// `struct timespec` as jsmath declares it.
#[repr(C)]
pub struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

impl FileTime {
    /// 100-nanosecond intervals.
    fn ticks(&self) -> u64 {
        (u64::from(self.high) << 32) | u64::from(self.low)
    }
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentThread() -> *mut c_void;
    fn GetThreadTimes(
        thread: *mut c_void,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
}

/// Linux's `CLOCK_THREAD_CPUTIME_ID`, the only clock jsmath requests.
const CLOCK_THREAD_CPUTIME_ID: i32 = 3;

/// Thread CPU time (kernel + user) for `CLOCK_THREAD_CPUTIME_ID`; -1 for any
/// other clock or on failure, as POSIX does.
///
/// # Safety
///
/// `ts` must be null or valid for a write of one [`Timespec`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn clock_gettime(clock: i32, ts: *mut Timespec) -> i32 {
    if clock != CLOCK_THREAD_CPUTIME_ID || ts.is_null() {
        return -1;
    }
    let [mut creation, mut exit, mut kernel, mut user] = <[FileTime; 4]>::default();
    // SAFETY: GetCurrentThread returns a pseudo-handle for the calling thread;
    // the four out-pointers are live locals.
    let ok = unsafe {
        GetThreadTimes(
            GetCurrentThread(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return -1;
    }
    let ticks = kernel.ticks() + user.ticks();
    // SAFETY: the caller guarantees `ts` is valid for writes.
    unsafe {
        ts.write(Timespec {
            tv_sec: (ticks / 10_000_000) as i64,
            tv_nsec: (ticks % 10_000_000 * 100) as i64,
        });
    }
    0
}
