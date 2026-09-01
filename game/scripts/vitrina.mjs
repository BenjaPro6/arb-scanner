import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium',
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport:{width:900,height:520} });
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:8123/vitrina.html', { waitUntil:'load' });
await p.waitForTimeout(2500);
const n = +(process.argv[3] ?? 0);
await p.evaluate(i => window.vitrina.focus(i), n);
await p.waitForTimeout(1800);
console.log('modelos:', await p.evaluate(()=>window.vitrina.spots.map(s=>s.k).join(', ')));
await p.screenshot({ path: process.argv[2] });
await b.close();
