/**
 * Gameplay goldens: render-core's input-driven elements against osu!lazer's
 * own, as dumped by test/reference/VosuLayout.cs while its autoplay plays
 * tiny maps frame by frame (60 Hz from 0, so every press is seen on time).
 * render-core gets the same autoplay replay as `input` (the dump's legacy
 * frames). test/gameplayGolden.ts writes the fixture; `bun test` replays it.
 *
 * Compared: the taiko drum's flashes, catcher trails and after-images, the
 * plate's dropped and exploded objects, and the osu! cursor and cursormiddle.
 * Not compared: things the headless harness cannot clock or lazer draws at
 * random (kiai glow and mascot frames follow beats; stacked plate objects
 * move by lazer's unseeded RNG, so only the first object of a combo keeps an
 * exact x; the cursor trail is a custom draw node the dump does not list).
 */
import type { InputFrame } from "../src/scene";
import type { LayoutCase, LayoutItem, LayoutResult, PlacedItem } from "./layoutCompare";
import { textureAsset } from "./judgementCompare";

export interface GameplayCase extends LayoutCase {
  ruleset: "osu" | "taiko" | "catch";
  /** The skin's name in `GAMEPLAY_SKINS`. */
  skin: string;
  from: number;
}
export interface GameplayGolden extends GameplayCase {
  result: LayoutResult;
  frames: InputFrame[];
}

const FRAME = 1000 / 60;
/** Dump times on the 60 Hz grid (frame indices). */
const at = (...frames: number[]) => frames.map((f) => f * FRAME);

export const GAMEPLAY_MAPS: Record<GameplayCase["ruleset"], string> = {
  taiko:
    "osu file format v14\n[General]\nMode: 1\n[Difficulty]\nHPDrainRate:5\nCircleSize:5\nOverallDifficulty:5\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n256,192,1000,1,0\n256,192,1500,1,2\n256,192,2000,1,4\n256,192,2500,1,12\n256,192,2600,1,0\n",
  catch:
    "osu file format v14\n[General]\nMode: 2\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:5\nApproachRate:8\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n256,192,1000,5,0\n50,192,1250,1,0\n470,192,1400,1,0\n470,192,1700,1,0\n256,192,2200,5,0\n",
  osu:
    "osu file format v14\n[General]\nMode: 0\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:8\nApproachRate:9\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n100,100,1000,5,0\n400,300,1500,1,0\n256,192,2000,5,0\n",
};
export const GAMEPLAY_TIMES: Record<GameplayCase["ruleset"], number[]> = {
  // Presses at 1000 (frame 60), 1500, 2000 (both centres), 2500, 2600.
  taiko: at(61, 63, 64, 66, 67, 68, 91, 94, 96, 121, 124, 151, 157, 158),
  // Dashes to 50 at 1250, hyper-dashes to 470 at 1400; the combo ends at 1700.
  catch: at(70, 76, 78, 80, 85, 87, 90, 100, 103, 108, 114, 120),
  osu: at(58, 60, 62, 64, 66, 75, 90, 93, 96, 105),
};

/** Synthetic skins: images of distinct sizes (lazer draws its classic look for the rest). */
export const GAMEPLAY_SKINS = [
  {
    name: "gameplay",
    ini: "[General]\nName: gameplay\nVersion: 2.7\nCursorRotate: 0\n",
    files: {
      "taiko-bar-left.png": [180, 200],
      "taiko-drum-inner.png": [90, 140],
      "taiko-drum-outer.png": [100, 150],
      "fruit-catcher-idle.png": [300, 320],
      "fruit-catcher-kiai.png": [310, 320],
      "fruit-catcher-fail.png": [320, 320],
      // Plate and dropped objects (lazer's classic fruits are larger than our placeholders).
      ...Object.fromEntries(
        ["pear", "grapes", "apple", "orange"].flatMap((f, i) => [
          [`fruit-${f}.png`, [120 + 2 * i, 120 + 2 * i]],
          [`fruit-${f}-overlay.png`, [110 + 2 * i, 110 + 2 * i]],
        ]),
      ),
      "cursor.png": [60, 60],
      "cursormiddle.png": [20, 20],
      "cursortrail.png": [30, 30],
    } as Record<string, [number, number]>,
  },
  {
    // Skins before 2.1 place the drum halves differently.
    name: "gameplay-old",
    ini: "[General]\nName: gameplay-old\nVersion: 1.0\n",
    files: {
      "taiko-bar-left.png": [180, 200],
      "taiko-drum-inner.png": [90, 140],
      "taiko-drum-outer.png": [100, 150],
    } as Record<string, [number, number]>,
  },
];

