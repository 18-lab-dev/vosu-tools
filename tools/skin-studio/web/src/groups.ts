// Element groups a mix can take from different skins. Element names follow
// the osu! wiki skinning reference; `*` is a prefix wildcard and `anim`
// marks elements whose frames are `name-0.png …` (or `name0.png`).

export type Category =
  "osu" | "taiko" | "fruits" | "mania" | "cursor" | "interface" | "sounds";

export interface Element {
  name: string;
  anim?: boolean;
  audio?: boolean;
}
export interface IniKey {
  section: string;
  /** Exact key, or a regular expression source when `pattern` is set. */
  key: string;
  pattern?: boolean;
}
export interface Group {
  id: string;
  label: string;
  category: Category;
  elements: Element[];
  ini?: IniKey[];
  /** Dynamic mania key-count group: the whole `[Mania]` block for `Keys`. */
  maniaKeys?: number;
}

export const categories: { id: Category; label: string }[] = [
  { id: "osu", label: "osu!" },
  { id: "taiko", label: "Taiko" },
  { id: "fruits", label: "Catch" },
  { id: "mania", label: "Mania" },
  { id: "cursor", label: "Cursor & numbers" },
  { id: "interface", label: "Interface" },
  { id: "sounds", label: "Sounds" },
];

const img = (...names: string[]): Element[] => names.map((name) => ({ name }));
const anim = (...names: string[]): Element[] =>
  names.map((name) => ({ name, anim: true }));
const sfx = (...names: string[]): Element[] =>
  names.map((name) => ({ name, audio: true }));
const keys = (section: string, ...names: string[]): IniKey[] =>
  names.map((key) => ({ section, key }));

