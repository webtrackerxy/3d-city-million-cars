// Dev utility: open a page in the installed Chrome, wait, then dump console output and a screenshot.
//   node tooling/page-diagnostics.mjs <url> <screenshot.png>
import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 600)}`));
page.on("requestfailed", (r) =>
  logs.push(`[requestfailed] ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ""}`),
);
page.on("response", (r) => {
  if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url().slice(0, 160)}`);
});
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(9000);
const panel = await page
  .locator(".panel")
  .innerText()
  .catch(() => "(no panel)");
const done = await page.evaluate(() => Boolean(window.__lastBenchmarkRun));
await page.screenshot({ path: process.argv[3] });
console.info("done flag:", done);
console.info("--- panel ---\n" + panel);
console.info("--- console ---\n" + logs.join("\n"));
await browser.close();
