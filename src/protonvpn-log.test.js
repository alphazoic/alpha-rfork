'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseConnectionLog, createCliLogDiagnostics } = require('./protonvpn-log');
const server = '2026-10-16T15:03:21Z | proton.vpn.core.vpnconnector:388 | INFO | CONN.CONNECT:START | Server: KH#3 / Domain: private.invalid / IP: 192.0.2.1 / token=secret';
const timeout = '2026-10-16T15:03:32Z | proton.vpn.cli.core.controller:136 | ERROR | Timed out after 10s waiting for event(s): CONNECTED';
test('CLI log diagnostics extract only a validated server and the CONNECTED timeout', () => {
  assert.deepEqual(parseConnectionLog(server + '\n' + timeout + '\npassword=secret email=private@example.test'), { server: 'KH#3', timeoutSeconds: 10 });
  assert.deepEqual(parseConnectionLog(timeout.replace('CONNECTED', 'DISCONNECTED') + '\n' + server.replace('KH#3', 'password=secret')), {});
});
test('CLI log reader correlates appended records only and ignores rotation/missing logs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-proton-log-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'vpn-cli.log'), reader = createCliLogDiagnostics({ filePath });
  assert.equal(reader.begin(), null); assert.deepEqual(reader.finish(null), {});
  fs.writeFileSync(filePath, timeout + '\n'); const first = reader.begin();
  fs.appendFileSync(filePath, server + '\n'); assert.deepEqual(reader.finish(first), { server: 'KH#3' });
  const next = reader.begin(); fs.appendFileSync(filePath, timeout + '\n');
  assert.deepEqual(reader.finish(next), { timeoutSeconds: 10 });
  const rotate = reader.begin(); fs.renameSync(filePath, filePath + '.1'); fs.writeFileSync(filePath, server + '\n' + timeout);
  assert.deepEqual(reader.finish(rotate), {});
});
test('CLI log reader bounds reads instead of returning an unbounded log', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-proton-log-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'vpn-cli.log'); fs.writeFileSync(filePath, '');
  const reader = createCliLogDiagnostics({ filePath, maxBytes: 1024 }); const token = reader.begin();
  fs.appendFileSync(filePath, server + '\n' + 'private-data\n'.repeat(20000) + timeout);
  assert.deepEqual(reader.finish(token), { timeoutSeconds: 10 });
});
