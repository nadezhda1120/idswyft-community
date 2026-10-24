/**
 * Image preprocessing and quality checks before OCR.
 *
 * Photos of identity cards arrive rotated, at an angle, small, unevenly lit or
 * with glare. This module, before recognition:
 *   1. applies the EXIF orientation;
 *   2. finds the card in the photo and crops it with perspective correction;
 *   3. upscales small images so text is tall enough for the recogniser;
 *   4. evens out lighting and contrast (CLAHE) when the quality check says so;
 *   5. reports blur, glare, brightness, contrast and resolution problems.
 * Coarse orientation (90° / 180°) is handled by the caller's orientation retry,
 * and small skew by the detector's own deskew (OCR_DET_AUTO_DESKEW).
 *
 * Everything is deterministic: fixed thresholds, no learned models. The quality
 * report is information for the caller — it never rejects a document by itself.
 *
 * Environment (all optional):
 *   OCR_PREPROCESS=false            skip preprocessing entirely (OCR gets the upload as is)
 *   OCR_PREPROCESS_CROP=false       don't detect / crop / unwarp the card
 *   OCR_PREPROCESS_ENHANCE=auto     auto (when quality needs it) | always | never
 *   OCR_PREPROCESS_MIN_SHORT_SIDE   upscale until the short side is at least this, px (default 640)
 *   OCR_QUALITY_BLUR_MIN            sharpness (Laplacian variance) below this is "blurry" (default 40)
 *   OCR_QUALITY_GLARE_MAX           share of saturated pixels above this is "glare" (default 0.12;
 *                                   card security print is light, so lower values flag clean scans)
 */

import sharp from 'sharp';

export type QualityIssue =
  | 'low_resolution' | 'blurry' | 'glare' | 'too_dark' | 'too_bright' | 'low_contrast' | 'uneven_lighting';

export interface ImageQuality {
  width: number;
  height: number;
  /** Variance of the Laplacian on a 1000 px grey copy: higher is sharper. */
  sharpness: number;
  /** Mean grey level, 0–255. */
  brightness: number;
  /** Standard deviation of the grey level. */
  contrast: number;
  /** Share of pixels at or above 250 (specular highlights). */
  glare_ratio: number;
  /** Max − min mean brightness over a 4×4 grid, 0–1. */
  lighting_unevenness: number;
  issues: QualityIssue[];
}

export interface Point { x: number; y: number }

export interface PreprocessResult {
  /** Image to give the OCR. */
  buffer: Buffer;
  /** Upload with only the EXIF orientation applied: use it for face and tamper analysis. */
  original: Buffer;
  steps: string[];
  /** Card corners in the EXIF-oriented upload (TL, TR, BR, BL), when the card was found. */
  card_corners: Point[] | null;
  quality: ImageQuality;
}

interface PreprocessConfig {
  enabled: boolean;
  crop: boolean;
  enhance: 'auto' | 'always' | 'never';
  minShortSide: number;
  blurMin: number;
  glareMax: number;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) ? n : fallback;
}

export function readPreprocessConfig(): PreprocessConfig {
  const enhance = process.env.OCR_PREPROCESS_ENHANCE;
  return {
    enabled: process.env.OCR_PREPROCESS !== 'false',
    crop: process.env.OCR_PREPROCESS_CROP !== 'false',
    enhance: enhance === 'always' || enhance === 'never' ? enhance : 'auto',
    minShortSide: envNumber('OCR_PREPROCESS_MIN_SHORT_SIDE', 640),
    blurMin: envNumber('OCR_QUALITY_BLUR_MIN', 40),
    glareMax: envNumber('OCR_QUALITY_GLARE_MAX', 0.12),
  };
}

/** Longest side the warp works at: plenty for OCR, bounded for speed. */
const MAX_WORK_SIDE = 3000;
/** ID-1 cards (ID cards, licences) are 85.60 × 53.98 mm. */
const ID1_ASPECT = 85.6 / 53.98;