export const GAMEPLAY_CASES: GameplayCase[] = [
  ...(["taiko", "catch", "osu"] as const).flatMap((ruleset) =>
    GAMEPLAY_TIMES[ruleset].map((time) => ({
      name: `${ruleset}-${Math.round(time)}`,
      ruleset,
      skin: "gameplay",
      map: ruleset,
      width: 1365.3334,
      height: 768,
      time,
      from: 0,
    })),
  ),
  ...at(61, 63, 67, 91, 124).map((time) => ({
    name: `taiko-old-${Math.round(time)}`,
    ruleset: "taiko" as const,
    skin: "gameplay-old",
    map: "taiko",
    width: 1365.3334,
    height: 768,
    time,
    from: 0,
  })),
];

/** Which of lazer's drawables a ruleset's gameplay golden compares. */
export function lazerGameplayItems(ruleset: GameplayCase["ruleset"], items: readonly LayoutItem[]): LayoutItem[] {
  return items.filter((item) => {
    const name = item.texture?.name ? textureAsset(item.texture.name) : "";
    if (item.alpha <= 0.02) return false;
    if (ruleset === "taiko") return /^taiko-drum-(inner|outer)$/.test(name);
    if (ruleset === "catch")
      return (
        item.path.some((p) => p.startsWith("CatcherTrail")) ||
        (item.path.some((p) => p.startsWith("DroppedObjectContainer")) && /^fruit-/.test(name))
      );
    return /^cursor(middle)?$/.test(name) && item.path.some((p) => p.startsWith("OsuCursor"));
  });
}

export interface GameplayMismatch {
  asset: string;
  reason: string;
  lazer?: { centre: number[]; size: number[]; alpha: number };
  ours?: { centre: number[]; size: number[]; alpha: number };
}
const centreOf = (q: readonly number[]) => [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];
const sizeOf = (q: readonly number[]) => [Math.hypot(q[2] - q[0], q[3] - q[1]), Math.hypot(q[4] - q[0], q[5] - q[1])];
const round = (v: readonly number[]) => v.map((x) => +x.toFixed(2));

/**
 * Matches lazer's drawables to ours by image and nearest centre: centres
 * within 1.5 units (within 200 for `loose` items, placed at random by lazer),
 * sizes within 2 %, opacity within 0.05.
 */
export function compareGameplay(
  theirs: readonly LayoutItem[],
  ours: readonly PlacedItem[],
  loose: (asset: string) => boolean = () => false,
): GameplayMismatch[] {
  const used = new Set<PlacedItem>(),
    out: GameplayMismatch[] = [];
  for (const item of theirs) {
    const name = textureAsset(item.texture!.name!).toLowerCase(),
      centre = centreOf(item.quad),
      size = sizeOf(item.quad),
      lazer = { centre: round(centre), size: round(size), alpha: +item.alpha.toFixed(3) };
    const best = ours
      .filter((p) => !used.has(p) && p.asset.toLowerCase() === name)
      .sort((a, b) => Math.hypot(a.centre[0] - centre[0], a.centre[1] - centre[1]) - Math.hypot(b.centre[0] - centre[0], b.centre[1] - centre[1]))[0];
    if (!best) {
      out.push({ asset: name, reason: "missing", lazer });
      continue;
    }
    used.add(best);
    const view = { centre: round(best.centre), size: round(best.size), alpha: +best.alpha.toFixed(3) };
    const placeOk =
      Math.hypot(best.centre[0] - centre[0], best.centre[1] - centre[1]) <= (loose(name) ? 200 : 1.5);
    const sizeOk = best.size.every((v, i) => Math.abs(v - size[i]) <= Math.max(0.5, size[i] * 0.02));
    if (!placeOk || !sizeOk || Math.abs(best.alpha - item.alpha) > 0.05)
      out.push({ asset: name, reason: !placeOk ? "place" : !sizeOk ? "size" : "opacity", lazer, ours: view });
  }
  for (const p of ours)
    if (!used.has(p) && p.alpha > 0.02)
      out.push({ asset: p.asset, reason: "extra", ours: { centre: round(p.centre), size: round(p.size), alpha: +p.alpha.toFixed(3) } });
  return out;
}
