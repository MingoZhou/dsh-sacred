/**
 * Capture README screenshots from the built demo (run `node scripts/build.mjs` first).
 *   assets/tree-zh.webp      the tree with stale branches highlighted
 *   assets/detail-zh.webp    a selected stale branch with its reason
 *   assets/pruned-zh.webp    after pruning: withered branches + the void
 *   assets/tree-en.webp      English UI
 *   assets/tree-dark.webp    dark mode
 * (assets/prune.webp, the animation, comes from scripts/prune-anim.mjs)
 */
import { chromium } from 'playwright'
import sharp from 'sharp'
import { rm } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const url = pathToFileURL(resolve('demo/index.html')).href
await mkdir('assets', { recursive: true })
// SwiftShader gives headless Chromium a WebGL context
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

async function shot(name) {
  await page.waitForTimeout(700)
  const png = await page.screenshot()
  await sharp(png).resize(1600).webp({ quality: 82 }).toFile(`assets/${name}.webp`)
  console.log(`assets/${name}.webp`)
}

await page.goto(url)
await page.waitForSelector('.sac-tl canvas')
await shot('tree-zh')

await page.locator('.sac-side .sac-list li').nth(1).click()
await shot('detail-zh')

await page.click('.sac-close')
await page.click('.sac-prune-btn')
await page.waitForTimeout(3200)
await shot('pruned-zh')

await page.goto(`${url}?lang=en`)
await page.waitForSelector('.sac-tl canvas')
await shot('tree-en')

await page.goto(`${url}?theme=dark`)
await page.waitForSelector('.sac-tl canvas')
await shot('tree-dark')

await browser.close()
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
