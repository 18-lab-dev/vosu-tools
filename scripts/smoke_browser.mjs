// Non-mutating UI checks via authorized dashboard launches in an isolated daemon.
import { mkdir, writeFile } from 'node:fs/promises';
const [playwrightModule, evidence, ...ids] = process.argv.slice(2);
if (!playwrightModule || !evidence || !ids.length) throw new Error('Usage: smoke_browser.mjs <playwright index.mjs> <evidence directory> <tool ids...>');
const { chromium } = await import(playwrightModule);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] });
const report = [];
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
    const dashboard = await context.request.get('http://127.0.0.1:25151/tools');
    const match = (await dashboard.text()).match(/<script[^>]*id="vosu-context"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Isolated dashboard context is missing');
    const csrf = JSON.parse(match[1]).csrf;
    for (const id of ids) {
      const page = await context.newPage();
      const errors = [];
      const apiUnavailable = [];
      const failures = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (response.status() >= 400 && response.url().startsWith('http://127.0.0.1:25150/')) {
          const detail = `${response.status()} ${response.url()}`;
          if (['document', 'script', 'stylesheet', 'font'].includes(response.request().resourceType())) failures.push(detail);
          else apiUnavailable.push(detail);
        }
      });
      const launch = await context.request.post(`http://127.0.0.1:25151/api/tools/${encodeURIComponent(id)}/launch`, {
        headers: { Origin: 'http://127.0.0.1:25151', 'X-Vosu-CSRF': csrf }, data: { theme },
      });
      if (!launch.ok()) throw new Error(`${id}: dashboard launch failed (${launch.status()})`);
      const response = await page.goto((await launch.json()).url, { waitUntil: 'networkidle' });
      if (!response || response.status() !== 200) throw new Error(`${id}: UI document did not load`);
      await page.evaluate(() => document.fonts.ready);
      const text = await page.locator('body').innerText();
      if (!text.trim()) throw new Error(`${id}: UI is empty`);
      await page.screenshot({ path: `${evidence}/${id}-${theme}.png`, fullPage: true });
      report.push({ id, theme, title: await page.title(), errors, failures, apiUnavailable });
      if (errors.length || failures.length) throw new Error(`${id}: ${[...errors, ...failures].join('\n')}`);
      console.log(`${id} (${theme}): UI loaded without page exceptions or failed static assets; ${apiUnavailable.length} unavailable API responses recorded`);
      await page.close();
    }
    await context.close();
  }
} finally {
  await writeFile(`${evidence}/browser.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
