import { vosu } from '/tools/_host/v1/bridge.js';
import './style.css';
import { Preview } from './preview';
import { Timeline, type TimelineData } from './timeline';
import { clock, nearestOutputTime, parseClock, sourceTime, type Range, type Window } from './time';
import { Follow, SUBSCRIPTION } from './follow';
import { ClientSkin } from '@vosu-tools/client-skin';
import { sceneScope } from '@vosu-tools/render-core';

// The look comes from vosu's shared theme.css; the bridge sets data-theme.

type Ruleset = 'osu' | 'taiko' | 'fruits' | 'mania';
type Options = {
  rate: number; target_bpm: number | null; pitch_preserving: boolean;
  hp: number | null; cs: number | null; ar: number | null; od: number | null; lock_ar: boolean; lock_od: boolean;
  mods: string[]; seed: number; mirror: string; angle_sharpness: number;
  trims: Range[]; lead_in_ms: number; lead_out_ms: number; gap_ms: number; fade_ms: number;
};
type Stats = { ruleset: Ruleset; objects: number; length_ms: number; bpm: number; hp: number; cs: number; ar: number; od: number; keys: number | null };
type Current = {
  client: string | null;
  beatmap: null | { md5: string; title: string; artist: string; creator: string; version: string; played_ruleset: string; background: boolean; stats: Stats };
  ratings: { msd?: { overall: number } } | null;
};
type PreviewResult = { stats: Stats; version: string; rate: number; windows: Window[]; warnings: string[]; osu: string };
type Profiles = { active: string | null; profiles: Record<string, Options>; defaults: Options };
type Entry = { name: string; files: { path: string }[]; warnings: string[]; export: boolean };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

// Transforms each ruleset can bake into a stable map, and the stats it uses.
const TRANSFORMS: Record<Ruleset, [string, string][]> = {
  osu: [['MR', 'Mirror'], ['RD', 'Random']],
  taiko: [['SW', 'Swap'], ['RD', 'Random'], ['CS', 'Constant Speed']],
  fruits: [['MR', 'Mirror']],
  mania: [['IN', 'Invert'], ['HO', 'Hold Off'], ['MR', 'Mirror'], ['RD', 'Random'], ['CS', 'Constant Speed']],
};
const EXCLUSIVE: [string, string][] = [['IN', 'HO'], ['SW', 'RD']];
const DIFFICULTY: Record<Ruleset, ('hp' | 'cs' | 'ar' | 'od')[]> = {
  osu: ['hp', 'cs', 'ar', 'od'], taiko: ['hp', 'od'], fruits: ['hp', 'cs', 'ar'], mania: ['hp', 'od'],
};
const STAT_LABEL = { hp: 'HP', cs: 'CS', ar: 'AR', od: 'OD' } as const;
const RULESET_NAME: Record<Ruleset, string> = { osu: 'osu!', taiko: 'osu!taiko', fruits: 'osu!catch', mania: 'osu!mania' };

let current: Current | null = null;
let ruleset: Ruleset | null = null;
let options: Options;
let profiles: Profiles = { active: null, profiles: {}, defaults: {} as Options };
let latest: PreviewResult | null = null;
const trimsByMap = new Map<string, Range[]>();
let busy = false;
let job: string | null = null;

