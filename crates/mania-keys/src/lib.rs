//! The osu!mania key count, as osu! (lazer) `2026.1005.0-lazer`
//! (`9a10d935b05a3b896f4bd811d620f2023331db93`) plays a native mania map.
//!
//! The same rule is `maniaKeyCount` in `@vosu-tools/osu-parse`; both are tested
//! against `key-counts.json`, so the Rust tools and the web UIs cannot drift.
//! Converted osu! maps get their count from the conversion
//! (`@vosu-tools/ruleset-convert`), not from this rule.

/// `LegacyBeatmapDecoder.MAX_MANIA_KEY_COUNT`.
pub const MAX_MANIA_KEYS: u32 = 18;
/// `ManiaRuleset.MAX_STAGE_KEYS`.
pub const MAX_STAGE_KEYS: u32 = 10;
/// osu!'s `CircleSize` when a map has none
/// (`IBeatmapDifficultyInfo.DEFAULT_DIFFICULTY`).
pub const DEFAULT_CIRCLE_SIZE: f32 = 5.0;

/// Columns lazer plays a native mania map with: `CircleSize` (a float) clamped
/// to 1–18 by `LegacyBeatmapDecoder.applyDifficultyRestrictions`,
/// `Math.Max(1, Math.Round(CircleSize))` in
/// `ManiaBeatmapConverter.getColumnCount` (half to even: 6.5 → 6, 7.5 → 8), and
/// above 10 keys two stages of half each (`TargetColumns /= 2`, `Dual`), so 11,
/// 13, 15 and 17 lose a column. A non-finite `CircleSize` is refused.
pub fn key_count(circle_size: f32) -> Result<u32, String> {
    if !circle_size.is_finite() {
        return Err(format!("invalid CircleSize {circle_size}"));
    }
    let size = circle_size.clamp(1.0, MAX_MANIA_KEYS as f32);
    let target = (f64::from(size).round_ties_even() as u32).max(1);
    Ok(if target > MAX_STAGE_KEYS {
        target / 2 * 2
    } else {
        target
    })
}

/// [`key_count`] of a `CircleSize` value as written in a `.osu` file; `None`
/// (no `CircleSize` line) is osu!'s default 5.
pub fn key_count_of(circle_size: Option<&str>) -> Result<u32, String> {
    match circle_size {
        None => key_count(DEFAULT_CIRCLE_SIZE),
        Some(text) => key_count(
            text.trim()
                .parse()
                .map_err(|_| format!("invalid CircleSize {text:?}"))?,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table `@vosu-tools/osu-parse` is tested against too.
    #[test]
    fn matches_the_shared_table() {
        let table: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../key-counts.json")).unwrap();
        assert!(table.len() > 30);
        for case in table {
            let size = &case["circleSize"];
            let keys = if size.is_null() {
                key_count_of(None)
            } else if let Some(text) = size.as_str() {
                key_count_of(Some(text))
            } else {
                key_count(size.as_f64().unwrap() as f32)
            };
            assert_eq!(
                keys.ok(),
                case["keys"].as_u64().map(|k| k as u32),
                "CircleSize {size}"
            );
        }
    }
}
