import { chromium } from "playwright";
const [url, shot, lng, lat, zoom = "16.5", pitch = "70", bearing = "20"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-unsafe-webgpu"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(12000);
await page.evaluate(([lng, lat, z, p, b]) => {
  const s = window.__mapScene;
  s.map.jumpTo({ center: [Number(lng), Number(lat)], zoom: Number(z), pitch: Number(p), bearing: Number(b) });
}, [lng, lat, zoom, pitch, bearing]);
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const s = window.__mapScene;
  const b = s.buffer;
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < b.count; i++) { const y = b.y[i]; if (y < min) min = y; if (y > max) max = y; sum += y; }
  return { terrain: s.map.getTerrain(), hf: s.heightField ? { w: s.heightField.width, h: s.heightField.height, base: s.heightField.sample(0, 0) } : null,
    y: { min, max, mean: sum / b.count }, count: b.count, last: s.lastStats ?? null, fps: s.vehicleLayer?.stats?.fps ?? null };
});
console.info(JSON.stringify(info));
if (errors.length) console.info("errors:\n" + errors.slice(0, 5).join("\n"));
await page.screenshot({ path: shot });
await browser.close();
