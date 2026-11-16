/**
 * Share images, rendered from HTML so CJK text and the logo stay crisp:
 *   assets/social/og-light.png   1280×640  link preview / 知乎 / X card
 *   assets/social/og-dark.png    1280×640
 *   assets/social/xhs-cover.png  1080×1440 小红书 cover (3:4)
 * Also copies og-light to demo/og.png (the og:image of the demo page).
 * Run after `node scripts/screenshot.mjs`.
 */
import { chromium } from 'playwright'
import sharp from 'sharp'
import { copyFile, mkdir, readFile } from 'node:fs/promises'

await mkdir('assets/social', { recursive: true })
const b64 = async (p, type = 'image/webp') => `data:${type};base64,${(await readFile(p)).toString('base64')}`
const logo = { light: await b64('assets/brand/logo-light-512.webp'), dark: await b64('assets/brand/logo-dark-512.webp') }
const shot = { light: await b64('assets/tree-zh.webp'), dark: await b64('assets/tree-dark.webp') }

const FONT = `'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif`
const MONO = `'Courier New', 'Noto Sans Mono CJK SC', ui-monospace, monospace`
const theme = {
  light: { bg: '#ffffff', grid: 'rgba(120,90,20,.07)', ink: '#2b2516', ink2: '#6b5f3c', amber: '#b06f00', line: '#e3d8bd', card: '#fbf8f0', glow: 'none' },
  dark: { bg: '#07080a', grid: 'rgba(255,176,57,.06)', ink: '#efe3bd', ink2: '#a8996c', amber: '#ffb039', line: '#3a2f14', card: '#0d0e0a', glow: '0 0 18px rgba(255,176,57,.45)' },
}

const base = (c) => `
  *{box-sizing:border-box;margin:0}
  body{width:100vw;height:100vh;overflow:hidden;background:
    linear-gradient(${c.grid} 1px,transparent 1px) 0 0/40px 40px,
    linear-gradient(90deg,${c.grid} 1px,transparent 1px) 0 0/40px 40px, ${c.bg};
    color:${c.ink};font-family:${FONT}}
  .mono{font-family:${MONO};letter-spacing:.14em;text-transform:uppercase}
  .amber{color:${c.amber};text-shadow:${c.glow}}
  .shot{border:1px solid ${c.line};border-radius:6px;overflow:hidden;box-shadow:0 30px 60px -30px rgba(0,0,0,.45);background:${c.card}}
  .shot img{display:block;width:100%}
`

const og = (mode) => {
  const c = theme[mode]
  return `<style>${base(c)}
    .wrap{display:flex;height:100%;padding:56px 0 56px 64px;gap:40px;align-items:center}
    .left{width:500px;flex:none}
    .logo{width:150px;height:150px;filter:${mode === 'dark' ? 'drop-shadow(0 0 22px rgba(255,176,57,.4))' : 'drop-shadow(0 10px 18px rgba(120,80,0,.18))'}}
    h1{font-family:${MONO};font-size:64px;font-weight:700;margin:22px 0 6px}
    .tag{font-size:30px;font-weight:700;line-height:1.35}
    .en{font-size:19px;color:${c.ink2};margin-top:14px;line-height:1.5}
    .kicker{font-size:15px;color:${c.ink2};margin-top:26px}
    .right{flex:1;align-self:stretch;display:flex;align-items:center;margin-right:-120px}
    .right .shot{width:900px}
  </style>
  <div class="wrap">
    <div class="left">
      <img class="logo" src="${logo[mode]}">
      <h1 class="amber">dsh-sacred</h1>
      <div class="tag">剪除异常分支，守护神圣时间线</div>
      <div class="en">See what fills your agent's context.<br>Prune what you no longer need. Restore anything.</div>
      <div class="kicker mono">Sacred timeline · for DeepSeek Harness</div>
    </div>
    <div class="right"><div class="shot"><img src="${shot[mode]}"></div></div>
  </div>`
}

const xhs = () => {
  const c = theme.light
  return `<style>${base(c)}
    .wrap{display:flex;flex-direction:column;align-items:center;height:100%;padding:90px 70px 0;text-align:center}
    .logo{width:300px;height:300px;filter:drop-shadow(0 16px 28px rgba(120,80,0,.2))}
    .kicker{font-size:24px;color:${c.ink2};margin-top:34px}
    h1{font-size:76px;font-weight:900;line-height:1.25;margin-top:22px}
    h1 em{font-style:normal;color:${c.amber}}
    .sub{font-size:36px;font-weight:700;margin-top:30px;color:${c.ink}}
    .sub b{color:${c.amber};font-family:${MONO}}
    .shot{width:1180px;margin-top:56px;transform:rotate(-2deg)}
  </style>
  <div class="wrap">
    <img class="logo" src="${logo.light}">
    <div class="kicker mono">Sacred timeline · 上下文裁剪</div>
    <h1>和 AI 聊太久<br>它把我开头说的话<em>忘了</em></h1>
    <div class="sub">所以我做了个插件 <b>dsh-sacred</b></div>
    <div class="shot"><img src="${shot.light}"></div>
  </div>`
}

const browser = await chromium.launch()
async function render(html, w, h, out) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.waitForTimeout(300)
  const png = await page.screenshot()
  await sharp(png).png({ palette: true, quality: 92, compressionLevel: 9 }).toFile(out)
  await page.close()
  console.log(out)
}
await render(og('light'), 1280, 640, 'assets/social/og-light.png')
await render(og('dark'), 1280, 640, 'assets/social/og-dark.png')
await render(xhs(), 1080, 1440, 'assets/social/xhs-cover.png')
await browser.close()
await copyFile('assets/social/og-light.png', 'demo/og.png')
