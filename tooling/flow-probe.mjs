// Dev utility: how freely traffic flows at several fleet sizes in one city.
// Needs the dev server (window.__mapScene). For each count it loads /map, lets queues form
// for 30 s, then reports mean speed and the share of stopped (< 0.5 m/s) and crawling
// (< 3 m/s) vehicles, read straight from the shared vehicle buffer.
//   node tooling/flow-probe.mjs <city> <count> [count ...]       e.g. london 100000 1000000
// Set BASE to target another server (default http://localhost:5175).
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:5175";
const [city, ...counts] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const n of counts) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  await page.goto(`${BASE}/?city=${city}&vehicles=${n}`, { waitUntil: "load" });
  await page.waitForFunction(() => (window.__mapScene?.lastStats?.snapshots ?? 0) > 5, null, {
    timeout: 240000,
    polling: 250,
  });
  await page.waitForTimeout(30000); // let queues form
  const s = await page.evaluate(() => {
    const b = window.__mapScene.buffer;
    let sum = 0,
      stopped = 0,
      slow = 0;
    for (let i = 0; i < b.count; i++) {
      const v = b.speed[i];
      sum += v;
      if (v < 0.5) stopped++;
      else if (v < 3) slow++;
    }
    return { mean: (sum / b.count) * 3.6, stopped: (100 * stopped) / b.count, slow: (100 * slow) / b.count };
  });
  console.log(
    `${city} ${String(n).padStart(8)}: mean ${s.mean.toFixed(1)} km/h, stopped ${s.stopped.toFixed(1)} %, crawling ${s.slow.toFixed(1)} %`,
  );
  await page.close();
}
await browser.close();
