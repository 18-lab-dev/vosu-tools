/**
 * Skin image layout on the GPU: pages of one 2D array texture.
 *
 * Images keep their full resolution. They are shelf-packed into pages 4096
 * or 2048 px tall (whichever needs less memory; never beyond the device's
 * `maxTextureDimension2D`), as wide as the widest image needs; more pages are
 * added as needed. An image taller than a page is cut into
 * horizontal bands ("strips") of at most a page's height, each packed like
 * an image of its own; scenes draw one quad per strip and the vertex shader
 * clips each quad to the part of the image it shows. Only images wider than
 * the device limit are scaled down.
 */

/** Device limits the layout depends on (a subset of `GPUSupportedLimits`). */
export interface AtlasLimits {
  maxTextureDimension2D: number;
  maxTextureArrayLayers: number;
}

/** One image to place, in pixels. */
export interface AtlasImage {
  key: string;
  width: number;
  height: number;
}

/** Transparent space around every packed rectangle. */
export const ATLAS_PADDING = 2;
/** Neighbouring rows copied around strips, so filtering never samples the padding. */
export const STRIP_GUTTER = 2;
/**
 * Page heights tried: big images stay whole in 4096 px pages, while 2048 px
 * pages waste less memory on skins with many tall strips. The smaller
 * atlas wins.
 */
const PAGE_SIDES = [4096, 2048];

/** One packed rectangle: a whole image, or one strip of a tall image. */
export interface AtlasPiece {
  page: number;
  /** Interior position and size in the page, in pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The piece's rows of the (possibly scaled) image: [top, bottom). */
  top: number;
  bottom: number;
  /** Rows copied above and below the interior (strip gutters). */
  gutterTop: number;
  gutterBottom: number;
}

export interface AtlasPlacement {
  /** Drawn size: the image's size, scaled down when wider than the device allows. */
  width: number;
  height: number;
  /** Pieces from the image's top to its bottom; more than one for tall images. */
  pieces: AtlasPiece[];
}

export interface AtlasPlan {
  pageWidth: number;
  pageHeight: number;
  pages: number;
  placements: Map<string, AtlasPlacement>;
  /** Images scaled down because they are wider than the device limit. */
  downscaled: string[];
}

/** Packs images into array-texture pages (see the module comment). */
export function planAtlas(
  images: readonly AtlasImage[],
  limits: AtlasLimits,
): AtlasPlan {
  const plans = PAGE_SIDES.map((side) =>
      planPages(images, limits, Math.min(limits.maxTextureDimension2D, side)),
    ),
    bytes = (plan: AtlasPlan) => plan.pages * plan.pageWidth * plan.pageHeight;
  const fitting = plans.filter(
    (plan) => plan.pages <= limits.maxTextureArrayLayers,
  );
  if (!fitting.length)
    throw Error("Skin gameplay atlas exceeds GPU texture capacity");
  return fitting.reduce((best, plan) =>
    bytes(plan) < bytes(best) ? plan : best,
  );
}

function planPages(
  images: readonly AtlasImage[],
  limits: AtlasLimits,
  pageHeight: number,
): AtlasPlan {
  const limit = limits.maxTextureDimension2D,
    edge = 2 * ATLAS_PADDING,
    downscaled: string[] = [];
  const sized = images.map((image) => {
    let width = Math.max(1, Math.ceil(image.width)),
      height = Math.max(1, Math.ceil(image.height));
    if (width + edge > limit) {
      const scale = (limit - edge) / width;
      width = limit - edge;
      height = Math.max(1, Math.round(height * scale));
      downscaled.push(image.key);
    }
    return { key: image.key, width, height };
  });
  // Pages are as wide as the widest image needs, never beyond the device.
  const pageWidth = Math.min(
    limit,
    Math.max(pageHeight, ...sized.map((s) => s.width + edge)),
  );
  // Strip interiors leave room for the padding and both gutters.
  const stripHeight = pageHeight - edge - 2 * STRIP_GUTTER;
  interface Pending {
    key: string;
    width: number;
    piece: AtlasPiece;
    /** Slot height in the page, padding and gutters included. */
    slot: number;
  }
  const pending: Pending[] = [];
  const placements = new Map<string, AtlasPlacement>();
  for (const { key, width, height } of sized) {
    const placement: AtlasPlacement = { width, height, pieces: [] };
    placements.set(key, placement);
    const tall = height + edge > pageHeight;
    for (let top = 0; top < height; top += tall ? stripHeight : height) {
      const bottom = tall ? Math.min(height, top + stripHeight) : height,
        gutterTop = top > 0 ? STRIP_GUTTER : 0,
        gutterBottom = bottom < height ? STRIP_GUTTER : 0;
      const piece: AtlasPiece = {
        page: 0,
        x: 0,
        y: 0,
        width,
        height: bottom - top,
        top,
        bottom,
        gutterTop,
        gutterBottom,
      };
      placement.pieces.push(piece);
      pending.push({
        key,
        width,
        piece,
        slot: piece.height + gutterTop + gutterBottom + edge,
      });
    }
  }
  // Shelf packing, tallest first, onto as many pages as it takes.
  pending.sort((a, b) => b.slot - a.slot || b.width - a.width);
  let page = 0,
    x = 0,
    y = 0,
    shelf = 0;
  for (const item of pending) {
    const span = item.width + edge;
    if (x + span > pageWidth) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (y + item.slot > pageHeight) {
      page++;
      x = 0;
      y = 0;
      shelf = 0;
    }
    item.piece.page = page;
    item.piece.x = x + ATLAS_PADDING;
    item.piece.y = y + ATLAS_PADDING + item.piece.gutterTop;
    x += span;
    shelf = Math.max(shelf, item.slot);
  }
  const pages = pending.length ? page + 1 : 1;
  return { pageWidth, pageHeight, pages, placements, downscaled };
}

/** A strip of an atlas region: its page UVs and the image rows it holds. */
export interface AtlasStrip {
  u: number;
  v: number;
  w: number;
  h: number;
  layer: number;
  /** The strip's rows as fractions of the image height: [a, b]. */
  a: number;
  b: number;
}

/**
 * The part of one strip a quad shows, mirroring the vertex shader. The quad
 * spans `t` in [0, 1] from its top edge to its bottom edge and shows image
 * rows [0, visible] (fractions of the image height; hold bodies show only
 * their start), upside down when `flip`. Returns the quad's `t` range the
 * strip covers and the strip-local texture `v` at both ends, or null when
 * the strip is not visible.
 */
export function stripWindow(
  strip: { a: number; b: number },
  visible: number,
  flip: boolean,
): { t0: number; t1: number; v0: number; v1: number } | null {
  const lo = Math.min(Math.max(strip.a, 0), visible),
    hi = Math.min(Math.max(strip.b, 0), visible);
  if (hi <= lo || visible <= 0) return null;
  const t0 = (flip ? visible - hi : lo) / visible,
    t1 = (flip ? visible - lo : hi) / visible;
  const local = (t: number) =>
    ((flip ? 1 - t : t) * visible - strip.a) / (strip.b - strip.a);
  return { t0, t1, v0: local(t0), v1: local(t1) };
}
