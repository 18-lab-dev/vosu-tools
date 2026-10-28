# LN release acceptance audit (2026-10-28)

Read-only copies: ten newest mania scores returned by the local lazer-library GET recent endpoint, and ten newest mania `.osr` files by filesystem modification time from stable's replay directory. Originals were not modified. Private copies remain under `~/.cache/vosu-agents/LnReleaseWindows/copies/`; they are not distributable fixtures.

## Real-play measurements

A release is a physical key-up associated with a held LN, not every key-up and not a unique hold. Re-grabs can make samples exceed holds. Unpressed/missed holds have no physical release sample. `A` is accepted before → after; `E/L` are excluded early/late before → after. All samples below use no mods except Sheriruth's custom DT 1.1. No measured play used NoRelease, so the bookkeeping fix does not change these totals. Head-missed is not an exclusion rule: a missed head can still have an accepted meh tail. Other excluded samples: zero. Recorded misses include tap/head/tail misses, not just LN releases. Stable's header does not record combo-break counts.

| Client / play (score ID prefix) | OD | Holds | Samples | A before → after | E/L before → after | Recorded miss / combo_break |
|---|---:|---:|---:|---:|---:|---:|
| lazer KuruttaMinzoku (0de053f1) | 5 | 1701 | 1682 | 1649 → 1649 | 18/15 → 18/15 | 153 / 58 |
| lazer KuruttaMinzoku (1ec78b10) | 5 | 1701 | 1682 | 1648 → 1648 | 16/18 → 16/18 | 150 / 62 |
| lazer asphyxia (e8c77bc8) | 5 | 2200 | 2186 | 2078 → 2078 | 38/70 → 38/70 | 296 / 141 |
| lazer 7k Jack Maps (ae153a3e) | 8 | 0 | 0 | 0 → 0 | 0/0 → 0/0 | 183 / — |
| lazer SuddeNDeath (fa4aab42) | 8 | 35 | 34 | 34 → 34 | 0/0 → 0/0 | 60 / 1 |
| lazer Rolling Beat (dafc6c69) | 7 | 24 | 26 | 24 → 24 | 2/0 → 2/0 | 45 / 2 |
| lazer Idol (dd671ce8) | 6 | 628 | 618 | 608 → 608 | 9/1 → 9/1 | 71 / 28 |
| lazer Anti Safety Zone (6e322bb0) | 7 | 174 | 174 | 172 → 172 | 2/0 → 2/0 | 37 / 3 |
| lazer FLOWER (33686a12) | 6.5 | 24 | 25 | 24 → 24 | 1/0 → 1/0 | 10 / 1 |
| lazer Sheriruth DT1.1 (6b6b8306) | 8 | 323 | 324 | 313 → 313 | 8/3 → 8/3 | 80 / 16 |
| stable Bring Our Ignition Back (71b3c6aa) | 6 | 1096 | 1101 | 1096 → 1096 | 5/0 → 5/0 | 6 / unavailable |
| stable Kizuna no Kiseki (bf12710b) | 8 | 98 | 97 | 97 → 97 | 0/0 → 0/0 | 25 / unavailable |
| stable Ao to Natsu (b66137e5) | 9 | 4 | 4 | 4 → 4 | 0/0 → 0/0 | 0 / unavailable |
| stable Knight Rider (79a67705) | 8 | 148 | 149 | 148 → 148 | 1/0 → 1/0 | 75 / unavailable |
| stable Red Screen (c9986dd1, 611994710632) | 9 | 34 | 34 | 34 → 34 | 0/0 → 0/0 | 23 / unavailable |
| stable Red Screen (c9986dd1, 610532244641) | 9 | 34 | 34 | 34 → 34 | 0/0 → 0/0 | 26 / unavailable |
| stable Mobius (57851ec7) | 7 | 256 | 256 | 256 → 256 | 0/0 → 0/0 | 11 / unavailable |
| stable MixxioN (65fa55a7) | 8 | 0 | 0 | 0 → 0 | 0/0 → 0/0 | 36 / unavailable |
| stable FULi AUTO BUSTER (09be4f5b) | 8 | 510 | 514 | 509 → 509 | 5/0 → 5/0 | 38 / unavailable |
| stable Take This Life (c4d8d86e) | 8 | 0 | 0 | 0 → 0 | 0/0 → 0/0 | 33 / unavailable |

