'use strict';
// Local filesystem stand-in for the three CLIs. NEVER contacts a network.
const fs = require('node:fs'), path = require('node:path');
const tool = path.basename(process.argv[1]), a = process.argv.slice(2);
const root = path.resolve(__dirname, '../..'), remote = path.join(root, 'fake-remote');
const option = name => a[a.indexOf(name) + 1];
const resolve = value => path.join(remote, value.replace(/^(?:benchmark:|\/Root\/|\/)/, ''));
const copy = (source, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); };
if (tool === 'mega-cmd-server') {
  fs.writeFileSync(path.join(process.env.HOME, 'fake-server-pid'), String(process.pid));
  setInterval(() => {}, 1000);
} else if (tool === 'rfork') {
  if (a[0] === 'obscure') { process.stdin.resume(); process.stdin.on('end', () => console.log('fake-obscured')); }
  else if (a[0] === 'version') console.log('rfork fake offline test');
  else if (a[0] === 'about') console.log(JSON.stringify({ total: 20 * 1024 ** 3, used: 0 }));
  else if (a[0] === 'mkdir') fs.mkdirSync(resolve(a[1]), { recursive: true });
  else if (a[0] === 'purge') fs.rmSync(resolve(a[1]), { recursive: true, force: true });
  else if (a[0] === 'copyto') copy(a[1].startsWith('benchmark:') ? resolve(a[1]) : a[1], a[2].startsWith('benchmark:') ? resolve(a[2]) : a[2]);
  else if (a[0] === 'lsjson') {
    const dir = resolve(a[1]);
    const walk = (folder, prefix = '') => fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true }).flatMap(e => {
      const file = path.join(folder, e.name), relative = prefix + e.name;
      if (e.isDirectory()) return a.includes('--dirs-only') ? [{ Name: e.name, Path: relative, IsDir: true }] : walk(file, relative + '/');
      return a.includes('--dirs-only') ? [] : [{ Name: e.name, Path: relative, Size: fs.statSync(file).size }];
    }) : [];
    console.log(JSON.stringify(walk(dir)));
  } else throw new Error('Unexpected offline rfork command');
} else if (tool === 'megatools') {
  if (a.includes('--version')) console.log('megatools fake offline test');
  else if (a[0] === 'put') copy(a.at(-1), resolve(option('--path')));
  else if (a[0] === 'get') copy(resolve(a.at(-1)), option('--path'));
  else throw new Error('Unexpected offline megatools command');
} else if (tool === 'mega-exec') {
  const connections = path.join(process.env.HOME, 'fake-connections');
  if (a[0] === 'version') console.log('MEGAcmd fake offline test');
  else if (a[0] === 'login') console.log('Logged in');
  else if (a[0] === 'speedlimit') {
    if (a[1] === '--upload-connections') {
      if (a[2]) fs.writeFileSync(connections, a[2]);
      console.log('Max upload connections: ' + fs.readFileSync(connections, 'utf8'));
    }
  } else if (a[0] === 'put') copy(a[1], path.join(resolve(a[2]), path.basename(a[1])));
  else if (a[0] === 'quit') {
    try { process.kill(Number(fs.readFileSync(path.join(process.env.HOME, 'fake-server-pid'), 'utf8')), 'SIGTERM'); } catch { /* server already stopped */ }
  } else throw new Error('Unexpected offline MEGAcmd command');
} else throw new Error('Unknown offline fixture executable');
