'use strict';
// Isolated real main/preload/settings/signup helper + real mail Worker fixture.
// Registration commands are simulated; no external requests or MEGA accounts.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const { TOKEN } = require('./fixtures/mail-inbox.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-signup-ui-'));
  const data = path.join(profile, 'data'); fs.mkdirSync(data);
  const configFile = path.join(profile, 'mega-dl-config.json');
  fs.writeFileSync(configFile, JSON.stringify({ dataDir: data, proxy: 'https://unused.invalid', defaultTab: 'settings' }));
  fs.writeFileSync(path.join(profile, 'mail-inbox.json'), JSON.stringify({ version: 2, connections: [{
    id: 'fixture-mail', label: 'Signup mail', url: 'https://signup.fixture.workers.dev', token: TOKEN,
  }] }));
  const preload = path.join(profile, 'preload.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(root, 'preload.js'))});
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('signupQa',{signup:()=>ipcRenderer.invoke('qa-signup')});`);
  const launcher = path.join(profile, 'launch.cjs');
  fs.writeFileSync(launcher, `
const electron=require('electron'),{app,ipcMain,Menu,safeStorage}=electron;
const path=require('path'),ROOT=${JSON.stringify(root)};
app.setPath('userData',${JSON.stringify(profile)});app.setAppPath(ROOT);
safeStorage.isEncryptionAvailable=()=>false;
Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'File',submenu:[]},{label:'Help',submenu:[]}]));
const {backend}=require(path.join(ROOT,'scripts/fixtures/mail-inbox.cjs'));
const remote=(async()=>{const r=await backend();await r.add(['one.example','two.example','three.example','four.example','five.example']);return r;})();
global.fetch=async(raw,opts)=>{
 if(new URL(raw).hostname!=='signup.fixture.workers.dev')return new Response('',{status:503});
 return(await remote).fetch(raw,opts);
};
const NativeWindow=electron.BrowserWindow,fixture=Object.create(electron);
Object.defineProperty(fixture,'BrowserWindow',{value:class extends NativeWindow{
 constructor(options){super({...options,webPreferences:{...options.webPreferences,preload:${JSON.stringify(preload)},sandbox:false}});}
}});
const Module=require('module'),load=Module._load;
Module._load=function(id,...args){return id==='electron'?fixture:load.call(this,id,...args);};
require('child_process').spawn=()=>{throw new Error('Signup fixture cannot launch external commands');};
require(path.join(ROOT,'main.js'));
ipcMain.handle('qa-signup',async()=>{
 const {registerMegaAccount}=require(path.join(ROOT,'src/account-creator'));
 return registerMegaAccount({createToolOrder:['megatools'],send:()=>{},shouldAbort:()=>false,trackProc:()=>{},
  cancellableDelay:ms=>new Promise(resolve=>setTimeout(resolve,ms)),rwtT:async()=>'',
  execT:async(_tool,args)=>{
   if(args.includes('--register')){
    const email=args[args.indexOf('--email')+1];
    await(await remote).deliver(email.split('@')[1],{to:email,subject:'MEGA confirmation',text:'https://mega.nz/#confirmfixture_token'});
    return 'QUJD:REVG:R0hJ';
   }
   if(args.at(-1)!=='https://mega.nz/#confirmfixture_token')throw new Error('Wrong confirmation link');
   return '';
  }
 });
});
`);
  const emails = [];
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
      assert.ok(page, stderr); await page.setViewport({ width: 1200, height: 900 });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.waitForFunction(() => window.signupQa && document.getElementById('cfg-dataDir').value);
      await page.click('.tab[data-tab="settings"]');
      const selected = () => page.$eval('input[name="cfg-signupEmailSource"]:checked', e => e.value);
      assert.equal(await selected(), restarted ? 'cloudflare' : 'temp-mail');
      if (!restarted) {
        assert.equal((await page.evaluate(() => window.api.mailState())).state.connections[0].domainCount, 0);
        await page.click('input[name="cfg-signupEmailSource"][value="cloudflare"]');
        await page.click('#cfg-save-top');
        await page.waitForFunction(() => document.getElementById('cfg-save-top').textContent.includes('Saved'));
        assert.equal(JSON.parse(fs.readFileSync(configFile)).signupEmailSource, 'cloudflare');
        await page.$eval('.signup-mail-toggle', el => el.scrollIntoView({ block: 'center' }));
        await page.screenshot({ path: '/tmp/m3-signup-mail-settings.png' });
        await page.setViewport({ width: 900, height: 680 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.setViewport({ width: 1200, height: 900 });
      }
      await page.click('.tab[data-tab="upload"]');
      for (let i = 0; i < (restarted ? 3 : 2); i++) {
        const account = await page.evaluate(() => window.signupQa.signup());
        emails.push(account.email);
        assert.match(account.email, /^[a-z]+\.[a-z]+\d+@/);
        assert.equal(account.registeredWith, 'megatools');
        assert.equal(await page.$eval('.tab.active', e => e.dataset.tab), 'upload');
        assert.equal(await page.$eval('#mailPanel', e => e.hidden), true);
      }
      assert.deepEqual(errors, []);
    } catch (error) { console.error(stderr.slice(-5000)); throw error; }
    finally { browser?.disconnect(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
  }
  try {
    await run(false); await run(true);
    assert.equal(new Set(emails.map(email => email.split('@')[1])).size, 5);
    const rows = fs.readFileSync(path.join(data, 'account_log.csv'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 6);
    console.log('Signup Electron checks passed: settings default/save/restart, five-domain deck across restart, background confirmation with Upload focused, and account logs.');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