All ten lazer simulations reproduce the recorded miss counts exactly; some neighbouring non-miss judgement buckets differ by one. Stable total misses simulated versus recorded: Bring Our Ignition Back 2/6; FULi AUTO BUSTER 35/38; all others match. These are undercounts, not evidence of release over-exclusion. The stable judgement reconstruction is not claimed to be a perfect reproduction of closed-source stable. No widening of ordinary release windows is justified by these plays.

## Rules and causes

Pinned lazer source: [2026.1005.0-lazer, commit 9a10d935](https://github.com/ppy/osu/tree/9a10d935b05a3b896f4bd811d620f2023331db93).

- **1.5× already accounted for:** [DrawableHoldNoteTail.CheckForResult](https://github.com/ppy/osu/blob/9a10d935b05a3b896f4bd811d620f2023331db93/osu.Game.Rulesets.Mania/Objects/Drawables/DrawableHoldNoteTail.cs) divides the tail error by 1.5. `mania.ts` does so for triggered results and passive expiry. A miss-window result remains a miss; the acceptance edge is the relaxed meh window, not relaxed miss.
- **ScoreV1 is not ScoreV2:** the [official wiki hold table and ScoreV2 section](https://github.com/ppy/osu-wiki/blob/master/wiki/Gameplay/Judgement/osu!mania/en.md) distinguish the combined absolute head+tail factors (1.2/2.4, 1.1/2.2, 1/2, 1/2) from ScoreV2's separate lenient tail. `stable-mania.ts` already implements both. Do not apply 1.5× to ScoreV1's early cutoff. Continuously held very-late ScoreV1 releases are explicitly retained, based on the repository's existing measured stable behavior, not inferred from lazer.
- **Missed head/re-grab:** [DrawableHoldNote.OnPressed/OnReleased](https://github.com/ppy/osu/blob/9a10d935b05a3b896f4bd811d620f2023331db93/osu.Game.Rulesets.Mania/Objects/Drawables/DrawableHoldNote.cs) begins holding even when `Head.UpdateResult` cannot hit; [tail capping](https://github.com/ppy/osu/blob/9a10d935b05a3b896f4bd811d620f2023331db93/osu.Game.Rulesets.Mania/Objects/Drawables/DrawableHoldNoteTail.cs) caps at meh, not miss. Existing simulation preserves this. Releasing too early breaks the body; re-grabbing permits another accepted capped tail. Tests explicitly retain both physical samples.
- **NoRelease: actual over-exclusion found.** [ManiaModNoRelease.CheckForResult](https://github.com/ppy/osu/blob/9a10d935b05a3b896f4bd811d620f2023331db93/osu.Game.Rulesets.Mania/Mods/ManiaModNoRelease.cs) automatically accepts the tail when held through its end. The simulator judged it correctly but lost that outcome when the later physical key-up was sampled. Retaining the tail outcome fixes `hit=false` for these releases without widening any timing window. Synthetic regression: one +1000 ms key-up changes accepted 0 → 1.
- **Mods/Classic:** [ManiaModClassic](https://github.com/ppy/osu/blob/9a10d935b05a3b896f4bd811d620f2023331db93/osu.Game.Rulesets.Mania/Mods/ManiaModClassic.cs) changes head/tail windows, not LN judgement structure; it does not emulate ScoreV1's combined hold judgement. [ManiaHitWindows](https://github.com/ppy/osu/blob/9a10d935b05a3b896f4bd811d620f2023331db93/osu.Game.Rulesets.Mania/Scoring/ManiaHitWindows.cs) supplies Classic/SV2, HR/EZ and rate scaling. Existing edge tests cover Classic with/without SV2 and HR+DT. Map-time offsets are divided by replay rate for real-time calibration.
- **Non-hold key-ups:** never enter samples; only `heldInputs` populate them. Counts over holds are re-grabs, not stray taps. New wording calls these “hold releases” and explains repeated samples.
- **Half-millisecond ambiguity:** existing recorded-statistics reconciliation changes reached outcome objects in-place, so release acceptance sees reconciled grades. It does not recover a tail already passively timed out before the recorded key-up; whole-millisecond replay frames cannot identify the original side of every sub-millisecond boundary. No measured play showed an extra simulated miss from that path. This audit does not claim mathematically exact acceptance for all possible quantized replays, and adds no blanket tolerance or aggregate-statistics-driven rewriting of earlier combo state.

The audit deliberately does not replace real misses/drops with accepted samples merely to increase calibration sample size.
