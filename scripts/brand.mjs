/**
 * Brand assets from the two 1920px source logos (kept out of the repo):
 *   node scripts/brand.mjs <dark.png> <light.png>
 * Produces circle-masked transparent images in assets/brand/ and the demo favicon.
 */
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'

const [dark, light] = process.argv.slice(2)
if (!dark || !light) { console.error('usage: node scripts/brand.mjs <dark.png> <light.png>'); process.exit(1) }
await mkdir('assets/brand', { recursive: true })
await mkdir('demo/brand', { recursive: true })

/** Keep the ring and its glow, drop the square background corners. */
async function circle(src, size) {
  const r = size * 0.497
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><defs><radialGradient id="g"><stop offset="97%" stop-color="#fff"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="url(#g)"/></svg>`)
  return sharp(src).resize(size, size, { kernel: 'lanczos3' }).ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
}

for (const [name, src] of [['dark', dark], ['light', light]]) {
  for (const size of [512, 256, 96]) {
    const buf = await circle(src, size)
    await sharp(buf).webp({ quality: 86, alphaQuality: 90 }).toFile(`assets/brand/logo-${name}-${size}.webp`)
  }
  await sharp(await circle(src, 256)).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(`assets/brand/logo-${name}-256.png`)
  await sharp(await circle(src, 96)).webp({ quality: 86 }).toFile(`demo/brand/logo-${name}-96.webp`)
}
await sharp(await circle(light, 64)).png({ compressionLevel: 9 }).toFile('demo/brand/favicon-64.png')
await sharp(await circle(dark, 180)).flatten({ background: '#07080a' }).png({ compressionLevel: 9 }).toFile('demo/brand/apple-touch-icon.png')
console.log('brand assets written')