// ── Quality ───────────────────────────────────────────────────

async function greyRaw(input: Buffer, maxSide: number): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(input)
    .greyscale()
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

export async function assessImageQuality(input: Buffer, config = readPreprocessConfig()): Promise<ImageQuality> {
  const meta = await sharp(input).metadata();
  const { data, width, height } = await greyRaw(input, 1000);

  let sum = 0, sumSq = 0, saturated = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sum += v; sumSq += v * v;
    if (v >= 250) saturated++;
  }
  const n = data.length || 1;
  const brightness = sum / n;
  const contrast = Math.sqrt(Math.max(0, sumSq / n - brightness * brightness));

  // Laplacian variance (4-neighbour kernel)
  let lSum = 0, lSq = 0, lN = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = data[i - width] + data[i + width] + data[i - 1] + data[i + 1] - 4 * data[i];
      lSum += lap; lSq += lap * lap; lN++;
    }
  }
  const lMean = lN ? lSum / lN : 0;
  const sharpness = lN ? lSq / lN - lMean * lMean : 0;

  // Lighting: mean brightness per cell of a 4×4 grid
  const cells: number[] = [];
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      let s = 0, c = 0;
      for (let y = Math.floor(gy * height / 4); y < Math.floor((gy + 1) * height / 4); y++) {
        for (let x = Math.floor(gx * width / 4); x < Math.floor((gx + 1) * width / 4); x++) { s += data[y * width + x]; c++; }
      }
      if (c) cells.push(s / c);
    }
  }
  const lighting_unevenness = cells.length ? (Math.max(...cells) - Math.min(...cells)) / 255 : 0;

  const w = meta.autoOrient?.width ?? meta.width ?? width;
  const h = meta.autoOrient?.height ?? meta.height ?? height;
  const issues: QualityIssue[] = [];
  if (Math.min(w, h) < 500) issues.push('low_resolution');
  if (sharpness < config.blurMin) issues.push('blurry');
  if (saturated / n > config.glareMax) issues.push('glare');
  if (brightness < 70) issues.push('too_dark');
  if (brightness > 225) issues.push('too_bright');
  if (contrast < 35) issues.push('low_contrast');
  if (lighting_unevenness > 0.45) issues.push('uneven_lighting');

  const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    width: w, height: h,
    sharpness: round(sharpness), brightness: round(brightness), contrast: round(contrast),
    glare_ratio: round(saturated / n, 4), lighting_unevenness: round(lighting_unevenness, 3),
    issues,
  };
}

// ── Card detection ────────────────────────────────────────────

function otsu(data: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (const v of data) hist[v]++;
  const total = data.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/** Largest 4-connected component of `mask`, as pixel indices. */
function largestComponent(mask: Uint8Array, width: number, height: number): number[] {
  const seen = new Uint8Array(mask.length);
  let best: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const comp: number[] = [];
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % width, y = (i - x) / width;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - width] && !seen[i - width]) { seen[i - width] = 1; stack.push(i - width); }
      if (y < height - 1 && mask[i + width] && !seen[i + width]) { seen[i + width] = 1; stack.push(i + width); }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function quadArea(q: Point[]): number {
  let s = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}

/**
 * Find the card as the largest bright-or-dark region that is quadrilateral and
 * card-shaped. Corners are the region's extreme points along the diagonals.
 * Returns null when nothing card-like is found or the card already fills the
 * frame (a scan) — the image is then used as is.
 */
