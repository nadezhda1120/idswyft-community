import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { assessImageQuality, detectCard, homography, preprocessForOcr, warpCard } from '../imagePreprocess.js'

// Synthetic images only: a light "card" with text rows on a darker background.

const CARD_W = 856, CARD_H = 540

function cardSvg(): Buffer {
  const rows = Array.from({ length: 7 }, (_, i) =>
    `<text x="300" y="${110 + i * 55}" font-size="34" font-family="sans-serif" fill="#222">ИВАНОВА IVANOVA 01.08.1995</text>`).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">
    <rect width="100%" height="100%" rx="30" fill="#f2efe6"/>
    <rect x="40" y="90" width="220" height="290" fill="#9aa"/>${rows}</svg>`)
}

/** The card rotated by `angle` degrees and placed on a dark 1600×1200 background. */
async function photo(angle: number, background = '#3a3d42'): Promise<Buffer> {
  const card = await sharp(cardSvg()).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  return sharp({ create: { width: 1600, height: 1200, channels: 3, background } })
    .composite([{ input: card, gravity: 'centre' }])
    .jpeg({ quality: 92 })
    .toBuffer()
}

describe('homography', () => {
  it('maps the four source corners onto the destination corners', () => {
    const from = [{ x: 0, y: 0 }, { x: 99, y: 0 }, { x: 99, y: 49 }, { x: 0, y: 49 }]
    const to = [{ x: 10, y: 5 }, { x: 120, y: 15 }, { x: 115, y: 70 }, { x: 5, y: 60 }]
    const H = homography(from, to)
    for (let i = 0; i < 4; i++) {
      const { x, y } = from[i]
      const d = H[6] * x + H[7] * y + H[8]
      expect((H[0] * x + H[1] * y + H[2]) / d).toBeCloseTo(to[i].x, 6)
      expect((H[3] * x + H[4] * y + H[5]) / d).toBeCloseTo(to[i].y, 6)
    }
  })
})

describe('detectCard + warpCard', () => {
  it('finds a card photographed at an angle and flattens it to ID-1 proportions', async () => {
    const img = await photo(12)
    const corners = await detectCard(img)
    expect(corners).not.toBeNull()
    const flat = await warpCard(img, corners!)
    const meta = await sharp(flat).metadata()
    const aspect = meta.width! / meta.height!
    expect(aspect).toBeGreaterThan(1.45)
    expect(aspect).toBeLessThan(1.72)
    expect(meta.width!).toBeGreaterThan(CARD_W * 0.9)
  })

  it('leaves a full-frame scan alone, also when it is dark', async () => {
    const scan = await sharp(cardSvg()).png().toBuffer()
    expect(await detectCard(scan)).toBeNull()
    const dark = await sharp(cardSvg()).linear(0.45, 0).png().toBuffer()
    expect(await detectCard(dark)).toBeNull()
  })

  it('does not stretch contrast or equalise a clean card', async () => {
    const out = await preprocessForOcr(await sharp(cardSvg()).png().toBuffer())
    expect(out.steps).not.toContain('contrast_stretched')
    expect(out.steps).not.toContain('lighting_equalised')
    expect(out.steps).not.toContain('card_cropped_and_unwarped')
  })
})

describe('assessImageQuality', () => {
  it('flags blur, darkness and low resolution', async () => {
    const sharpCard = await sharp(cardSvg()).png().toBuffer()
    const good = await assessImageQuality(sharpCard)
    expect(good.issues).not.toContain('blurry')

    const blurred = await sharp(cardSvg()).blur(6).png().toBuffer()
    expect((await assessImageQuality(blurred)).issues).toContain('blurry')

    const dark = await sharp(cardSvg()).linear(0.2, 0).png().toBuffer()
    expect((await assessImageQuality(dark)).issues).toContain('too_dark')

    const tiny = await sharp(cardSvg()).resize(300).png().toBuffer()
    expect((await assessImageQuality(tiny)).issues).toContain('low_resolution')
  })

  it('flags glare', async () => {
    const glare = await sharp(cardSvg())
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}"><ellipse cx="500" cy="250" rx="200" ry="120" fill="#fff"/></svg>`) }])
      .png().toBuffer()
    expect((await assessImageQuality(glare)).issues).toContain('glare')
  })
})

describe('preprocessForOcr', () => {
  it('crops, upscales and normalises a small, dark, angled photo', async () => {
    const small = await sharp(await photo(8, '#202225')).resize(800).linear(0.5, 0).jpeg().toBuffer()
    const out = await preprocessForOcr(small)
    expect(out.steps).toContain('card_cropped_and_unwarped')
    expect(out.steps.some(s => s.startsWith('upscaled'))).toBe(true)
    expect(out.card_corners).toHaveLength(4)
    const meta = await sharp(out.buffer).metadata()
    // The crop is ~265 px tall: upscaled toward 350 px.
    expect(Math.min(meta.width!, meta.height!)).toBeGreaterThan(340)
    expect(out.steps).toContain('contrast_stretched')
  })

  it('passes the upload through when disabled', async () => {
    const img = await photo(0)
    const out = await preprocessForOcr(img, {
      enabled: false, crop: true, enhance: 'auto', minShortSide: 350, blurMin: 40, glareMax: 0.12,
    })
    expect(out.steps).toEqual([])
    expect(out.card_corners).toBeNull()
  })
})
