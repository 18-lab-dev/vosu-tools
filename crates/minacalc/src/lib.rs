//! MinaCalc 527, pinned to Etterna 2d706147cc4bcf95a8ceb24dc4f4129be207f803.
//! Note heads only; interval data is native base-adjusted difficulty, not local MSD.
#![forbid(unsafe_op_in_unsafe_fn)]
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct Row {
    pub notes: u32,
    pub seconds: f32,
}
unsafe extern "C" {
    fn vosu_minacalc(
        rows: *const Row,
        count: usize,
        keys: u32,
        rate: f32,
        goal: f32,
        ssr: bool,
        out: *mut f32,
    ) -> i32;
    fn vosu_minacalc_intervals(
        rows: *const Row,
        count: usize,
        keys: u32,
        rate: f32,
        out: *mut f32,
        capacity: usize,
        written: *mut usize,
    ) -> i32;
}

/// Key counts with a dedicated MinaCalc 527 model and parameter set that this
/// crate exposes (`TheGreatBazoinkazoinkInTheSky`, `TheSixEyedBazoinkazoink`,
/// `TheSevenFootedBazoinkazoink`). Other counts fall back to the untuned generic
/// `Bazoinkazoink` upstream and are refused here.
pub const KEYS: [u32; 3] = [4, 6, 7];

/// Whether MinaCalc 527 computes a technical base difficulty for `keys`. The 6K,
/// 7K and generic models never fill `TechBase`, so their Technical output is a
/// constant floor, not a rating.
pub fn technical_modelled(keys: u32) -> bool {
    keys == 4
}

/// MinaCalc's names for its eight outputs at `keys`, in output order. Outside
/// 4K the Jumpstream and Handstream slots hold the generic chordstream and
/// bracketing models (`GChordStream`, `GBracketing`); upstream names them
/// `Skill_Chordstream` and `Skill_Bracketing` in `GenericSkillset`
/// ("JS and HS dont really \"work\" for things like 7k").
pub fn skill_names(keys: u32) -> [&'static str; 8] {
    let (slot2, slot3) = if keys == 4 {
        ("jumpstream", "handstream")
    } else {
        ("chordstream", "bracketing")
    };
    [
        "overall",
        "stream",
        slot2,
        slot3,
        "stamina",
        "jackspeed",
        "chordjack",
        "technical",
    ]
}

/// Upper end of MinaCalc's displayed scale for a pattern skillset at `keys`.
/// `Calc::Chisel` searches player skill up to `max_rating` (100) and returns 0
/// past it; non-4K outputs are then scaled by 4/keys (Jackspeed and Technical
/// excepted), so 6K tops out at 66.67 and 7K at 57.14.
pub fn ceiling(keys: u32) -> f32 {
    100.0 * 4.0 / keys as f32
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    /// Rows, rate, score or key count failed validation before calling MinaCalc.
    Invalid(&'static str),
    /// A skillset's search passed MinaCalc's 100-point limit (it returns 0 for
    /// that skillset and NaN stamina), so the outputs are not a rating.
    OutOfRange { keys: u32 },
    /// MinaCalc returned all zeros for a non-empty chart: more than 50 rows fell
    /// into one 0.5 s interval and upstream skips such files.
    Skipped,
    /// The C++ shim reported an unexpected status.
    Native(i32),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(what) => write!(f, "invalid MinaCalc input: {what}"),
            Self::OutOfRange { keys } => write!(
                f,
                "Beyond MinaCalc 527's {keys}K range: a skillset passed its search limit of {:.1}.",
                ceiling(*keys)
            ),
            Self::Skipped => f.write_str(
                "MinaCalc skips this chart: more than 50 rows in one half-second interval.",
            ),
            Self::Native(status) => write!(f, "MinaCalc failed ({status})"),
        }
    }
}
impl std::error::Error for Error {}
impl From<Error> for String {
    fn from(e: Error) -> Self {
        e.to_string()
    }
}

fn validate(rows: &[Row], keys: u32, rate: f32) -> Result<(), Error> {
    if !KEYS.contains(&keys) {
        return Err(Error::Invalid("key count"));
    }
    if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
        return Err(Error::Invalid("rate"));
    }
    if rows.iter().any(|r| {
        r.notes == 0
            || r.notes >= (1 << keys)
            || !r.seconds.is_finite()
            || !(0.0..=24000.0).contains(&r.seconds)
    }) || rows.windows(2).any(|w| w[0].seconds >= w[1].seconds)
    {
        return Err(Error::Invalid("rows"));
    }
    Ok(())
}