export const groups: Group[] = [
  {
    id: "hitcircles",
    label: "Hit circles",
    category: "osu",
    elements: [
      ...img("hitcircle", "approachcircle", "hitcircleselect", "lighting"),
      ...anim("hitcircleoverlay"),
    ],
    ini: keys(
      "General",
      "HitCircleOverlayAboveNumber",
      "HitCircleOverlayAboveNumer",
    ),
  },
  {
    id: "combo-colours",
    label: "Combo colours",
    category: "osu",
    elements: [],
    ini: [{ section: "Colours", key: "^Combo[1-8]$", pattern: true }],
  },
  {
    id: "sliders",
    label: "Sliders",
    category: "osu",
    elements: [
      ...img(
        "sliderstartcircle",
        "sliderendcircle",
        "sliderb-nd",
        "sliderb-spec",
        "sliderpoint10",
        "sliderpoint30",
        "sliderscorepoint",
      ),
      ...anim(
        "sliderstartcircleoverlay",
        "sliderendcircleoverlay",
        "sliderfollowcircle",
        "sliderb",
        "reversearrow",
        "followpoint",
      ),
    ],
    ini: [
      ...keys("Colours", "SliderBorder", "SliderTrackOverride", "SliderBall"),
      ...keys(
        "General",
        "SliderBallFlip",
        "AllowSliderBallTint",
        "SliderStyle",
      ),
    ],
  },
  {
    id: "spinner",
    label: "Spinner",
    category: "osu",
    elements: img(
      "spinner-approachcircle",
      "spinner-background",
      "spinner-bottom",
      "spinner-circle",
      "spinner-clear",
      "spinner-glow",
      "spinner-metre",
      "spinner-middle",
      "spinner-middle2",
      "spinner-osu",
      "spinner-rpm",
      "spinner-spin",
      "spinner-top",
    ),
    ini: [
      ...keys("Colours", "SpinnerBackground"),
      ...keys(
        "General",
        "SpinnerFadePlayfield",
        "SpinnerNoBlink",
        "SpinnerFrequencyModulate",
      ),
    ],
  },
  {
    id: "judgements",
    label: "Hit judgements",
    category: "osu",
    elements: [
      ...anim(
        "hit0",
        "hit50",
        "hit100",
        "hit100k",
        "hit300",
        "hit300g",
        "hit300k",
      ),
      ...img("particle50", "particle100", "particle300"),
    ],
  },
  {
    id: "taiko-playfield",
    label: "Drum & playfield",
    category: "taiko",
    elements: [
      ...img(
        "taiko-bar-left",
        "taiko-bar-right",
        "taiko-bar-right-glow",
        "taiko-drum-inner",
        "taiko-drum-outer",
        "taiko-barline",
        "taiko-glow",
        "taiko-slider",
        "taiko-slider-fail",
      ),
      ...anim("taiko-flower-group"),
    ],
  },
  {
    id: "taiko-notes",
    label: "Notes & rolls",
    category: "taiko",
    elements: [
      ...img(
        "taikohitcircle",
        "taikobigcircle",
        "taiko-roll-middle",
        "taiko-roll-end",
      ),
      ...anim("taikohitcircleoverlay", "taikobigcircleoverlay"),
    ],
  },
  {
    id: "taiko-judgements",
    label: "Taiko judgements",
    category: "taiko",
    elements: anim(
      "taiko-hit0",
      "taiko-hit100",
      "taiko-hit100k",
      "taiko-hit300",
      "taiko-hit300k",
      "taiko-hit300g",
    ),
  },
  {
    id: "taiko-pippidon",
    label: "Pippidon",
    category: "taiko",
    elements: anim(
      "pippidonclear",
      "pippidonfail",
      "pippidonidle",
      "pippidonkiai",
    ),
  },
  {
    id: "catch-fruits",
    label: "Fruits",
    category: "fruits",
    elements: img(
      "fruit-apple",
      "fruit-apple-overlay",
      "fruit-grapes",
      "fruit-grapes-overlay",
      "fruit-orange",
      "fruit-orange-overlay",
      "fruit-pear",
      "fruit-pear-overlay",
      "fruit-bananas",
      "fruit-bananas-overlay",
      "fruit-drop",
      "fruit-drop-overlay",
    ),
    ini: keys(
      "CatchTheBeat",
      "HyperDash",
      "HyperDashFruit",
      "HyperDashAfterImage",
    ),
  },
  {
    id: "catch-catcher",
    label: "Catcher",
    category: "fruits",
    elements: [
      ...anim("fruit-catcher-idle", "fruit-catcher-fail", "fruit-catcher-kiai"),
      ...img("fruit-ryuuta"),
    ],
  },
  {
    id: "mania-shared",
    label: "Default mania elements",
    category: "mania",
    elements: [...anim("mania-*"), ...anim("lightingN", "lightingL")],
  },
  {
    id: "cursor",
    label: "Cursor",
    category: "cursor",
    elements: img(
      "cursor",
      "cursortrail",
      "cursormiddle",
      "cursor-smoke",
      "cursor-ripple",
    ),
    ini: keys(
      "General",
      "CursorCentre",
      "CursorExpand",
      "CursorRotate",
      "CursorTrailRotate",
    ),
  },
  {
    id: "numbers",
    label: "Numbers & fonts",
    category: "cursor",
    elements: img("default-*", "score-*", "combo-*"),
    ini: keys(
      "Fonts",
      "HitCirclePrefix",
      "HitCircleOverlap",
      "ScorePrefix",
      "ScoreOverlap",
      "ComboPrefix",
      "ComboOverlap",
    ),
  },
  {
    id: "hud",
    label: "HUD",
    category: "interface",
    elements: [
      ...img(
        "scorebar-bg",
        "scorebar-ki",
        "scorebar-kidanger",
        "scorebar-kidanger2",
        "scorebar-marker",
        "inputoverlay-background",
        "inputoverlay-key",
        "play-unranked",
        "play-warningarrow",
        "arrow-pause",
        "arrow-warning",
        "section-fail",
        "section-pass",
        "multi-skipped",
        "ready",
        "count1",
        "count2",
        "count3",
        "go",
      ),
      ...anim(
        "scorebar-colour",
        "play-skip",
        "comboburst",
        "comboburst-fruits",
        "comboburst-mania",
      ),
    ],
    ini: [
      ...keys("Colours", "InputOverlayText"),
      ...keys("General", "ComboBurstRandom", "CustomComboBurstSounds"),
    ],
  },
  {
    id: "song-select",
    label: "Song select",
    category: "interface",
    elements: [
      ...anim("menu-back"),
      ...img(
        "menu-button-background",
        "selection-mode",
        "selection-mode-over",
        "selection-mods",
        "selection-mods-over",
        "selection-random",
        "selection-random-over",
        "selection-options",
        "selection-options-over",
        "selection-tab",
        "star",
        "star2",
        "mode-osu",
        "mode-osu-small",
        "mode-taiko",
        "mode-taiko-small",
        "mode-fruits",
        "mode-fruits-small",
        "mode-mania",
        "mode-mania-small",
        "button-left",
        "button-middle",
        "button-right",
      ),
    ],
    ini: keys("Colours", "SongSelectActiveText", "SongSelectInactiveText"),
  },
  {
    id: "mod-icons",
    label: "Mod icons",
    category: "interface",
    elements: img("selection-mod-*"),
  },
  {
    id: "main-menu",
    label: "Main menu",
    category: "interface",
    elements: img("welcome_text", "menu-background", "menu-snow"),
    ini: keys("Colours", "MenuGlow"),
  },
  {
    id: "pause-fail",
    label: "Pause & fail",
    category: "interface",
    elements: img(
      "pause-overlay",
      "fail-background",
      "pause-back",
      "pause-continue",
      "pause-replay",
      "pause-retry",
    ),
  },
  {
    id: "ranking",
    label: "Results screen",
    category: "interface",
    elements: img(
      "ranking-panel",
      "ranking-graph",
      "ranking-title",
      "ranking-accuracy",
      "ranking-maxcombo",
      "ranking-perfect",
      "ranking-replay",
      "ranking-retry",
      "ranking-winner",
      "ranking-*",
    ),
  },
  {
    id: "hitsounds",
    label: "Hitsounds",
    category: "sounds",
    elements: sfx(
      "normal-*",
      "soft-*",
      "drum-*",
      "taiko-normal-*",
      "taiko-soft-*",
      "taiko-drum-*",
    ),
  },
  {
    id: "spinner-sounds",
    label: "Spinner & combo sounds",
    category: "sounds",
    elements: sfx(
      "spinnerspin",
      "spinnerbonus",
      "combobreak",
      "comboburst",
      "comboburst-*",
    ),
  },
  {
    id: "interface-sounds",
    label: "Interface sounds",
    category: "sounds",
    elements: sfx(
      "applause",
      "back-button-click",
      "back-button-hover",
      "check-on",
      "check-off",
      "click-close",
      "click-short",
      "click-short-confirm",
      "count",
      "count1s",
      "count2s",
      "count3s",
      "failsound",
      "gos",
      "heartbeat",
      "key-confirm",
      "key-delete",
      "key-movement",
      "key-press-1",
      "key-press-2",
      "key-press-3",
      "key-press-4",
      "match-confirm",
      "match-join",
      "match-leave",
      "match-notready",
      "match-ready",
      "match-start",
      "menu-back-click",
      "menu-back-hover",
      "menu-charts-click",
      "menu-charts-hover",
      "menu-direct-click",
      "menu-direct-hover",
      "menu-edit-click",
      "menu-edit-hover",
      "menu-exit-click",
      "menu-exit-hover",
      "menu-freeplay-click",
      "menu-freeplay-hover",
      "menu-multiplayer-click",
      "menu-multiplayer-hover",
      "menu-options-click",
      "menu-options-hover",
      "menu-play-click",
      "menu-play-hover",
      "menuback",
      "menuclick",
      "menuhit",
      "menuhover",
      "metronomelow",
      "nightcore-clap",
      "nightcore-finish",
      "nightcore-hat",
      "nightcore-kick",
      "pause-loop",
      "pause-back-click",
      "pause-back-hover",
      "pause-continue-click",
      "pause-continue-hover",
      "pause-retry-click",
      "pause-retry-hover",
      "readys",
      "sectionfail",
      "sectionpass",
      "seeya",
      "select-difficulty",
      "select-expand",
      "shutter",
      "sliderbar",
      "welcome",
      "welcome_piano",
    ),
  },
];

