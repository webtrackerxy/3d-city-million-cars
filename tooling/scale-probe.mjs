// Dev utility: cost of the vehicle pipeline at several fleet sizes in one city.
// Needs the dev server (window.__mapScene). For each count it loads /map, waits for the
// traffic worker, then reports frame rate, main-thread layer time, worker tick and LOD
// bucketing time, visible vehicles and triangles in three camera views.
//   node tooling/scale-probe.mjs <city> <count> [count ...]      e.g. london 100000 1000000
// Set BASE to target another server (default http://localhost:5175).
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:5175";
const [city, ...counts] = process.argv.slice(2);
const views = {
  overview: { zoom: 14.5, pitch: 60, bearing: 20 },
  street: { zoom: 17.5, pitch: 70, bearing: -30 },
  peak: { zoom: 14.0, pitch: 0, bearing: 0 },
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
console.log("count     view       fps  frame  layer  wTick  wBucket  visible  tris(M)");
for (const n of counts) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const t0 = Date.now();
  await page.goto(`${BASE}/?city=${city}&vehicles=${n}`, { waitUntil: "load" });
  await page.waitForFunction(() => (window.__mapScene?.lastStats?.snapshots ?? 0) > 5, null, {
    timeout: 240000,
    polling: 250,
  });
  const ready = ((Date.now() - t0) / 1000).toFixed(1);
  for (const [name, v] of Object.entries(views)) {
    await page.evaluate((v) => {
      const m = window.__mapScene.map;
      m.jumpTo({ ...v, center: m.getCenter() });
    }, v);
    await page.waitForTimeout(7000);
    const s = await page.evaluate(() => window.__mapScene.lastStats);
    console.log(
      `${String(n).padEnd(9)} ${name.padEnd(9)} ${s.fps.toFixed(0).padStart(4)} ${s.frameMs.toFixed(1).padStart(6)} ${s.layerMs.toFixed(2).padStart(6)} ${s.workerTickMs.toFixed(1).padStart(6)} ${s.workerBucketMs.toFixed(1).padStart(8)} ${String(s.visible).padStart(8)} ${(s.triangles / 1e6).toFixed(1).padStart(8)}`,
    );
  }
  const road = await page.evaluate(() => window.__mapScene.lastStats.roadKm);
  console.log(`          ready after ${ready} s, ${road.toFixed(0)} km of directed road`);
  await page.close();
}
await browser.close();