export async function detectCard(input: Buffer): Promise<Point[] | null> {
  const meta = await sharp(input).metadata();
  const fullW = meta.width ?? 0, fullH = meta.height ?? 0;
  if (!fullW || !fullH) return null;

  const { data: raw, info } = await sharp(input)
    .greyscale()
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .blur(1.5)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
  const { width, height } = info;
  const t = otsu(data);
  const imageArea = width * height;

  let best: { quad: Point[]; score: number } | null = null;
  for (const bright of [true, false]) {
    const mask = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) mask[i] = (bright ? data[i] > t : data[i] <= t) ? 1 : 0;
    const comp = largestComponent(mask, width, height);
    if (comp.length < imageArea * 0.15 || comp.length > imageArea * 0.92) continue;

    let tl = { x: 0, y: 0, v: Infinity }, br = { x: 0, y: 0, v: -Infinity };
    let tr = { x: 0, y: 0, v: -Infinity }, bl = { x: 0, y: 0, v: Infinity };
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (const i of comp) {
      const x = i % width, y = (i - x) / width;
      if (x + y < tl.v) tl = { x, y, v: x + y };
      if (x + y > br.v) br = { x, y, v: x + y };
      if (x - y > tr.v) tr = { x, y, v: x - y };
      if (x - y < bl.v) bl = { x, y, v: x - y };
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    // A region touching all four borders is the background, not a card.
    if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) continue;

    const quad = [tl, tr, br, bl].map(p => ({ x: p.x, y: p.y }));
    const area = quadArea(quad);
    // Only crop when there is clearly background around the card.
    if (area < imageArea * 0.15 || area > imageArea * 0.85) continue;

    // The card must stand out from what surrounds it, or the "region" is just a
    // dark or light part of a full-frame card (e.g. a dark photo of a scan).
    let inSum = 0, outSum = 0;
    const inMask = new Uint8Array(data.length);
    for (const i of comp) { inMask[i] = 1; inSum += data[i]; }
    for (let i = 0; i < data.length; i++) if (!inMask[i]) outSum += data[i];
    const contrast = Math.abs(inSum / comp.length - outSum / Math.max(1, data.length - comp.length));
    if (contrast < 40) continue;
    const fill = comp.length / area;                // ≈ 1 for a solid quadrilateral
    const w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
    const h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
    const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
    if (fill < 0.88 || fill > 1.12 || aspect < 1.4 || aspect > 1.8) continue;

    const score = (1 - Math.abs(1 - fill)) - Math.abs(aspect - ID1_ASPECT) / ID1_ASPECT;
    if (!best || score > best.score) best = { quad, score };
  }
  if (!best) return null;

  // Back to full resolution, pushed out by 1% so the card edge isn't clipped.
  const sx = fullW / width, sy = fullH / height;
  const cx = best.quad.reduce((s, p) => s + p.x, 0) / 4, cy = best.quad.reduce((s, p) => s + p.y, 0) / 4;
  return best.quad.map(p => ({
    x: Math.min(fullW - 1, Math.max(0, (cx + (p.x - cx) * 1.01) * sx)),
    y: Math.min(fullH - 1, Math.max(0, (cy + (p.y - cy) * 1.01) * sy)),
  }));
}

// ── Perspective correction ────────────────────────────────────

/** Homography mapping each `from` point onto the matching `to` point (4 pairs). */
export function homography(from: Point[], to: Point[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}

/** Warp the quadrilateral `corners` (TL, TR, BR, BL) of `input` to a flat rectangle. */
export async function warpCard(input: Buffer, corners: Point[]): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const scale = Math.min(1, MAX_WORK_SIDE / Math.max(meta.width ?? 1, meta.height ?? 1));
  const { data, info } = await sharp(input)
    .resize(Math.round((meta.width ?? 1) * scale), Math.round((meta.height ?? 1) * scale))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const src = corners.map(p => ({ x: p.x * scale, y: p.y * scale }));
  const outW = Math.round((dist(src[0], src[1]) + dist(src[3], src[2])) / 2);
  const outH = Math.round((dist(src[0], src[3]) + dist(src[1], src[2])) / 2);
  const dst = [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }];
  const H = homography(dst, src); // output pixel → source pixel

  const ch = info.channels, sw = info.width, shh = info.height;
  const out = Buffer.alloc(outW * outH * ch);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const d = H[6] * x + H[7] * y + H[8];
      const u = (H[0] * x + H[1] * y + H[2]) / d;
      const v = (H[3] * x + H[4] * y + H[5]) / d;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(u))), y0 = Math.max(0, Math.min(shh - 2, Math.floor(v)));
      const fx = Math.max(0, Math.min(1, u - x0)), fy = Math.max(0, Math.min(1, v - y0));
      const o = (y * outW + x) * ch;
      for (let c = 0; c < ch; c++) {
        const i00 = (y0 * sw + x0) * ch + c;
        const top = data[i00] * (1 - fx) + data[i00 + ch] * fx;
        const bottom = data[i00 + sw * ch] * (1 - fx) + data[i00 + sw * ch + ch] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return sharp(out, { raw: { width: outW, height: outH, channels: ch } }).png().toBuffer();
}

