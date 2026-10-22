import { parseSkinIni } from "@vosu-tools/osu-parse";
export interface Skin {
  name: string;
  assets: Map<string, ImageBitmap>;
  sections: Map<string, Record<string, string>[]>;
}
export interface AtlasRegion {
  u: number;
  v: number;
  w: number;
  h: number;
}
export const assetNames = [
  "hitcircle",
  "hitcircleoverlay",
  "approachcircle",
  "sliderb0",
  "sliderfollowcircle",
  "reversearrow",
  "sliderscorepoint",
  "spinner-circle",
  "spinner-approachcircle",
  "cursor",
  "taikohitcircle",
  "taikohitcircleoverlay",
  "taiko-drum-inner",
  "taiko-drum-outer",
  "taikobigcircle",
  "taikobigcircleoverlay",
  "fruit-apple",
  "fruit-grapes",
  "fruit-orange",
  "fruit-drop",
  "fruit-pear",
  "fruit-bananas",
  "fruit-catcher-idle",
  "mania-note1",
  "mania-note2",
  "mania-noteS",
  "mania-note1H",
  "mania-note2H",
  "mania-noteSH",
  "mania-note1L",
  "mania-note2L",
  "mania-noteSL",
  "mania-note1T",
  "mania-note2T",
  "mania-noteST",
  "mania-key1",
  "mania-key2",
  "mania-keyS",
  "mania-key1D",
  "mania-key2D",
  "mania-keySD",
  ...Array.from({ length: 10 }, (_, i) => `default-${i}`),
];
/** The resolver supplies either client-current assets or user-selected folder files. */
export async function loadSkin(
  resolve: (file: string) => Promise<Blob | null>,
  name = "Client skin",
): Promise<Skin> {
  const skin: Skin = { name, assets: new Map(), sections: new Map() };
  const ini = await resolve("skin.ini");
  if (ini) skin.sections = parseSkinIni(await ini.text());
  const names = new Set(assetNames);
  for (const section of skin.sections.get("Mania") ?? [])
    for (const [key, value] of Object.entries(section))
      if (/^(NoteImage|KeyImage)/.test(key)) names.add(value);
  const prefix = skin.sections.get("Fonts")?.[0]?.HitCirclePrefix ?? "default";
  for (let i = 0; i < 10; i++) names.add(`${prefix}-${i}`);
  await Promise.all(
    [...names].map(async (key) => {
      for (const suffix of ["@2x.png", ".png"]) {
        const data = await resolve(key + suffix);
        if (!data) continue;
        try {
          skin.assets.set(key, await createImageBitmap(data));
          return;
        } catch {
          /* A corrupt skin element falls back independently. */
        }
      }
    }),
  );
  return skin;
}
/** Fixed shelf atlas, built once; no texture switches during a frame. */
export function buildAtlas(
  device: GPUDevice,
  skin?: Skin,
): { texture: GPUTexture; regions: Map<string, AtlasRegion> } {
  const size = Math.min(4096, device.limits.maxTextureDimension2D),
    canvas = new OffscreenCanvas(size, size),
    ctx = canvas.getContext("2d")!;
  const regions = new Map<string, AtlasRegion>();
  let x = 2,
    y = 2,
    row = 0;
  const add = (
    name: string,
    image: CanvasImageSource,
    w: number,
    h: number,
  ) => {
    const scale = Math.min(1, 512 / w, 512 / h);
    w = Math.max(1, Math.ceil(w * scale));
    h = Math.max(1, Math.ceil(h * scale));
    if (x + w + 2 > size) {
      x = 2;
      y += row + 4;
      row = 0;
    }
    if (y + h + 2 > size)
      throw new Error("Skin atlas exceeds GPU texture limit");
    ctx.drawImage(image, x, y, w, h);
    regions.set(name, { u: x / size, v: y / size, w: w / size, h: h / size });
    x += w + 4;
    row = Math.max(row, h);
  };
  if (skin)
    for (const [name, image] of skin.assets)
      add(name, image, image.width, image.height);
  for (let i = 0; i < 10; i++)
    if (!regions.has(`default-${i}`)) {
      const digit = new OffscreenCanvas(64, 80),
        c = digit.getContext("2d")!;
      c.fillStyle = "#fff";
      c.font = "bold 64px sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(i), 32, 42);
      add(`default-${i}`, digit, 64, 80);
    }
  const texture = device.createTexture({
    size: [size, size],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: canvas },
    { texture, premultipliedAlpha: false },
    [size, size],
  );
  return { texture, regions };
}