export const imageExt = /\.(png|jpe?g)$/i;
export const audioExt = /\.(wav|ogg|mp3)$/i;

/** File stem: lower-cased name without extension or `@2x`. */
export const stem = (name: string) =>
  name
    .replace(/\.[^./]+$/, "")
    .replace(/@2x$/i, "")
    .toLowerCase();

/** Whether a root-level skin file belongs to an element. */
export function elementMatches(element: Element, file: string): boolean {
  if (file.includes("/")) return false;
  if (!(element.audio ? audioExt : imageExt).test(file)) return false;
  const base = stem(file);
  const name = element.name.toLowerCase();
  if (name.endsWith("*")) return base.startsWith(name.slice(0, -1));
  if (base === name) return true;
  return !!element.anim && new RegExp(`^${escape(name)}-?\\d+$`).test(base);
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Animation frame names (prefers @2x when every frame has it). */
export function frames(files: string[], element: string): string[] {
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  let best: string[] = [];
  for (const sep of ["-", ""])
    for (const hd of ["@2x", ""]) {
      const found: string[] = [];
      for (let i = 0; i < 240; i++) {
        const hit = lower.get(`${element.toLowerCase()}${sep}${i}${hd}.png`);
        if (!hit) break;
        found.push(hit);
      }
      if (found.length > best.length) best = found;
    }
  return best.length >= 2 ? best : [];
}

/** Files matching a group's element names (root-level only). */
export function elementFiles(group: Group, files: string[]): string[] {
  return files.filter((file) =>
    group.elements.some((element) => elementMatches(element, file)),
  );
}