/// Classify a raw 8-value output. Pattern skillsets (Stream, Jumpstream,
/// Handstream, Jackspeed, Chordjack and, where modelled, Technical) are never
/// exactly 0 unless `Chisel` hit its limit: its search starts at 0.1.
fn classify(out: [f32; 8], keys: u32, rows: usize) -> Result<[f32; 8], Error> {
    if rows > 1 && out.iter().all(|&v| v == 0.0) {
        return Err(Error::Skipped);
    }
    let mut pattern = vec![1, 2, 3, 5, 6];
    if technical_modelled(keys) {
        pattern.push(7);
    }
    if rows > 1 && pattern.iter().any(|&i| out[i] == 0.0) {
        return Err(Error::OutOfRange { keys });
    }
    if out.iter().any(|v| !v.is_finite()) {
        return Err(Error::Native(2));
    }
    Ok(out)
}

pub fn calculate(
    rows: &[Row],
    keys: u32,
    rate: f32,
    score: Option<f32>,
) -> Result<[f32; 8], Error> {
    validate(rows, keys, rate)?;
    if score.is_some_and(|s| !s.is_finite() || !(0.0..=1.0).contains(&s)) {
        return Err(Error::Invalid("score"));
    }
    let mut out = [0.0; 8];
    // repr(C) matches NoteInfo; the shim catches exceptions and writes eight floats.
    let status = unsafe {
        vosu_minacalc(
            rows.as_ptr(),
            rows.len(),
            keys,
            rate,
            score.unwrap_or(0.93),
            score.is_some(),
            out.as_mut_ptr(),
        )
    };
    match status {
        0 | 2 => classify(out, keys, rows.len()),
        other => Err(Error::Native(other)),
    }
}
pub fn intervals(rows: &[Row], keys: u32, rate: f32) -> Result<Vec<[f32; 8]>, Error> {
    validate(rows, keys, rate)?;
    let capacity = rows
        .last()
        .map_or(0, |r| (r.seconds / rate * 2.0).ceil() as usize + 4);
    let mut out = vec![[0.0; 8]; capacity];
    let mut written = 0;
    // Contiguous [f32; 8] buffer and explicit capacity; no native allocation crosses ABI.
    let status = unsafe {
        vosu_minacalc_intervals(
            rows.as_ptr(),
            rows.len(),
            keys,
            rate,
            out.as_mut_ptr().cast(),
            capacity,
            &mut written,
        )
    };
    if status != 0 {
        return Err(Error::Native(status));
    }
    out.truncate(written);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic 7K chart: alternating three-note chords at `rows_per_second`.
    fn dense(keys: u32, rows_per_second: f32, seconds: f32) -> Vec<Row> {
        let patterns = [0b0010101, 0b1010010, 0b0101001, 0b1001010];
        (0..(rows_per_second * seconds) as usize)
            .map(|i| Row {
                notes: patterns[i % patterns.len()] & ((1 << keys) - 1),
                seconds: i as f32 / rows_per_second,
            })
            .collect()
    }

    #[test]
    fn ceiling_is_reported_instead_of_nan() {
        let rows = dense(7, 24.0, 60.0);
        let low = calculate(&rows, 7, 0.5, None).expect("in range at 0.5x");
        assert!(low[0] > 0.0 && low[0] < ceiling(7));
        assert_eq!(
            calculate(&rows, 7, 2.0, None),
            Err(Error::OutOfRange { keys: 7 })
        );
    }

    #[test]
    fn technical_is_not_modelled_outside_4k() {
        let rows = dense(6, 6.0, 30.0);
        let out = calculate(&rows, 6, 1.0, None).unwrap();
        assert!(out[7] < 1.0, "6K technical is a floor value: {}", out[7]);
        assert!(!technical_modelled(6) && !technical_modelled(7) && technical_modelled(4));
        assert_eq!(skill_names(4)[2..4], ["jumpstream", "handstream"]);
        assert_eq!(skill_names(7)[2..4], ["chordstream", "bracketing"]);
    }

    #[test]
    fn unsupported_key_counts_are_refused() {
        for keys in [1, 2, 3, 5, 8, 9, 10] {
            assert_eq!(
                calculate(&dense(keys, 4.0, 10.0), keys, 1.0, None),
                Err(Error::Invalid("key count"))
            );
        }
    }
}
