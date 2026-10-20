'use strict';
// Real Electron/main/preload/UI, two in-memory mail Workers, no external HTTP.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { TOKEN } = require('./fixtures/mail-inbox.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-multi-inbox-ui-'));
  const data = path.join(profile, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(profile, 'mega-dl-config.json'), JSON.stringify({ dataDir: data, proxy: 'https://unused.invalid', defaultTab: 'settings' }));
  const launcher = path.join(profile, 'launch.cjs');
  fs.writeFileSync(launcher, `
const { app, Menu, dialog, safeStorage } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)}); app.setAppPath(${JSON.stringify(root)});
safeStorage.isEncryptionAvailable = () => false;
dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[${JSON.stringify(profile)}] });
Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'File',submenu:[]},{label:'Help',submenu:[]}]));
const { backend } = require(${JSON.stringify(path.join(root, 'scripts/fixtures/mail-inbox.cjs'))});
const fixtures = Promise.all([backend(), backend()]);
const seeded = new Set(), tests = new Map();
global.fetch = async (raw, options = {}) => {
  const url = new URL(raw), servers = await fixtures;
  const index = ['first.fixture.workers.dev', 'second.fixture.workers.dev'].indexOf(url.hostname);
  if (index < 0) return new Response('', {status:503});
  const server = servers[index];
  if (url.pathname === '/v2/health' && tests.has(index)) {
    const pending = tests.get(index); pending.reads--;
    if (!pending.reads) { await server.deliver(pending.domain, { to:pending.recipient, subject:'Delivery test received' }); tests.delete(index); }
  }
  const response = await server.fetch(raw, options);
  if (response.ok && options.method === 'POST' && url.pathname === '/v2/domains') {
    const result = await response.clone().json();
    for (const item of result.results) if (item.status === 'added' && !seeded.has(index + item.name)) {
      seeded.add(index + item.name);
      await server.deliver(item.name, { subject:'Welcome ' + item.name, text:'Mail for ' + item.name + '\\n<script>window.mailInjected=true</script>' });
      if (item.name === 'first.example') for (let i=0;i<43;i++) await server.deliver(item.name, { subject:'Earlier message ' + i });
    }
  }
  if (response.ok && options.method === 'POST' && url.pathname.endsWith('/test')) {
    const result = await response.clone().json();
    tests.set(index, { domain:decodeURIComponent(url.pathname.split('/')[3]), recipient:result.recipient, reads:2 });
  }
  return response;
};
const cp = require('child_process'); cp.spawn = () => { throw new Error('UI fixture cannot launch external commands'); };
require(${JSON.stringify(path.join(root, 'main.js'))});
`);
  async function run(restarted) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), ['--no-sandbox', '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', launcher],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', browser;
    const exited = new Promise(resolve => child.once('exit', resolve));
    const endpoint = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No Electron endpoint: ' + stderr)), 20000);
      child.stderr.on('data', d => { stderr += d; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited ' + code + ': ' + stderr)); });
    });
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: await endpoint });
      let page;
      for (let i = 0; i < 100; i++) {
        page = (await browser.pages()).find(p => p.url().endsWith('/index.html'));
        if (page) break; await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(page, stderr); await page.setViewport({ width: 1280, height: 900 });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      page.on('dialog', dialog => dialog.accept());
      await page.waitForFunction(() => window.api?.mailSync && document.querySelector('.tab[data-tab="settings"]').classList.contains('active'));
      await page.click('.tab[data-tab="inbox"]');
      await page.waitForFunction(() => document.getElementById('mail-storage-note').textContent.length > 0);
      if (restarted) {
        const result = await page.evaluate(() => window.api.mailState());
        assert.equal(result.state.connections.length, 2);
        assert.ok(result.state.connections.every(item => item.hasToken && item.storage === 'local'));
        assert.equal(JSON.stringify(result).includes(TOKEN), false);
        await page.waitForFunction(() => document.getElementById('mail-status').textContent.includes('Updated'));
        assert.deepEqual(errors, []);
        console.log('Multi-domain inbox restart passed: connections and local credentials restored.');
        return;
      }
      assert.match(await page.$eval('#mail-storage-note', e => e.textContent), /will be saved automatically/);
      await page.click('#mail-export');
      await page.waitForFunction(() => document.getElementById('mail-status').textContent.includes('Worker files exported'));
      const exported = fs.readdirSync(profile).find(name => name.startsWith('m3-mail-inbox-'));
      for (const file of ['SETUP.md', 'worker.mjs', 'migrations/0001_inbox.sql', 'migrations/0002_multiple_domains.sql']) assert.ok(fs.existsSync(path.join(profile, exported, file)));
      await page.type('#mail-name', 'Primary mail'); await page.type('#mail-url', 'https://first.fixture.workers.dev'); await page.type('#mail-token', TOKEN);
      await page.click('#mail-connect');
      await page.waitForFunction(() => document.getElementById('mail-storage-note').textContent.includes('saved locally') && !document.getElementById('mail-connect').disabled);
      const primary = await page.$eval('#mail-connections', e => e.value);
      await page.type('#mail-add-domains', 'first.example\nsecond.example\nthird.example\nfourth.example\nfifth.example\nbad@entry');
      await page.click('#mail-add');
      await page.waitForFunction(() => document.getElementById('mail-add-results').textContent.includes('5 added') && document.querySelectorAll('#mail-domains .mail-domain-button').length === 5);
      assert.match(await page.$eval('#mail-add-results', e => e.textContent), /1 invalid/);
      await page.screenshot({ path: '/tmp/m3-multi-inbox-management.png' });
      await page.click('#mail-connection summary');
      await page.click('#mail-refresh');
      await page.waitForFunction(() => document.querySelectorAll('.mail-message').length === 40);
      await page.$eval('#mail-more', e => e.click());
      await page.waitForFunction(() => document.querySelectorAll('.mail-message').length === 48);
      await page.$eval('.mail-message', e => e.click());
      await page.waitForSelector('.mail-message-body');
      const selected = await page.$eval('.mail-message-body', e => e.textContent);
      await page.click('#mail-refresh');
      await page.waitForFunction(() => !document.getElementById('mail-refresh').disabled);
      assert.equal(await page.$eval('.mail-message-body', e => e.textContent), selected);
      assert.equal(await page.$$eval('.mail-message', e => e.length), 48);
      assert.equal(await page.evaluate(() => window.mailInjected), undefined);
      assert.equal(await page.$$eval('#mail-reader script, #mail-reader img', e => e.length), 0);
      await page.click('[data-domain="second.example"]');
      await page.waitForFunction(() => document.querySelectorAll('.mail-message').length === 1);
      await page.$eval('.mail-message', e => e.click()); await page.waitForSelector('.mail-message-body');
      assert.match(await page.$eval('.mail-message-body', e => e.textContent), /second.example/);
      await page.click('#mail-test-domain');
      await page.waitForFunction(() => document.getElementById('mail-test-address').value.includes('@second.example'));
      assert.match(await page.$eval('#mail-domain-state', e => e.textContent), /Awaiting test email/);
      await page.click('#mail-refresh');
      await page.waitForFunction(() => document.getElementById('mail-domain-state').textContent.includes('Receiving confirmed'));
      await page.screenshot({ path: '/tmp/m3-multi-inbox-connected.png' });
      await page.click('#mail-toggle-domain');
      await page.waitForFunction(() => document.getElementById('mail-domain-state').textContent.includes('Receiving disabled'));
      await page.click('#mail-toggle-domain');
      await page.waitForFunction(() => !document.getElementById('mail-toggle-domain').textContent.includes('Enable'));
      await page.click('#mail-all');
      await page.type('#mail-domain-search', 'fifth');
      await page.waitForFunction(() => document.querySelectorAll('#mail-domains .mail-domain-button').length === 1);
      await page.$eval('#mail-domain-search', e => { e.value=''; e.dispatchEvent(new Event('input')); });
      await page.waitForFunction(() => document.querySelectorAll('#mail-domains .mail-domain-button').length === 5);
      await page.click('#mail-manage'); await page.select('#mail-connections', '');
      await page.type('#mail-name', 'Secondary mail'); await page.type('#mail-url', 'https://second.fixture.workers.dev'); await page.type('#mail-token', TOKEN);
      await page.click('#mail-connect');
      await page.waitForFunction(() => document.querySelectorAll('#mail-connections option').length === 3 && !document.getElementById('mail-connect').disabled);
      await page.$eval('#mail-add-domains', e => { e.value='other.example'; });
      await page.click('#mail-add');
      await page.waitForFunction(() => document.querySelectorAll('#mail-domains .mail-domain-button').length === 6);
      await page.select('#mail-connections', primary); await page.type('#mail-token', 'wrong-token-'.repeat(4));
      await page.click('#mail-connect');
      await page.waitForFunction(() => document.getElementById('mail-status').textContent.includes('rejected the access token'));
      await page.click('#mail-connection summary'); await page.click('#mail-refresh');
      await page.waitForFunction(() => document.getElementById('mail-status').textContent.includes('unavailable'));
      assert.ok((await page.$$eval('.mail-message', e => e.map(n => n.textContent))).some(s => s.includes('other.example')));
      await page.click('#mail-manage');
      await page.$eval('#mail-token', e => { e.value=''; }); await page.type('#mail-token', TOKEN); await page.click('#mail-connect');
      await page.waitForFunction(() => document.getElementById('mail-status').textContent.includes('Updated'));
      await page.click('#mail-connection summary'); await page.setViewport({ width: 900, height: 680 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({ path: '/tmp/m3-multi-inbox-small.png' });
      assert.deepEqual(errors, []);
      console.log('Multi-domain Electron checks passed: bulk add, combined inbox, domain filter/test/toggle, paging preservation, multiple connections, failure isolation, setup export, narrow layout.');
    } catch (error) {
      if (browser) for (const tab of await browser.pages()) {
        console.error('UI failure state:', await tab.evaluate(() => ({ url: location.href, api: Object.keys(window.api || {}),
          active: [...document.querySelectorAll('.tab.active')].map(n => n.dataset.tab), status: document.getElementById('mail-status')?.textContent })).catch(() => ({})));
        await tab.screenshot({ path: '/tmp/m3-multi-inbox-failure.png' }).catch(() => {});
      }
      console.error(stderr.slice(-7000));
      throw error;
    } finally {
      browser?.disconnect(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited;
    }
  }
  try { await run(false); await run(true); }
  finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
