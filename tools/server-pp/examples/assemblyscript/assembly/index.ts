// Example server-pp calculator module in AssemblyScript (ABI v1, see
// tools/server-pp/CALCULATORS.md). An example osu!mania formula written for
// this example only; it is not any real server's formula.
//
// Build: `bun install && bun run build` in this folder.

// Slot numbers from CALCULATORS.md / abi/v1.rs.
const ABI_VERSION: i32 = 1;
const RULESET = 1;
const MODS = 2;
const N300 = 10;
const N100 = 11;
const N50 = 12;
const N_GEKI = 13; // mania: 320
const N_KATU = 14; // mania: 200
const MISSES = 15;
const STARS = 24;
const MANIA_N_OBJECTS = 40;
const MANIA_N_HOLD_NOTES = 41;

const NF: u32 = 1;
const EZ: u32 = 2;

const UNSUPPORTED_RULESET: i32 = 1;
const UNSUPPORTED_MODS: i32 = 2;

// Static buffers the host reads and writes. Linear memory only grows, so
// these addresses stay valid for the module's lifetime.
const INPUT = memory.data(64 * 8, 8);
const OUTPUT = memory.data(16 * 8, 8);
const ERROR = memory.data(513);
const INFO = memory.data(1024);

const INFO_JSON =
  '{"name":"AssemblyScript example","version":"1.0.0","author":"18-LAB",' +
  '"description":"Example osu!mania formula with a judgement-weighted accuracy curve.",' +
  '"rulesets":["mania"],"breakdown":["difficulty","accuracy_factor","hold_bonus"]}';

function slot(index: i32): f64 {
  return load<f64>(INPUT + <usize>index * 8);
}

function setOutput(index: i32, value: f64): void {
  store<f64>(OUTPUT + <usize>index * 8, value);
}

// Copies an ASCII string into a static buffer with a NUL terminator.
function writeAscii(buffer: usize, capacity: i32, text: string): usize {
  const length = min(text.length, capacity - 1);
  for (let i = 0; i < length; i++) {
    store<u8>(buffer + <usize>i, <u8>text.charCodeAt(i));
  }
  store<u8>(buffer + <usize>length, 0);
  return buffer;
}

function fail(code: i32, message: string): i32 {
  writeAscii(ERROR, 513, message);
  return code;
}

export function vosu_pp_abi_version(): i32 {
  return ABI_VERSION;
}

export function vosu_pp_input(): usize {
  return INPUT;
}

export function vosu_pp_output(): usize {
  return OUTPUT;
}

export function vosu_pp_error(): usize {
  return ERROR;
}

export function vosu_pp_info(): usize {
  return writeAscii(INFO, 1024, INFO_JSON);
}

export function vosu_pp_calculate(): i32 {
  store<u8>(ERROR, 0);
  if (<i32>slot(RULESET) != 3) {
    return fail(UNSUPPORTED_RULESET, "this example scores osu!mania only");
  }
  const mods = <u32>slot(MODS);
  if ((mods & (1 << 29)) != 0) {
    return fail(UNSUPPORTED_MODS, "this example has no ScoreV2 rules");
  }

  const n320 = slot(N_GEKI);
  const n300 = slot(N300);
  const n200 = slot(N_KATU);
  const n100 = slot(N100);
  const n50 = slot(N50);
  const misses = slot(MISSES);
  const judged = n320 + n300 + n200 + n100 + n50 + misses;
  if (judged == 0) {
    setOutput(0, 0);
    setOutput(1, 0);
    setOutput(2, 0);
    setOutput(3, 1);
    return 0;
  }

  // Judgement weights reward MAX (320) hits more than stable accuracy does.
  const weighted = (n320 * 1.0 + n300 * 0.97 + n200 * 0.65 + n100 * 0.25 + n50 * 0.1) / judged;
  const accuracyFactor = Math.pow(weighted, 6.0);

  const stars = slot(STARS);
  const difficulty = 9.0 * Math.pow(Math.max(stars - 0.2, 0.05), 2.3);

  const objects = slot(MANIA_N_OBJECTS);
  const holds = slot(MANIA_N_HOLD_NOTES);
  const holdBonus = 1.0 + (objects > 0 ? 0.05 * (holds / objects) : 0.0);
  const length = 1.0 + 0.15 * Math.min(1.0, objects / 2000.0);

  let pp = difficulty * accuracyFactor * holdBonus * length * Math.pow(0.985, misses);
  if ((mods & EZ) != 0) pp *= 0.5;
  if ((mods & NF) != 0) pp *= 0.8;

  setOutput(0, pp);
  setOutput(1, difficulty);
  setOutput(2, accuracyFactor);
  setOutput(3, holdBonus);
  return 0;
}