async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await vosu.fetch(path, body === undefined
    ? { method: method ?? 'GET' }
    : { method: method ?? 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const v = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(v.error ?? r.statusText);
  return v as T;
}
function say(text: string, tone: 'info' | 'error' = 'info') {
  $('status').textContent = text;
  $('status').dataset.tone = tone;
}
const fail = (e: unknown) => say(e instanceof Error ? e.message : String(e), 'error');
const debounce = (fn: () => void, ms: number) => {
  let timer = 0;
  return () => { clearTimeout(timer); timer = window.setTimeout(fn, ms); };
};
const num = (v: number, digits = 2) => (Number.isInteger(v) && digits === 0 ? String(v) : v.toFixed(digits));

// ---- Options ↔ form ------------------------------------------------------

const trims = (): Range[] => (current?.beatmap ? trimsByMap.get(current.beatmap.md5) ?? [] : []);

/** What the service receives: only the current ruleset's transforms and stats. */
function outgoing(): Options {
  const r = ruleset ?? 'osu';
  const relevant = DIFFICULTY[r];
  const pick = (k: 'hp' | 'cs' | 'ar' | 'od') => (relevant.includes(k) ? options[k] : null);
  return {
    ...options,
    target_bpm: null,
    mods: options.mods.filter((m) => TRANSFORMS[r].some(([id]) => id === m)),
    mirror: r === 'osu' ? options.mirror : 'horizontal',
    hp: pick('hp'), cs: pick('cs'), ar: pick('ar'), od: pick('od'),
    lock_ar: relevant.includes('ar') && options.lock_ar,
    lock_od: relevant.includes('od') && options.lock_od,
    trims: trims(),
  };
}

function readForm() {
  const rate = Number(field('rate').value);
  if (Number.isFinite(rate)) options.rate = rate;
  options.pitch_preserving = !field('pitch').checked;
  for (const key of ['lead_in_ms', 'lead_out_ms', 'gap_ms', 'fade_ms'] as const) {
    const v = Number(field(key).value);
    if (field(key).value !== '' && Number.isFinite(v)) options[key] = v;
  }
  for (const key of ['hp', 'cs', 'ar', 'od'] as const) {
    const input = form.elements.namedItem(key) as HTMLInputElement | null;
    if (input) options[key] = input.value === '' ? null : Number(input.value);
  }
  for (const key of ['lock_ar', 'lock_od'] as const) {
    const input = form.elements.namedItem(key) as HTMLInputElement | null;
    if (input) options[key] = input.checked;
  }
  const seed = form.elements.namedItem('seed') as HTMLInputElement | null;
  if (seed && seed.value !== '') options.seed = Math.trunc(Number(seed.value));
  const sharpness = form.elements.namedItem('angle_sharpness') as HTMLInputElement | null;
  if (sharpness && sharpness.value !== '') options.angle_sharpness = Number(sharpness.value);
  const mirror = form.elements.namedItem('mirror') as HTMLSelectElement | null;
  if (mirror) options.mirror = mirror.value;
}

function writeForm() {
  field('rate').value = num(options.rate);
  field('pitch').checked = !options.pitch_preserving;
  for (const key of ['lead_in_ms', 'lead_out_ms', 'gap_ms', 'fade_ms'] as const) field(key).value = String(options[key]);
  renderRuleset();
  tempo();
}

function input(name: string, label: string, attrs: Record<string, string>, value: string, placeholder = ''): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'v-field';
  const text = document.createElement('span');
  text.textContent = label;
  const el = document.createElement('input');
  el.className = 'v-input';
  el.name = name;
  el.type = 'number';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.value = value;
  el.placeholder = placeholder;
  wrap.append(text, el);
  return wrap;
}
function toggle(name: string, label: string, checked: boolean): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'v-check';
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.name = name;
  el.checked = checked;
  wrap.append(el, ` ${label}`);
  return wrap;
}

