// Dev utility: watch the adaptive LOD cap scale and frame rate over time, read from the
// on-screen overlay, so it works against production builds too. HEADED=1 opens a visible
// window, which runs at the display's real refresh rate (120 Hz on ProMotion displays);
// headless Chrome runs at 60 Hz.
//   HEADED=1 node tooling/adaptive-probe.mjs <url> [seconds]
import { chromium } from "playwright";
const [url, secs = "60"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADED !== "1" });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.goto(url, { waitUntil: "load" });
const t0 = Date.now();
const read = () =>
  page.evaluate(() => {
    const t = document.body.innerText;
    const c = /caps ×([0-9.]+)/.exec(t);
    const f = /([0-9]+) FPS/.exec(t);
    const v = /vehicles ([0-9,]+)/.exec(t);
    return `${f?.[1] ?? "-"} FPS  caps ×${c?.[1] ?? "-"}  vehicles ${v?.[1] ?? "-"}`;
  });
while ((Date.now() - t0) / 1000 < Number(secs)) {
  await page.waitForTimeout(5000);
  console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(3)} s  ${await read()}`);
}
await browser.close();
