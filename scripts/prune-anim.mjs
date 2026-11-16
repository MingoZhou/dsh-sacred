/** Record the prune animation as an animated webp for the README (assets/prune.webp). */
import { chromium } from 'playwright'
import sharp from 'sharp'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const url = pathToFileURL(resolve('demo/index.html')).href
// SwiftShader gives headless Chromium a WebGL context
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
await page.goto(url)
await page.waitForSelector('.sac-tl canvas')
await page.waitForTimeout(800)
const frames = []
const grab = async () => frames.push(await page.screenshot({ type: 'png' }))
for (let i = 0; i < 8; i++) { await grab(); await page.waitForTimeout(80) }
await page.click('.sac-prune-btn')
for (let i = 0; i < 26; i++) { await grab(); await page.waitForTimeout(70) }
for (let i = 0; i < 12; i++) { await grab(); await page.waitForTimeout(120) }
await browser.close()
const resized = await Promise.all(frames.map((f) => sharp(f).resize(960).png().toBuffer()))
await sharp(resized, { join: { animated: true } })
  .webp({ quality: 70, delay: frames.map((_, i) => (i < 8 ? 90 : i < 34 ? 70 : i === frames.length - 1 ? 2500 : 120)), loop: 0 })
  .toFile('assets/prune.webp')
console.log(`assets/prune.webp (${frames.length} frames)`)