/** Transforms, their options and the difficulty fields for the map's ruleset. */
function renderRuleset() {
  const mods = $('transforms');
  const extra = $('transform-options');
  const difficulty = $('difficulty');
  mods.replaceChildren();
  extra.replaceChildren();
  difficulty.replaceChildren();
  if (!ruleset) return;
  const has = (id: string) => options.mods.includes(id);
  // Pressed buttons toggle a transform; incompatible pairs disable each other.
  for (const [id, name] of TRANSFORMS[ruleset]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'v-btn v-btn--sm';
    button.dataset.mod = id;
    button.textContent = name;
    button.setAttribute('aria-pressed', String(has(id)));
    const other = EXCLUSIVE.find((pair) => pair.includes(id))?.find((m) => m !== id);
    if (other && has(other)) {
      button.disabled = true;
      button.title = `Not combinable with ${TRANSFORMS[ruleset].find(([m]) => m === other)?.[1] ?? other}`;
    }
    button.onclick = () => {
      options.mods = has(id) ? options.mods.filter((m) => m !== id) : [...options.mods, id];
      renderRuleset();
      form.dispatchEvent(new Event('input'));
    };
    mods.append(button);
  }
  if (ruleset === 'osu' && has('MR')) {
    const wrap = document.createElement('label');
    wrap.className = 'v-field';
    const text = document.createElement('span');
    text.textContent = 'Mirror axis';
    const select = document.createElement('select');
    select.className = 'v-select';
    select.name = 'mirror';
    for (const [value, label] of [['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['both', 'Both']]) {
      select.append(new Option(label, value, false, options.mirror === value));
    }
    wrap.append(text, select);
    extra.append(wrap);
  }
  if (has('RD') && ruleset !== 'fruits') {
    extra.append(input('seed', 'Seed', { min: '-2147483648', max: '2147483647', step: '1' }, String(options.seed)));
    if (ruleset === 'osu') extra.append(input('angle_sharpness', 'Angle sharpness', { min: '1', max: '10', step: '0.1' }, String(options.angle_sharpness)));
  }
  const source = current?.beatmap?.stats;
  for (const key of DIFFICULTY[ruleset]) {
    const original = source ? num(source[key], 1) : '';
    const placeholder = key === 'ar' || key === 'od' ? 'Auto' : original;
    difficulty.append(input(key, STAT_LABEL[key], { min: '0', max: '10', step: '0.1' }, options[key] === null ? '' : String(options[key]), placeholder));
  }
  if (DIFFICULTY[ruleset].includes('ar')) difficulty.append(toggle('lock_ar', 'Keep AR', options.lock_ar));
  if (DIFFICULTY[ruleset].includes('od')) difficulty.append(toggle('lock_od', 'Keep OD', options.lock_od));
}

function tempo() {
  const rate = options.rate;
  const slider = $<HTMLInputElement>('rate-slider');
  if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) slider.value = String(rate);
  $('rate-readout').textContent = Number.isFinite(rate) ? `${rate.toFixed(2)}×` : '—';
}

// ---- Stats banner ---------------------------------------------------------

function renderStats() {
  const list = $('stats');
  list.replaceChildren();
  const source = current?.beatmap?.stats;
  if (!source || !ruleset) return;
  const result = latest?.stats;
  const rows: [string, (s: Stats) => string][] = [];
  if (ruleset === 'mania') rows.push(['Keys', (s) => String(s.keys ?? '')]);
  rows.push(['Objects', (s) => s.objects.toLocaleString()]);
  rows.push(['Length', (s) => clock(s.length_ms)]);
  rows.push(['BPM', (s) => num(s.bpm, Number.isInteger(s.bpm) ? 0 : 1)]);
  for (const key of DIFFICULTY[ruleset]) rows.push([STAT_LABEL[key], (s) => num(s[key], 1)]);
  for (const [label, format] of rows) {
    const item = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    const from = format(source);
    const to = result ? format(result) : null;
    dd.textContent = from;
    if (to !== null && to !== from) {
      const arrow = document.createElement('span');
      arrow.className = 'to';
      arrow.textContent = ` → ${to}`;
      dd.append(arrow);
    }
    item.append(dt, dd);
    list.append(item);
  }
  const msd = current?.ratings?.msd?.overall;
  if (ruleset === 'mania' && msd !== undefined) {
    const item = document.createElement('div');
    item.className = 'stat-msd';
    item.innerHTML = '<dt>MSD at rate</dt><dd></dd>';
    item.querySelector('dd')!.textContent = msd.toFixed(2);
    item.title = 'Mania ratings, source map at the selected rate, before transforms';
    list.append(item);
  }
}

// ---- Map, timeline, preview ---------------------------------------------------

// Seeking or scrubbing into a trimmed-away part goes to the nearest kept time.
const seekSource = (sourceMs: number) => preview.seek(nearestOutputTime(sourceMs, preview.rate, preview.windows));
const timeline = new Timeline($('strip'), $('axis'), (ranges) => setTrims(ranges), seekSource, seekSource);
const preview = new Preview(
  $<HTMLCanvasElement>('canvas'),
  (t, duration, playing) => {
    $('clock').textContent = `${clock(t, true)} / ${clock(duration, true)}`;
    $('play').textContent = playing ? 'Pause' : 'Play';
    timeline.setPlayhead(duration ? sourceTime(t, preview.rate, preview.windows) : null);
  },
  (message) => stageMessage(message),
  // Skin images are decoded for the previewed ruleset and key count only;
  // the first frame waits for the client's skin instead of drawing the fallback.
  (map) => skins.useScope(sceneScope(map)),
  (backend) => {
    const el = $('backend');
    el.textContent = backend.label;
    el.title = backend.detail;
    el.hidden = false;
  },
);
// The preview draws with the osu! client's current skin and follows changes
// to it (from the game subscription below); misses fall back to the classic look.
const skins = new ClientSkin({
  scope: { rulesets: [], maniaKeys: [] },
  onChange(state) {
    preview.setSkin(state.skin);
    const el = $('skin');
    el.textContent = state.label;
    el.title = [state.source, state.message].filter(Boolean).join(' · ');
    el.dataset.tone = state.message ? state.tone : 'info';
    el.setAttribute('aria-busy', String(state.busy));
  },
});
preview.setSkin(skins.state.skin);

function stageMessage(text: string | null, tone: 'info' | 'error' = 'info') {
  const el = $('preview-message');
  el.hidden = !text;
  el.textContent = text ?? '';
  el.dataset.tone = tone;
}

function setTrims(ranges: Range[]) {
  if (!current?.beatmap) return;
  trimsByMap.set(current.beatmap.md5, ranges.map((r) => ({ start_ms: Math.round(r.start_ms), end_ms: Math.round(r.end_ms) })));
  renderTrims();
  refreshPreview();
}

function renderTrims() {
  const list = $('trim-list');
  list.replaceChildren();
  const ranges = trims();
  $('trim-empty').hidden = ranges.length > 0;
  $('clear-trims').hidden = ranges.length === 0;
  timeline.setRanges(ranges);
  ranges.forEach((range, index) => {
    const item = document.createElement('li');
    const edit = (edge: 'start_ms' | 'end_ms', label: string) => {
      const el = document.createElement('input');
      el.type = 'text';
      el.inputMode = 'decimal';
      el.className = 'v-input v-input--mono';
      el.value = clock(range[edge], true);
      el.setAttribute('aria-label', `Section ${index + 1} ${label}`);
      el.addEventListener('change', () => {
        const t = parseClock(el.value);
        if (t === null) { el.value = clock(range[edge], true); return; }
        const next = ranges.map((r) => ({ ...r }));
        next[index][edge] = t;
        if (next[index].end_ms <= next[index].start_ms) { el.value = clock(range[edge], true); return; }
        setTrims(next);
      });
      return el;
    };
    const count = document.createElement('span');
    count.className = 'trim-count';
    count.textContent = timeline.objectsIn(range).toLocaleString();
    count.title = `${timeline.objectsIn(range).toLocaleString()} objects`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'v-btn v-btn--ghost v-btn--sm v-btn--icon';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove section ${index + 1}`);
    remove.onclick = () => setTrims(ranges.filter((_, i) => i !== index));
    const dash = document.createElement('span');
    dash.textContent = '–';
    item.append(edit('start_ms', 'start'), dash, edit('end_ms', 'end'), count, remove);
    list.append(item);
  });
}

let previewSeq = 0;
const refreshPreview = debounce(() => void runPreview(), 250);
async function runPreview() {
  const seq = ++previewSeq;
  if (!current?.beatmap) return;
  const sent = outgoing();
  try {
    const result = await api<PreviewResult>(`v1/preview?options=${encodeURIComponent(JSON.stringify(sent))}`);
    if (seq !== previewSeq) return;
    latest = result;
    $('version').textContent = result.version;
    const warnings = $('warnings');
    warnings.replaceChildren(...result.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
    timeline.setWindows(result.windows);
    renderStats();
    stageMessage(null);
    await preview.show({ osu: result.osu, rate: result.rate, windows: result.windows, pitch: sent.pitch_preserving });
    $<HTMLButtonElement>('play').disabled = false;
  } catch (e) {
    if (seq !== previewSeq) return;
    latest = null;
    renderStats();
    stageMessage(e instanceof Error ? e.message : String(e), 'error');
  }
}

let timelineSeq = 0;
async function loadTimeline() {
  const seq = ++timelineSeq;
  $('timeline-label').textContent = 'Loading…';
  try {
    const data = await api<TimelineData>(`v1/timeline?rate=${options.rate}`);
    if (seq !== timelineSeq) return;
    timeline.setData(data);
    $('timeline-label').textContent = data.source === 'mania-ratings' ? `${data.label} · Mania ratings at ${options.rate.toFixed(2)}×` : `${data.label} at ${options.rate.toFixed(2)}×`;
    $('timeline-note').textContent = data.note ?? '';
    renderTrims();
  } catch (e) {
    if (seq !== timelineSeq) return;
    timeline.setData(null);
    $('timeline-label').textContent = '';
    $('timeline-note').textContent = e instanceof Error ? e.message : String(e);
  }
}
const refreshTimeline = debounce(() => void loadTimeline(), 300);

let mapSeq = 0;
async function loadMap() {
  const seq = ++mapSeq;
  // The service answers 409 while vosu still serves the previous difficulty's
  // file after a selection change: retry (100 ms doubling, at most 3 s apart).
  let v: Current | undefined;
  for (let delay = 100; !v; delay = Math.min(3000, delay * 2)) {
    const r = await vosu.fetch(`v1/current?rate=${options.rate}`, { method: 'GET' });
    if (seq !== mapSeq) return;
    if (r.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (seq !== mapSeq) return;
      continue;
    }
    const body = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) throw new Error(body.error ?? r.statusText);
    v = body as Current;
  }
  if (seq !== mapSeq) return;
  const changed = v.beatmap?.md5 !== current?.beatmap?.md5;
  current = v;
  const b = v.beatmap;
  ruleset = b?.stats.ruleset ?? null;
  $('title').textContent = b ? `${b.artist} — ${b.title}` : 'No beatmap selected';
  $('subtitle').textContent = b ? `${b.version} · ${b.creator}` : '';
  const chip = $('ruleset');
  chip.hidden = !ruleset;
  chip.textContent = ruleset ? RULESET_NAME[ruleset] : '';
  chip.dataset.ruleset = ruleset ?? '';
  const art = $<HTMLImageElement>('banner-art');
  if (b?.background) {
    art.hidden = false;
    art.src = `/files/beatmap/background?v=${b.md5}`;
    art.onerror = () => { art.hidden = true; };
  } else {
    art.hidden = true;
    art.removeAttribute('src');
  }
  if (changed) {
    latest = null;
    preview.clear();
    $<HTMLButtonElement>('play').disabled = true;
    $('version').textContent = '';
    $('warnings').replaceChildren();
    preview.setAudio(b ? `/files/beatmap/audio?v=${b.md5}` : null);
    renderRuleset();
    renderTrims();
    renderStats();
    if (b) {
      void loadTimeline();
      void runPreview();
    } else {
      timeline.setData(null);
    }
  } else {
    renderStats();
  }
  writable();
  // Mania stages are tall and narrow; the preview keeps them at full height
  // (see `.crop-stage` in style.css). Other rulesets fill the whole stage.
  $('main').classList.toggle('crop-stage', ruleset === 'mania');
}

// ---- Profiles ---------------------------------------------------------------

const comparable = (o: Options) => JSON.stringify({ ...o, trims: [] }, Object.keys(o).sort());
function markDirty() {
  const saved = profiles.active ? profiles.profiles[profiles.active] : profiles.defaults;
  $('dirty').hidden = !saved || comparable(saved) === comparable(options);
}
function renderProfiles() {
  const select = $<HTMLSelectElement>('profile');
  select.replaceChildren(new Option('No profile (defaults)', ''));
  for (const name of Object.keys(profiles.profiles)) select.append(new Option(name, name));
  select.value = profiles.active ?? '';
  $<HTMLButtonElement>('profile-delete').hidden = !profiles.active;
  writable();
  markDirty();
}
function applyProfile() {
  const base = profiles.active ? profiles.profiles[profiles.active] : profiles.defaults;
  options = structuredClone({ ...profiles.defaults, ...base });
  writeForm();
  renderProfiles();
}
async function profileAction(path: string, body: unknown, done: string) {
  try {
    profiles = await api<Profiles>(path, body);
    renderProfiles();
    markDirty();
    say(done);
  } catch (e) {
    fail(e);
  }
}

$<HTMLSelectElement>('profile').onchange = () => {
  const name = $<HTMLSelectElement>('profile').value;
  profiles.active = name || null;
  applyProfile();
  refreshAll();
  if (name && vosu.canWrite) void profileAction('v1/profiles/activate', { name }, `Profile “${name}” loaded.`);
};
$('profile-save').onclick = () => {
  if (profiles.active) void profileAction('v1/profiles', { name: profiles.active, options: outgoingProfile() }, `Saved “${profiles.active}”.`);
  else openSaveAs();
};
/** A profile keeps every ruleset's transforms, but never one map's trims. */
const outgoingProfile = (): Options => ({ ...options, trims: [] });
function openSaveAs() {
  $('profile-new').hidden = false;
  $<HTMLInputElement>('profile-name').value = '';
  $<HTMLInputElement>('profile-name').focus();
}
$('profile-save-as').onclick = openSaveAs;
$('profile-new-cancel').onclick = () => { $('profile-new').hidden = true; };
$<HTMLFormElement>('profile-new').onsubmit = (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('profile-name').value.trim();
  if (!name) return;
  $('profile-new').hidden = true;
  void profileAction('v1/profiles', { name, options: outgoingProfile() }, `Saved “${name}”.`);
};
$('profile-delete').onclick = () => {
  const name = profiles.active;
  if (!name || !confirm(`Delete the profile “${name}”?`)) return;
  void profileAction('v1/profiles/delete', { name }, `Deleted “${name}”.`).then(() => applyProfile());
};

// ---- Wiring -------------------------------------------------------------------

function writable() {
  const can = vosu.canWrite;
  $<HTMLButtonElement>('generate').disabled = !can || busy || !current?.beatmap;
  for (const id of ['profile-save', 'profile-save-as', 'profile-delete']) $<HTMLButtonElement>(id).disabled = !can;
}
function refreshAll() {
  refreshPreview();
  refreshTimeline();
}

$<HTMLInputElement>('rate-slider').addEventListener('input', () => {
  field('rate').value = Number($<HTMLInputElement>('rate-slider').value).toFixed(2);
  form.dispatchEvent(new Event('input'));
});
form.addEventListener('input', () => {
  const before = options.rate;
  readForm();
  tempo();
  markDirty();
  refreshPreview();
  if (options.rate !== before) {
    refreshTimeline();
    void loadMap().catch(fail);
  }
});
$('clear-trims').onclick = () => setTrims([]);
$('play').onclick = () => preview.toggle();
// Preview audio starts muted; the choice is remembered (same key shape as Map
// preview: `vosu-tools:<tool id>:muted`, "0" = unmuted).
const MUTE_KEY = 'vosu-tools:practice:muted';
function setMuted(muted: boolean) {
  preview.audio.muted = muted;
  $('mute').setAttribute('aria-pressed', String(muted));
}
setMuted(localStorage.getItem(MUTE_KEY) !== '0');
$('mute').onclick = () => {
  const muted = !preview.audio.muted;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  setMuted(muted);
};
$('cancel').onclick = () => { if (job) void api(`v1/jobs/${job}`, undefined, 'DELETE').catch(fail); };

form.onsubmit = (e) => {
  e.preventDefault();
  if (!vosu.canWrite || busy || !current?.beatmap) return;
  void (async () => {
    busy = true;
    writable();
    say('Starting…');
    try {
      const result = await api<{ job: string }>('v1/generate', outgoing());
      job = result.job;
      $('cancel').hidden = false;
      $('progress').hidden = false;
      for (;;) {
        const state = await api<{ state: string; message: string; progress: number; result: Entry | null }>(`v1/jobs/${job}`);
        $('progress').style.setProperty('--v-value', String(state.progress));
        if (state.state === 'done' && state.result) {
          const path = state.result.files[0]?.path ?? '';
          say(`${state.message} ${path}`);
          const warnings = $('warnings');
          warnings.replaceChildren(...state.result.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
          break;
        }
        say(state.message, state.state === 'failed' ? 'error' : 'info');
        if (['failed', 'cancelled'].includes(state.state)) break;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 250);
        await promise;
      }
    } finally {
      job = null;
      busy = false;
      $('cancel').hidden = true;
      $('progress').hidden = true;
      $('progress').style.setProperty('--v-value', '0');
      writable();
    }
  })().catch(fail);
};

void (async () => {
  writable();
  await vosu.ready;
  const access = $('access');
  access.textContent = vosu.canWrite ? 'Write session' : 'Read only';
  access.classList.toggle('v-badge--ok', vosu.canWrite);
  $('access-help').hidden = vosu.canWrite;
  profiles = await api<Profiles>('v1/profiles');
  applyProfile();
  void skins.useClient();
  await loadMap();
  // Follow the game: reload when the selected beatmap changes. The bridge
  // reconnects by itself and reports its state for the top bar; an error frame
  // (a rejected subscription) is shown as such, not as an unreachable vosu.
  const live = $('live');
  const dot = $('live-dot');
  let rejected: string | null = null,
    dropped = false;
  const show = (state: 'connecting' | 'open' | 'closed') => {
    dot.dataset.state = state === 'open' ? 'ok' : state === 'connecting' ? 'busy' : 'error';
    live.textContent = state === 'open' ? 'Live'
      : state === 'connecting' ? 'Connecting'
      : rejected ? `Subscription rejected (${rejected})` : 'vosu unreachable';
  };
  const follow = new Follow();
  vosu.subscribe(
    SUBSCRIPTION,
    (frame) => {
      const event = follow.read(frame);
      if (!event) return;
      if (event.kind === 'error') {
        rejected = event.message;
        show('closed');
        return;
      }
      rejected = null;
      show('open');
      const game = event.game;
      if (event.map && game.checksum !== (current?.beatmap?.md5 ?? null)) void loadMap().catch(fail);
      if (event.skin) void skins.gameChanged(game.client, game.skinFolder);
    },
    (state) => {
      // After a reconnect the selection or skin may have changed unseen.
      if (state === 'open' && dropped) {
        void loadMap().catch(fail);
        if (skins.state.choice === 'client') void skins.useClient({ force: false });
      }
      dropped = state === 'closed' || (dropped && state === 'connecting');
      if (state === 'open' && rejected) return;
      show(state);
    },
  );
})().catch(fail);
