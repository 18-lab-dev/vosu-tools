//! MinaCalc 527, pinned to Etterna 2d706147cc4bcf95a8ceb24dc4f4129be207f803.
//! Note heads only; interval data is native base-adjusted difficulty, not local MSD.
#![forbid(unsafe_op_in_unsafe_fn)]
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
fn validate(rows: &[Row], keys: u32, rate: f32) -> Result<(), String> {
    if !matches!(keys, 4 | 6 | 7)
        || !rate.is_finite()
        || !(0.5..=2.0).contains(&rate)
        || rows.iter().any(|r| {
            r.notes == 0
                || r.notes >= (1 << keys)
                || !r.seconds.is_finite()
                || !(0.0..=24000.0).contains(&r.seconds)
        })
        || rows.windows(2).any(|w| w[0].seconds >= w[1].seconds)
    {
        return Err("invalid MinaCalc rows, rate or key count".into());
    }
    Ok(())
}
pub fn calculate(
    rows: &[Row],
    keys: u32,
    rate: f32,
    score: Option<f32>,
) -> Result<[f32; 8], String> {
    validate(rows, keys, rate)?;
    if score.is_some_and(|s| !s.is_finite() || !(0.0..=1.0).contains(&s)) {
        return Err("invalid score".into());
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
    if status == 0 {
        Ok(out)
    } else {
        Err(format!("MinaCalc failed ({status})"))
    }
}
pub fn intervals(rows: &[Row], keys: u32, rate: f32) -> Result<Vec<[f32; 8]>, String> {
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
        return Err(format!("MinaCalc intervals failed ({status})"));
    }
    out.truncate(written);
    Ok(out)
}