// ── Pipeline ──────────────────────────────────────────────────

export async function preprocessForOcr(upload: Buffer, config = readPreprocessConfig()): Promise<PreprocessResult> {
  let original = upload;
  try { original = await sharp(upload).rotate().toBuffer(); } catch { /* not decodable by sharp: pass through */ }

  const steps: string[] = [];
  const qualityOf = (b: Buffer) => assessImageQuality(b, config).catch((): ImageQuality => ({
    width: 0, height: 0, sharpness: 0, brightness: 0, contrast: 0, glare_ratio: 0, lighting_unevenness: 0, issues: [],
  }));
  if (!config.enabled) return { buffer: original, original, steps, card_corners: null, quality: await qualityOf(original) };

  let buffer = original;
  let corners: Point[] | null = null;
  if (config.crop) {
    try {
      corners = await detectCard(original);
      if (corners) { buffer = await warpCard(original, corners); steps.push('card_cropped_and_unwarped'); }
    } catch { corners = null; }
  }

  // Quality of the card itself (after cropping), so background doesn't skew it.
  const quality = await qualityOf(buffer);

  const meta = await sharp(buffer).metadata();
  const shortSide = Math.min(meta.width ?? 0, meta.height ?? 0);
  if (shortSide > 0 && shortSide < config.minShortSide) {
    const factor = Math.min(2, config.minShortSide / shortSide);
    buffer = await sharp(buffer)
      .resize(Math.round((meta.width ?? 0) * factor), Math.round((meta.height ?? 0) * factor), { kernel: 'lanczos3' })
      .png().toBuffer();
    steps.push(`upscaled_x${factor.toFixed(2)}`);
  }

  // Lighting, chosen per problem (glare alone triggers nothing: equalising a
  // clean card's light security print hurt recognition in testing):
  //   dark / flat image  → global contrast stretch (percentile normalise)
  //   uneven lighting    → gentle local equalisation (CLAHE)
  const always = config.enhance === 'always';
  const auto = config.enhance === 'auto';
  if (always || (auto && quality.issues.some(i => i === 'too_dark' || i === 'too_bright' || i === 'low_contrast'))) {
    buffer = await sharp(buffer).normalise({ lower: 1, upper: 99 }).png().toBuffer();
    steps.push('contrast_stretched');
  }
  if (always || (auto && quality.issues.includes('uneven_lighting'))) {
    const m = await sharp(buffer).metadata();
    buffer = await sharp(buffer)
      .clahe({ width: Math.max(8, Math.round((m.width ?? 800) / 6)), height: Math.max(8, Math.round((m.height ?? 500) / 6)), maxSlope: 2 })
      .png().toBuffer();
    steps.push('lighting_equalised');
  }
  if (config.enhance !== 'never' && quality.issues.includes('blurry')) {
    buffer = await sharp(buffer).sharpen({ sigma: 1 }).png().toBuffer();
    steps.push('sharpened');
  }

  return { buffer, original, steps, card_corners: corners, quality };
}
