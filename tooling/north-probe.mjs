// Dev utility: rotate the map, screenshot the compass, click "Point north" and print the bearing.
import { chromium } from "playwright";
const [url, shot] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(9000);
await page.evaluate(() => window.__mapScene.map.jumpTo({ bearing: 47, pitch: 60 }));
await page.waitForTimeout(1500);
const before = await page.evaluate(() => ({ bearing: window.__mapScene.map.getBearing(), needle: document.querySelector(".north-ctrl svg").style.transform }));
await page.screenshot({ path: shot, clip: { x: 1340, y: 0, width: 60, height: 200 } });
await page.click(".north-ctrl");
await page.waitForTimeout(1200);
const after = await page.evaluate(() => ({ bearing: window.__mapScene.map.getBearing(), pitch: window.__mapScene.map.getPitch() }));
console.info(JSON.stringify({ before, after }));
await browser.close();
