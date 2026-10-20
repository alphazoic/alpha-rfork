'use strict';

const network = require('./network-operations');
let megaWindow = null;
let browserTask = null;

// Keep a connection lease until the actual browser closes, including after
// control is handed to the user. A successful login is not a safe switch point.
async function openMegaBrowser(email, password, send) {
  if (browserTask) { send('up:log', 'Browser is already open or waiting to open.'); return; }
  let ready, failed;
  const opened = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  browserTask = network.run('browser', async signal => {
    let browser, disconnected, onLost;
    try {
      network.checkpoint();
      send('up:log', 'Launching browser...');
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({ headless: false, defaultViewport: null,
        args: ['--start-maximized', '--no-sandbox'] });
      megaWindow = browser;
      disconnected = new Promise(resolve => browser.once('disconnected', resolve));
      browser.once('disconnected', () => {
        if (megaWindow === browser) megaWindow = null;
        send('up:log', 'Browser closed.'); send('up:browserClosed', {});
      });
      onLost = () => send('up:log', 'VPN operation interrupted. Close the MEGA browser to release its connection lease.');
      signal?.addEventListener('abort', onLost, { once: true });
      network.checkpoint();
      const pages = await browser.pages();
      const page = pages[0];
      page.on('dialog', dialog => dialog.accept().catch(() => {}));
      network.checkpoint();
      send('up:log', 'Navigating to mega.nz/login...');
      await page.goto('https://mega.nz/login', { waitUntil: 'networkidle0', timeout: 60000 });
      if (email && password) {
        await network.delay(5000);
        network.checkpoint(); await page.keyboard.type(email, { delay: 100 });
        network.checkpoint(); await page.keyboard.press('Tab');
        await network.delay(500);
        network.checkpoint(); await page.keyboard.type(password, { delay: 100 });
        network.checkpoint(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.location.href.includes('/fm') || window.location.href.includes('/cloud'),
          { timeout: 120000, polling: 1000 });
        network.checkpoint();
        send('up:log', 'Browser is ready. You can now upload files manually.');
      } else send('up:log', 'Browser opened at login. Log in manually.');
      send('up:browserReady', { email });
      ready();
      await disconnected;
    } catch (error) {
      failed(error.vpnInterrupted ? error : new Error('The MEGA browser could not be opened.'));
      if (browser) {
        // If close fails, retain the lease until the real disconnected event.
        try { await browser.close(); } catch { /* manual close is still possible */ }
        await disconnected;
      }
      throw error;
    } finally { signal?.removeEventListener('abort', onLost); }
  }).catch(error => {
    failed(error.vpnInterrupted ? error : new Error('The MEGA browser could not be opened.'));
    send('up:log', error.vpnInterrupted ? error.message : 'The MEGA browser could not be opened.');
    send('up:browserClosed', {});
  }).finally(() => { browserTask = null; });
  return opened;
}

async function closeMegaBrowser() {
  network.cancel('browser');
  if (megaWindow) {
    try { await megaWindow.close(); } catch { /* retain the lease while the window remains connected */ }
  }
}

async function shutdownMegaBrowser() {
  await closeMegaBrowser();
  // Includes a launch still in progress. The canceled lease prevents it from
  // navigating, and its real disconnected event must precede VPN shutdown.
  if (browserTask) await browserTask;
}

module.exports = { openMegaBrowser, closeMegaBrowser, shutdownMegaBrowser };
