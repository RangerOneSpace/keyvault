// Draws the Ranger One artwork used in README.md (banner, chapter headers, footer)
// into docs/brand/. Run from the repo root after `npm install`:
//   node scripts/readme-art.mjs
// Fonts: Inter and JetBrains Mono, the Ranger One brand faces (SIL Open Font Licence), embedded
// only while drawing; nothing here ships inside KeyVault itself.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const F = p => `data:font/woff2;base64,${fs.readFileSync(`node_modules/@fontsource/${p}`).toString('base64')}`;
const R = [[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0],[1,0,1,0,0],[1,0,0,1,0],[1,0,0,0,1]];
const ONE = [[0,1,0],[1,1,0],[0,1,0],[0,1,0],[0,1,0],[0,1,0],[1,1,1]];
const grid = (m, c, px, gap) => `<div class="g" style="grid-template-columns:repeat(${m[0].length},${px}px);gap:${gap}px">${m.flat().map(v => `<i style="width:${px}px;height:${px}px;background:${v ? c : c === '#F8FAFC' ? 'rgba(248,250,252,.07)' : 'rgba(0,116,217,.12)'}"></i>`).join('')}</div>`;
const mark = (px, gap) => `<div class="r1">${grid(R, '#F8FAFC', px, gap)}${grid(ONE, '#0074D9', px, gap)}</div>`;
// a pixel key, for the right side of the banner
const KEY = [
 '0011111100000000000000','0110000110000000000000','1100000011000000000000','1100110011111111111111','1100110011111111111111',
 '1100000011000000110011','0110000110000000110011','0011111100000000000000'];
const key = (px, gap) => `<div class="g" style="grid-template-columns:repeat(${KEY[0].length},${px}px);gap:${gap}px">${KEY.join('').split('').map((v,i) => `<i style="width:${px}px;height:${px}px;background:${v==='1' ? (i%22<10 ? '#F8FAFC' : '#0074D9') : 'transparent'}"></i>`).join('')}</div>`;
const css = `
@font-face{font-family:Inter;font-weight:800;src:url(${F('inter/files/inter-latin-800-normal.woff2')})}
@font-face{font-family:Inter;font-weight:900;src:url(${F('inter/files/inter-latin-900-normal.woff2')})}
@font-face{font-family:JB;font-weight:400;src:url(${F('jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2')})}
@font-face{font-family:JB;font-weight:700;src:url(${F('jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2')})}
*{margin:0;box-sizing:border-box}
body{background:#001F3F}
.frame{position:relative;overflow:hidden;background-color:#001F3F;
 background-image:linear-gradient(rgba(0,116,217,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(0,116,217,.07) 1px,transparent 1px),radial-gradient(900px 400px at 85% 20%,rgba(0,116,217,.28),transparent 60%);
 background-size:32px 32px,32px 32px,auto;color:#F8FAFC;font-family:JB}
.frame::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(transparent 0 3px,rgba(0,0,0,.12) 3px 4px);pointer-events:none}
.r1{display:flex;gap:10px}.g{display:grid}
.corner{position:absolute;width:26px;height:26px;border-color:#0074D9;border-style:solid}
.tl{top:22px;left:22px;border-width:3px 0 0 3px}.br{bottom:22px;right:22px;border-width:0 3px 3px 0}
.tr{top:22px;right:22px;border-width:3px 3px 0 0}.bl{bottom:22px;left:22px;border-width:0 0 3px 3px}
.word{font-family:Inter;font-weight:900;text-transform:uppercase;letter-spacing:.02em;line-height:1}
.sub{color:#0074D9;font-weight:700;text-transform:uppercase;letter-spacing:.32em}
.cur{display:inline-block;width:.75em;height:.95em;background:#0074D9;vertical-align:-2px;margin-left:8px}
.div{width:2px;background:rgba(0,116,217,.6);align-self:stretch}
.tag{color:#9fb3cc}.tag b{color:#0074D9}
.chips{display:flex;gap:12px;flex-wrap:wrap}.chip{border:1px solid rgba(0,116,217,.55);padding:6px 12px;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#F8FAFC;background:rgba(0,23,47,.6)}
.chip.ok{border-color:rgba(61,220,151,.6);color:#3DDC97}
`;
const banner = `<div class="frame" style="width:1280px;height:420px;padding:70px 80px">
<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
<div style="display:flex;align-items:center;gap:34px">${mark(13,3)}<div class="div"></div>
<div><div class="word" style="font-size:82px">KeyVault</div><div class="sub" style="font-size:18px;margin-top:14px">A Ranger One product<span class="cur"></span></div></div></div>
<p class="tag" style="font-size:22px;margin-top:44px"><b>&gt;</b> secure key infrastructure for teams that ship with AI</p>
<div class="chips" style="margin-top:26px"><span class="chip ok">■ Local only</span><span class="chip">AES-256-GCM</span><span class="chip">MCP for AI tools</span><span class="chip">Docker + ports</span><span class="chip">Zero dependencies</span></div>
<div style="position:absolute;right:80px;top:96px;opacity:.95">${key(11,3)}</div>
</div>`;
const footer = `<div class="frame" style="width:1280px;height:170px;padding:44px 80px;display:flex;align-items:center;justify-content:space-between">
<span class="corner tl"></span><span class="corner br"></span>
<div style="display:flex;align-items:center;gap:26px">${mark(7,2)}<div class="div"></div><div><div class="word" style="font-size:34px">Ranger One</div><div class="sub" style="font-size:12px;margin-top:8px">Agency infrastructure</div></div></div>
<div style="text-align:right;font-size:16px;line-height:1.9;color:#9fb3cc"><div><b style="color:#F8FAFC">rangerone.io</b></div><div>support@rangerone.io</div><div style="color:#0074D9">MIT licence · part of Straun Group</div></div>
</div>`;
const section = (n, t) => `<div class="frame" style="width:1280px;height:84px;padding:0 40px;display:flex;align-items:center;gap:22px;border-left:6px solid #0074D9">
<span style="font:700 20px JB;color:#0074D9;letter-spacing:.2em">${n}</span><span class="div" style="height:34px;align-self:center"></span>
<span class="word" style="font-size:34px">${t}</span><span style="flex:1;height:2px;background:repeating-linear-gradient(90deg,rgba(0,116,217,.6) 0 8px,transparent 8px 14px);margin-left:14px"></span>
<span style="font:700 14px JB;color:#9fb3cc;letter-spacing:.28em">KEYVAULT MANUAL</span></div>`;
const SECTIONS = [['01', 'Install', 's01'], ['02', 'First run', 's02'], ['03', 'Everyday use', 's03'], ['04', 'Projects', 's04'],
  ['05', 'Apps', 's05'], ['06', 'Services', 's06'], ['07', 'Connect your AI', 's07'], ['08', 'Backups', 's08'],
  ['09', 'How it works', 's09'], ['10', 'Reference', 's10'], ['11', 'Troubleshooting', 's11'], ['12', 'Contribute', 's12']];
const b = await chromium.launch();
const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 1280, height: 420 } });
const shot = async (html, file, h) => {
  await p.setViewportSize({ width: 1280, height: h });
  await p.setContent(`<!doctype html><style>${css}</style>${html}`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(150);
  await p.screenshot({ path: file, clip: { x: 0, y: 0, width: 1280, height: h } });
};
fs.mkdirSync('docs/brand', { recursive: true });
await shot(banner, 'docs/brand/banner.png', 420);
await shot(footer, 'docs/brand/footer.png', 170);
for (const [n, t, f] of SECTIONS) await shot(section(n, t), `docs/brand/${f}.png`, 84);
await b.close();
