'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(process.argv[2]);
const files = fs.readdirSync(root).filter(name => /\.(deb|exe|dmg)$/.test(name));
if (!files.length) throw new Error('No installer artifacts produced');
const artifacts = files.map(file => ({ file, bytes: fs.statSync(path.join(root, file)).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
fs.writeFileSync(path.join(root, 'installers.json'), JSON.stringify({ commit: process.env.GITHUB_SHA || null, artifacts }, null, 2) + '\n');
console.log(JSON.stringify(artifacts));
