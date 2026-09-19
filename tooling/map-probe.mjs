// Dev utility: open /map in the installed Chrome, jump to a view, wait, print layer stats and screenshot.
//   node tooling/map-probe.mjs <url> <screenshot.png> [zoom] [pitch] [bearing]
import { chromium } from "playwright";
const [url, shot, zoom = "17.8", pitch = "72", bearing = "-30"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 300));
});
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(7000);
await page.evaluate(
  ([z, p, b]) => {
    const s = window.__mapScene;
    const c = s.map.getCenter();
    s.map.jumpTo({ center: [c.lng, c.lat], zoom: Number(z), pitch: Number(p), bearing: Number(b) });
  },
  [zoom, pitch, bearing],
);
await page.waitForTimeout(6000);
const stats = await page.evaluate(() => {
  const s = window.__mapScene;
  return { last: s.lastStats ?? null, layer: s.vehicleLayer?.stats ?? null };
});
console.info(JSON.stringify(stats));
if (errors.length) console.info("errors:\n" + errors.slice(0, 5).join("\n"));
await page.screenshot({ path: shot });
await browser.close();
