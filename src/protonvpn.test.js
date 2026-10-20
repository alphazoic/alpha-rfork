'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { createProtonVpn, ProtonVpnError, parseStatus, parseCapabilities, normalizeTarget,
  selectPreferredTarget, SERVER_DIRECTORY_URL } = require('./protonvpn');

// Human-readable fixtures mirror the installed official CLI 1.0.5 command
// definitions. Its servers command is a directory link, not a server table.
const ROOT_HELP = `Usage: protonvpn [OPTIONS] COMMAND [ARGS]...
  |_|   |_|  \\___/ \\__\\___/|_| |_|    \\_/  |_|   |_| \\_| 1.0.5
  Proton VPN command-line interface for Linux.
Options:
  -v, --verbose  Show detailed output during command execution
  -h, --help     Show this message and exit.
Commands:
  signin      Sign in to Proton VPN with your credentials.
  signout     Sign out from Proton VPN and clear local credentials.
  info        Display your Proton VPN account information.
  connect     Connect to Proton VPN server.
  disconnect  Disconnect from current VPN server.
  status      Show current VPN connection status.
  servers     View available servers.
  countries   Discover countries.
  cities      Discover cities.
  config      Configure Proton VPN settings.
Examples:
  protonvpn connect
`;
const CONNECT_HELP = `Usage: protonvpn connect [OPTIONS] [SERVER_NAME]
  Connect to Proton VPN server.
Options:
  --country TEXT  Connect to fastest server in specified country
  --city TEXT     Connect to fastest server in specified city
  --p2p           Connect to fastest P2P-optimized server
  -sc, --securecore  Connect to fastest Secure Core server
  --tor           Connect to fastest Tor server
  --random        Connect to random available server
  -h, --help      Show this message and exit.
Examples:
  protonvpn connect IT#23
`;
const CONNECTED = 'Status: Connected\nServer: CH#242 in Zurich, Switzerland\nLoad: 36%\nProtocol: wireguard\n';
const DISCONNECTED = 'Status: Disconnected\n';
const GUI_ERROR = 'Error: Proton VPN desktop app is currently running\nThe CLI and GUI cannot run simultaneously. Please close the GUI application and try again.';
const CAPS = parseCapabilities(ROOT_HELP, CONNECT_HELP);

test('shutdown disconnects and verifies status, and rejects subsequent ordinary commands', async () => {
  const cli = fakeCli({ status: DISCONNECTED });
  assert.equal((await cli.adapter.shutdown()).state, 'disconnected');
  const calls = cli.calls.map(c => c.args.join(' '));
  assert.ok(calls.includes('disconnect')); assert.equal(calls.at(-1), 'status');
  await assert.rejects(cli.adapter.connect(), expectCode('CANCELED'));
});
test('shutdown cancels a connect and waits for process cleanup before disconnecting', async () => {
  const cli = fakeCli({ connect: { hang: true }, status: DISCONNECTED });
  await cli.adapter.inspect();
  const connect = cli.adapter.connect(); const rejected = assert.rejects(connect, expectCode('CANCELED'));
  await new Promise(resolve => setImmediate(resolve));
  const active = cli.processes.at(-1);
  const quitting = cli.adapter.shutdown();
  await rejected; assert.equal((await quitting).state, 'disconnected');
  assert.deepEqual(active.kills, ['SIGTERM']);
  assert.equal(cli.calls.filter(c => c.args[0] === 'disconnect').length, 1);
});
test('shutdown will not overlap an unconfirmed process and succeeds after late closure', async () => {
  const cli = fakeCli({ connect: { hang: true, ignoreKill: true }, status: DISCONNECTED }, { killGraceMs: 5 });
  await cli.adapter.inspect();
  const connect = cli.adapter.connect(); const rejected = assert.rejects(connect, expectCode('CANCELED'));
  await new Promise(resolve => setImmediate(resolve)); const active = cli.processes.at(-1);
  await assert.rejects(cli.adapter.shutdown(), expectCode('PROCESS_UNCONFIRMED')); await rejected;
  assert.equal(cli.calls.filter(c => c.args[0] === 'disconnect').length, 0);
  active.emit('close', null);
  assert.equal((await cli.adapter.shutdown()).state, 'disconnected');
});
test('shutdown rejects a connected postcondition and permits retry without restarting the adapter', async () => {
  let disconnected = false;
  const cli = fakeCli({ status: () => disconnected ? DISCONNECTED : CONNECTED });
  await assert.rejects(cli.adapter.shutdown(), expectCode('DISCONNECT_UNVERIFIED'));
  disconnected = true; assert.equal((await cli.adapter.shutdown()).state, 'disconnected');
});

test('optional missing CLI permits exit after a failed setup check; enabled integration still requires disconnect', async () => {
  const missing = { '--help': { error: Object.assign(new Error('missing'), { code: 'ENOENT' }) } };
  const cli = fakeCli(missing); await cli.adapter.diagnose();
  assert.equal((await cli.adapter.shutdown({ requireDisconnect: false })).state, 'not-installed');
  const required = fakeCli(missing);
  await assert.rejects(required.adapter.shutdown({ requireDisconnect: true }), expectCode('CLI_MISSING'));
});

test('terminal observer streams raw output before completion and preserves split UTF-8', async () => {
  const events = [];
  const bytes = Buffer.from('Status: Connected\nServer: CH#242 in Zürich, Switzerland\n');
  const split = bytes.indexOf(Buffer.from('ü')) + 1;
  const cli = fakeCli({ status: { chunks: [bytes.subarray(0, split), bytes.subarray(split)], hang: true } }, { onTerminalEvent: event => events.push(event) });
  await cli.adapter.inspect(); events.length = 0;
  const pending = cli.adapter.getStatus();
  await new Promise(resolve => setImmediate(resolve));
  const output = events.filter(e => e.kind === 'stdout').map(e => e.text).join('');
  assert.equal(output, bytes.toString('utf8'));
  assert.equal(events.some(e => e.phase === 'result'), false);
  assert.equal(events[0].deadlineMs, 15000); assert.equal(events[0].text, 'protonvpn status');
  cli.processes.at(-1).emit('close', 0);
  assert.equal((await pending).state, 'connected');
  assert.equal(events.find(e => e.phase === 'close').exitCode, 0);
});

test('announced server-list refresh extends only the default status deadline, once and with a ceiling', async () => {
  const events = [];
  const cli = fakeCli({ status: { stdout: 'Server list is outdated, updating... This may take a moment.\n', hang: true } },
    { timeoutMs: 20, statusRefreshTimeoutMs: 150, onTerminalEvent: event => events.push(event) });
  await cli.adapter.inspect(); events.length = 0;
  const status = cli.adapter.getStatus();
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(cli.processes.at(-1).kills.length, 0);
  assert.equal(events.filter(e => e.phase === 'deadline').length, 1);
  cli.processes.at(-1).stdout.write(CONNECTED); cli.processes.at(-1).emit('close', 0);
  assert.equal((await status).state, 'connected');
  assert.equal(events.find(e => e.phase === 'deadline').deadlineMs, 150);

  const timeout = cli.adapter.getStatus({ timeout: 15 });
  await assert.rejects(timeout, expectCode('TIMEOUT'));
  assert.equal(events.filter(e => e.phase === 'deadline').length, 1);
  const hung = fakeCli({ status: { stdout: 'Server list is outdated, updating... This may take a moment.\n', hang: true } }, { timeoutMs: 10, statusRefreshTimeoutMs: 30 });
  await assert.rejects(hung.adapter.getStatus(), expectCode('TIMEOUT'));
});

test('terminal retains stderr and output during timeout cleanup and records late process close', async () => {
  const events = [];
  const cli = fakeCli({ status: { hang: true, ignoreKill: true } }, { timeoutMs: 10, killGraceMs: 5, onTerminalEvent: event => events.push(event) });
  await cli.adapter.inspect(); events.length = 0;
  await assert.rejects(cli.adapter.getStatus(), error => error.code === 'TIMEOUT' && !error.terminationConfirmed);
  assert.match(events.find(e => e.phase === 'stop').text, /no stdout or stderr/);
  const process = cli.processes.at(-1); process.stderr.write('  Traceback\n\x1b[31mraw detail\x1b[0m\n');
  process.stdout.write('late output\n'); process.emit('close', null, 'SIGKILL');
  assert.equal(events.find(e => e.kind === 'stderr').text, '  Traceback\n\x1b[31mraw detail\x1b[0m\n');
  assert.ok(events.some(e => e.text === 'late output\n'));
  assert.equal(events.at(-1).phase, 'close'); assert.equal(events.at(-1).signal, 'SIGKILL');
  assert.ok(events.some(e => e.phase === 'unconfirmed'));
});

test('terminal observes cancellation and spawn failure, while observer errors never affect status', async () => {
  const events = [], abort = new AbortController();
  const cli = fakeCli({ status: { hang: true } }, { onTerminalEvent: event => events.push(event) });
  const pending = cli.adapter.getStatus({ signal: abort.signal }); abort.abort();
  await assert.rejects(pending, expectCode('CANCELED')); assert.ok(events.some(e => e.code === 'CANCELED'));
  const missing = fakeCli({ status: { error: Object.assign(new Error('missing executable'), { code: 'ENOENT' }) } }, { onTerminalEvent: event => events.push(event) });
  await assert.rejects(missing.adapter.getStatus(), expectCode('CLI_MISSING'));
  assert.ok(events.some(e => e.phase === 'spawn-failed'));
  const broken = fakeCli({}, { onTerminalEvent() { throw new Error('observer failed'); } });
  assert.equal((await broken.adapter.getStatus()).state, 'connected');
});

function fakeCli(overrides = {}, options = {}) {
  const calls = [], processes = [];
  const defaults = {
    '--help': ROOT_HELP, 'connect --help': CONNECT_HELP,
    info: "Account: 'private-user@example.com'", status: CONNECTED,
    servers: `To view detailed server information including specific server IDs, visit: ${SERVER_DIRECTORY_URL}`,
    connect: 'Connected to CH#242 in Zurich, Switzerland.\nYour new IP address is 192.0.2.10.',
    disconnect: 'Disconnected.',
  };
  const fakeSpawn = (executable, args, spawnOptions) => {
    calls.push({ executable, args, options: spawnOptions });
    const key = args.join(' ');
    let response = Object.hasOwn(overrides, key) ? overrides[key]
      : Object.hasOwn(overrides, args[0]) && !args.includes('--help') ? overrides[args[0]]
        : defaults[key] ?? defaults[args[0]];
    if (typeof response === 'function') response = response(calls);
    if (typeof response === 'string') response = { stdout: response };
    if (!response) response = {};
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
    child.kill = signal => {
      child.kills.push(signal);
      if (!response.ignoreKill) queueMicrotask(() => child.emit('close', null));
      return true;
    };
    processes.push(child);
    queueMicrotask(() => {
      if (response.error) { child.emit('error', response.error); return; }
      if (response.stdout) child.stdout.write(response.stdout);
      for (const chunk of response.chunks || []) child.stdout.write(chunk);
      if (response.stderr) child.stderr.write(response.stderr);
      if (!response.hang) child.emit('close', response.code ?? 0);
    });
    return child;
  };
  return { calls, processes, adapter: createProtonVpn({ spawn: fakeSpawn, platform: 'linux', env: {}, ...options }) };
}

const expectCode = code => error => {
  assert.equal(error.name, 'ProtonVpnError'); assert.equal(error.code, code); return true;
};

const BACKGROUND_AGENT_ERROR = 'exception calling callback for <Future>\nTraceback (most recent call last):\n' +
  '  File "localagent_mixin.py", line 99, in _handle_future_result\n' +
  'proton.vpn.platform.local_agent.LocalAgentError: private-user@example.com secret-token 192.0.2.40\n';
test('recognized background agent stderr preserves explicit connected status and bounded sanitized diagnostics', async () => {
  const cli = fakeCli({ status: { stdout: CONNECTED, stderr: BACKGROUND_AGENT_ERROR } });
  for (let i = 0; i < 55; i++) {
    const state = await cli.adapter.getStatus();
    assert.equal(state.state, 'connected'); assert.equal(state.diagnostics[0].reason, 'background-agent-error');
    assert.equal(state.diagnostics[0].operation, 'status'); assert.equal(state.diagnostics[0].exitCode, 0);
    assert.ok(!JSON.stringify(state).includes('private-user'));
  }
  const diagnostics = cli.adapter.getDiagnostics(); assert.equal(diagnostics.length, 50);
  assert.ok(!JSON.stringify(diagnostics).includes('secret-token')); assert.ok(!JSON.stringify(diagnostics).includes('192.0.2.40'));
  assert.equal(cli.calls.filter(call => call.args[0] === 'connect' && !call.args.includes('--help')).length, 0);
});
test('arbitrary, conflicting, fatal, or unsuccessful status output is not excused as a background warning', async () => {
  for (const response of [
    { stdout: CONNECTED, stderr: BACKGROUND_AGENT_ERROR, code: 1 },
    { stdout: DISCONNECTED, stderr: BACKGROUND_AGENT_ERROR },
    { stdout: CONNECTED, stderr: 'Traceback (most recent call last):\nRuntimeError: private detail' },
    { stdout: CONNECTED, stderr: BACKGROUND_AGENT_ERROR + 'Error: Authentication failed' },
    { stdout: CONNECTED, stderr: BACKGROUND_AGENT_ERROR + 'Status: Disconnected' },
    { stdout: CONNECTED + DISCONNECTED, stderr: BACKGROUND_AGENT_ERROR },
  ]) {
    const cli = fakeCli({ status: response });
    await assert.rejects(cli.adapter.getStatus(), error => error instanceof ProtonVpnError);
  }
});
test('a late process close releases the adapter guard without recreating it or repeating an outstanding mutation', async () => {
  let ready = false;
  const cli = fakeCli({ connect: () => ready ? 'Connected.' : { hang: true, ignoreKill: true } }, { connectTimeoutMs: 10, killGraceMs: 5 });
  await assert.rejects(cli.adapter.connect(), error => error.code === 'TIMEOUT' && error.terminationConfirmed === false);
  assert.equal(cli.adapter.getProcessState().blocked, true);
  const count = cli.calls.length; await assert.rejects(cli.adapter.connect(), expectCode('PROCESS_UNCONFIRMED'));
  assert.equal(cli.calls.length, count);
  ready = true; cli.processes.find(process => process.kills.length).emit('close', null);
  assert.equal(cli.adapter.getProcessState().blocked, false);
  assert.equal((await cli.adapter.connect()).state, 'connected');
});

test('discovers official CLI version, command list, and advertised selectors', () => {
  assert.equal(CAPS.version, '1.0.5');
  assert.equal(CAPS.commands.status, true);
  assert.deepEqual(CAPS.selectors, { server: true, country: true, city: true, random: true });
  assert.equal(parseCapabilities(ROOT_HELP).selectorsKnown, false);
  assert.throws(() => parseCapabilities('Usage: protonvpn-cli COMMAND'), expectCode('UNSUPPORTED_CLI'));
});

test('normalizes ANSI/CRLF status and optional numeric fields', () => {
  const status = parseStatus(`\x1b[32m${CONNECTED.replaceAll('\n', '\r\n')}\x1b[0m`);
  assert.deepEqual(status, {
    state: 'connected', server: { id: 'CH#242', location: 'Zurich, Switzerland', loadPercent: 36, protocol: 'wireguard' },
  });
  assert.equal(parseStatus(DISCONNECTED).state, 'disconnected');
  assert.equal(parseStatus(CONNECTED.replace('36%', '200%')).server.loadPercent, null);
  assert.equal(parseStatus(CONNECTED.replace('Zurich, Switzerland', 'Zürich, Switzerland')).state, 'connected');
  assert.equal(parseStatus(CONNECTED.replace('Zurich, Switzerland', 'Sarajevo, Bosnia & Herzegovina')).state, 'connected');
  assert.equal(parseStatus(CONNECTED.replace('Zurich, Switzerland', 'Abidjan, Côte d’Ivoire')).state, 'connected');
});

test('unknown, conflicting, and error-containing output never proves a connection', () => {
  for (const output of ['You are online', 'Status: Connecting', 'Status: Connected',
    CONNECTED + DISCONNECTED, CONNECTED + '\nError: failure',
    CONNECTED.replace('CH#242', 'secret@example.com'), DISCONNECTED + 'Server: CH#242 in Switzerland']) {
    assert.equal(parseStatus(output).state, 'unknown');
  }
});

test('validates targets and rejects options, shell text, credentials, and mixed selections', () => {
  assert.deepEqual(normalizeTarget({ server: ' ch-us#23 ' }), { server: 'CH-US#23' });
  assert.deepEqual(normalizeTarget({ country: ' us ', city: 'New York', random: true }), { country: 'US', city: 'New York', random: true });
  for (const target of [null, [], { server: '--help' }, { country: '--random' }, { country: 'US; echo secret' },
    { city: 'New\nYork' }, { server: 'US#1', country: 'US' }, { random: 'yes' }, { password: 'secret' }]) {
    assert.throws(() => normalizeTarget(target), expectCode('INVALID_SELECTION'));
  }
});

test('preferred selection skips excluded servers and fails on an exhausted pool', () => {
  assert.deepEqual(selectPreferredTarget({ servers: ['CH#1', 'CH#2'], excludeServers: ['ch#1'] }, CAPS), { server: 'CH#2' });
  assert.deepEqual(selectPreferredTarget({ countries: ['de'] }, CAPS), { country: 'DE' });
  assert.deepEqual(selectPreferredTarget({}, CAPS), {});
  assert.throws(() => selectPreferredTarget({ servers: ['CH#1'], excludeServers: ['CH#1'] }, CAPS), expectCode('NO_CANDIDATES'));
  assert.throws(() => selectPreferredTarget({ servers: ['CH#1'] }, { selectors: {} }), expectCode('NO_CANDIDATES'));
});

test('read-only diagnostics report installation/authentication without exposing username', async () => {
  const { adapter, calls } = fakeCli();
  const result = await adapter.diagnose();
  assert.equal(result.ready, true); assert.equal(result.installed, true);
  assert.equal(result.authentication, 'signed-in'); assert.equal(result.status.state, 'connected');
  assert.ok(!JSON.stringify(result).includes('private-user'));
  assert.deepEqual(calls.map(call => call.args), [['--help'], ['connect', '--help'], ['info'], ['status']]);
  assert.ok(calls.every(call => call.options.shell === false && call.options.env.LC_ALL === 'C' && call.options.stdio[0] === 'ignore'));
  const caps = await adapter.inspect(); caps.commands.connect = false;
  assert.equal((await adapter.inspect()).commands.connect, true);
});

test('signed-out diagnostics retain installation and offer one-time sign-in instructions', async () => {
  const { adapter } = fakeCli({ info: "Account: 'None'" });
  const result = await adapter.diagnose();
  assert.equal(result.ready, false); assert.equal(result.installed, true);
  assert.equal(result.authentication, 'signed-out'); assert.equal(result.diagnostics[0].code, 'AUTH_REQUIRED');
  assert.match(result.diagnostics[0].action, /protonvpn signin/);
});

test('missing executable and unsupported platform produce actionable diagnostics', async () => {
  const missing = fakeCli({ '--help': { error: Object.assign(new Error('private path'), { code: 'ENOENT' }) } });
  assert.equal((await missing.adapter.diagnose()).diagnostics[0].code, 'CLI_MISSING');
  assert.equal((await missing.adapter.diagnose()).installed, false);
  const unsupported = fakeCli({}, { platform: 'win32' });
  assert.equal((await unsupported.adapter.diagnose()).diagnostics[0].code, 'UNSUPPORTED_PLATFORM');
  assert.equal(unsupported.calls.length, 0);
});

test('detects GUI conflicts even with exit code zero and does not cache incomplete inspection', async () => {
  const cli = fakeCli({ 'connect --help': { stdout: GUI_ERROR, code: 0 } });
  const result = await cli.adapter.diagnose();
  assert.equal(result.installed, true); assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0].code, 'GUI_CONFLICT');
  await cli.adapter.inspect();
  assert.equal(cli.calls.filter(call => call.args[0] === '--help').length, 2);
});

for (const [label, output, code] of [
  ['session D-Bus', 'Traceback (most recent call last):\n dbus_fast.message_bus\nPermissionError: Operation not permitted', 'SESSION_UNAVAILABLE'],
  ['system service', 'org.freedesktop.DBus.Error.ServiceUnknown: org.freedesktop.NetworkManager unavailable', 'SERVICE_UNAVAILABLE'],
  ['Proton daemon', 'Error: proton-vpn-daemon is not running', 'SERVICE_UNAVAILABLE'],
  ['keyring', 'SecretServiceNotAvailable: keyring locked', 'KEYRING_UNAVAILABLE'],
  ['authentication', 'Error: Authentication required. Please sign in.', 'AUTH_REQUIRED'],
  ['plan selection', 'Error: Location selection is not available on the free plan.', 'PLAN_RESTRICTED'],
  ['unavailable server', 'Error: Invalid server ID. Please use a valid server ID.', 'SERVER_UNAVAILABLE'],
  ['failed connection', 'Error: Connection failed. Try connecting to a different server.', 'CONNECTION_FAILED'],
  ['network', 'Error: Network connectivity issues detected.', 'NETWORK_ERROR'],
  ['extra authentication', 'Error: 2FA Required: You are connected to the VPN, but all traffic is blocked.', 'VPN_2FA_REQUIRED'],
]) {
  test(`classifies ${label} failure and redacts raw diagnostics`, async () => {
    const { adapter } = fakeCli({ status: { stderr: `${output}\npassword=secret token=abc https://mega.nz/file/id#private-key user@example.com`, code: 1 } });
    await assert.rejects(adapter.getStatus(), error => {
      expectCode(code)(error);
      assert.ok(!JSON.stringify(error).includes('private-key'));
      assert.ok(!error.stack.includes('password=secret'));
      return true;
    });
  });
}

test('server directory exposes the actual CLI link without inventing an enumerable list', async () => {
  assert.deepEqual(await fakeCli().adapter.getServerDirectory(), {
    kind: 'external-directory', url: SERVER_DIRECTORY_URL, automatedEnumeration: false,
  });
  await assert.rejects(fakeCli({ servers: 'New output format' }).adapter.getServerDirectory(), expectCode('UNKNOWN_OUTPUT'));
});

test('connect uses separate arguments and confirms status rather than trusting success text/IP', async () => {
  const { adapter, calls } = fakeCli();
  const result = await adapter.connect({ server: 'ch#242' });
  assert.equal(result.state, 'connected'); assert.equal(Object.hasOwn(result, 'trafficVerified'), false);
  assert.equal(Object.hasOwn(result, 'publicIp'), false);
  assert.deepEqual(calls.slice(-2).map(call => call.args), [['connect', 'CH#242'], ['status']]);
  const cityCli = fakeCli();
  await cityCli.adapter.connect({ country: 'US', city: 'New York', random: true });
  assert.deepEqual(cityCli.calls.at(-2).args, ['connect', '--country', 'US', '--city', 'New York', '--random']);
});

test('connect does not fall back silently on plan/server errors or capability loss', async () => {
  const cli = fakeCli({ connect: { stderr: 'Error: Server selection by ID is not available on the free plan.', code: 2 } });
  await assert.rejects(cli.adapter.connect({ server: 'CH#242' }), expectCode('PLAN_RESTRICTED'));
  assert.equal(cli.calls.filter(call => call.args[0] === 'connect' && call.args[1] !== '--help').length, 1);
  const noRandom = fakeCli({ 'connect --help': CONNECT_HELP.replace('  --random        Connect to random available server\n', '') });
  await assert.rejects(noRandom.adapter.connect({ random: true }), expectCode('CAPABILITY_UNAVAILABLE'));
  assert.ok(noRandom.calls.every(call => call.args.includes('--help')));
  const noStatus = fakeCli({ '--help': ROOT_HELP.replace('  status      Show current VPN connection status.\n', '') });
  await assert.rejects(noStatus.adapter.connect(), expectCode('CAPABILITY_UNAVAILABLE'));
  assert.ok(noStatus.calls.every(call => call.args.includes('--help')));
});

test('connect rejects disconnected/unknown status and a mismatched explicit server', async () => {
  await assert.rejects(fakeCli({ status: DISCONNECTED }).adapter.connect(), expectCode('CONNECTION_UNVERIFIED'));
  await assert.rejects(fakeCli({ status: 'All good!' }).adapter.connect(), expectCode('CONNECTION_UNVERIFIED'));
  await assert.rejects(fakeCli().adapter.connect({ server: 'DE#1' }), expectCode('SERVER_MISMATCH'));
});

test('disconnect also verifies the resulting state', async () => {
  assert.equal((await fakeCli({ status: DISCONNECTED }).adapter.disconnect()).state, 'disconnected');
  await assert.rejects(fakeCli().adapter.disconnect(), expectCode('DISCONNECT_UNVERIFIED'));
});

test('fastest retries once after a completed CLI connection failure and confirmed disconnection', async () => {
  let attempts = 0;
  const progress = [];
  const cli = fakeCli({ connect: () => ++attempts === 1 ? { stdout: 'Error: Connection failed.', code: 1 } : 'Connected.',
    status: () => attempts < 2 ? DISCONNECTED : CONNECTED }, { retryDelayMs: 1 });
  assert.equal((await cli.adapter.connect({}, { onProgress: item => progress.push(item) })).state, 'connected');
  assert.equal(attempts, 2);
  assert.deepEqual(cli.calls.filter(call => call.args[0] === 'connect' && !call.args.includes('--help')).map(call => call.args), [['connect'], ['connect']]);
  assert.deepEqual(progress.map(item => item.phase), ['connecting', 'retrying', 'connecting']);
  assert.match(progress[1].message, /fastest available.*attempt 1 of 2.*disconnected.*Retrying fastest available/s);
});

test('two failed fastest attempts explain selection, actual CLI timeout, exit status and resulting state', async () => {
  const cli = fakeCli({ connect: { stdout: 'Error: Connection failed. token=private', code: 1 }, status: DISCONNECTED }, {
    retryDelayMs: 1, diagnostics: { begin: () => ({}), finish: () => ({ server: 'KH#3', timeoutSeconds: 10, secret: 'never-forward' }) },
  });
  await assert.rejects(cli.adapter.connect(), error => {
    assert.equal(error.code, 'CONNECTION_FAILED'); assert.match(error.message, /fastest available.*timed out after 10 seconds.*attempt 2 of 2.*disconnected/);
    assert.match(error.action, /CLI exit code: 1.*CLI-selected server: KH#3/);
    assert.ok(!JSON.stringify(error).includes('never-forward')); assert.ok(!JSON.stringify(error).includes('token=private'));
    assert.ok(!error.action.includes('Choose another server')); return true;
  });
  assert.equal(cli.calls.filter(call => call.args.length === 1 && call.args[0] === 'connect').length, 2);
});

test('explicit selections and recovery calls do not silently gain extra connection attempts', async () => {
  for (const [target, options] of [[{ server: 'CH#242' }, {}], [{ country: 'CH' }, {}], [{ random: true }, {}], [{}, { retryFastest: false }]]) {
    const cli = fakeCli({ connect: { stdout: 'Error: Connection failed.', code: 1 }, status: DISCONNECTED }, { retryDelayMs: 1 });
    await assert.rejects(cli.adapter.connect(target, options), expectCode('CONNECTION_FAILED'));
    assert.equal(cli.calls.filter(call => call.args[0] === 'connect' && !call.args.includes('--help')).length, 1);
  }
});

test('fastest never retries ambiguous state, generic failures, authentication errors or an outer deadline', async () => {
  for (const [response, status, expected] of [
    [{ stdout: 'Error: Connection failed.', code: 1 }, CONNECTED, 'CONNECTION_FAILED'],
    [{ stdout: 'Error: Connection failed.', code: 1 }, 'Unknown status', 'CONNECTION_FAILED'],
    [{ stdout: 'Error: Connection failed.', code: 1 }, { stdout: 'Error: Authentication required.', code: 1 }, 'CONNECTION_FAILED'],
    [{ stdout: 'Unexpected private failure', code: 1 }, DISCONNECTED, 'COMMAND_FAILED'],
    [{ stdout: 'Error: Authentication required.', code: 1 }, DISCONNECTED, 'AUTH_REQUIRED'],
    [{ hang: true }, DISCONNECTED, 'TIMEOUT'],
  ]) {
    const cli = fakeCli({ connect: response, status }, { retryDelayMs: 1, connectTimeoutMs: 10 });
    await assert.rejects(cli.adapter.connect(), expectCode(expected));
    assert.equal(cli.calls.filter(call => call.args.length === 1 && call.args[0] === 'connect').length, 1);
  }
});

test('canceling fastest during its retry wait prevents the second command', async () => {
  const abort = new AbortController();
  const cli = fakeCli({ connect: { stdout: 'Error: Connection failed.', code: 1 }, status: DISCONNECTED }, { retryDelayMs: 10000 });
  const work = cli.adapter.connect({}, { signal: abort.signal, onProgress(item) { if (item.phase === 'retrying') abort.abort(); } });
  await assert.rejects(work, expectCode('CANCELED'));
  assert.equal(cli.calls.filter(call => call.args.length === 1 && call.args[0] === 'connect').length, 1);
});

test('disconnect reconciles the installed CLI\'s successful teardown followed by exit 1', async () => {
  const cli = fakeCli({ disconnect: { stdout: 'Disconnected.\n', code: 1 }, status: DISCONNECTED });
  assert.equal((await cli.adapter.disconnect()).state, 'disconnected');
  assert.equal(cli.calls.filter(call => call.args[0] === 'disconnect').length, 1);
  assert.equal(cli.calls.at(-1).args[0], 'status');
});

test('a failed disconnect cannot succeed on connected, unknown, or inaccessible status', async () => {
  for (const status of [CONNECTED, 'All good!']) {
    await assert.rejects(fakeCli({ disconnect: { stdout: 'Disconnected.', code: 1 }, status }).adapter.disconnect(), expectCode('DISCONNECT_UNVERIFIED'));
  }
  await assert.rejects(fakeCli({ disconnect: { code: 1 }, status: { stderr: 'Error: Authentication required.', code: 1 } }).adapter.disconnect(), expectCode('AUTH_REQUIRED'));
});

test('disconnect reconciliation does not swallow classified failures, cancellation, or timeout', async () => {
  const failure = fakeCli({ disconnect: { stdout: GUI_ERROR, code: 1 }, status: DISCONNECTED });
  await assert.rejects(failure.adapter.disconnect(), expectCode('GUI_CONFLICT'));
  assert.equal(failure.calls.some(call => call.args[0] === 'status'), false);
  const timeout = fakeCli({ disconnect: { stdout: 'Disconnected.', hang: true }, status: DISCONNECTED }, { connectTimeoutMs: 5 });
  await assert.rejects(timeout.adapter.disconnect(), expectCode('TIMEOUT'));
  assert.equal(timeout.calls.some(call => call.args[0] === 'status'), false);
  const canceled = fakeCli({ disconnect: { stdout: 'Disconnected.', hang: true }, status: DISCONNECTED });
  await canceled.adapter.inspect();
  const abort = new AbortController(); const work = canceled.adapter.disconnect({ signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await assert.rejects(work, expectCode('CANCELED'));
  assert.equal(canceled.calls.some(call => call.args[0] === 'status'), false);
});

test('timeout terminates the child and returns a typed error', async () => {
  const cli = fakeCli({ status: { hang: true } }, { timeoutMs: 15 });
  await assert.rejects(cli.adapter.getStatus(), expectCode('TIMEOUT'));
  assert.deepEqual(cli.processes.at(-1).kills, ['SIGTERM']);
});

test('a coordinator can configure the process deadline per command without adding a Proton CLI flag', async () => {
  const cli = fakeCli({ connect: { hang: true } }, { connectTimeoutMs: 30000 });
  await cli.adapter.inspect();
  await assert.rejects(cli.adapter.connect({ server: 'CH#242' }, { connectTimeoutMs: 5, retryFastest: false }), error => {
    assert.equal(error.code, 'TIMEOUT'); assert.equal(error.terminationConfirmed, true); return true;
  });
  assert.deepEqual(cli.calls.at(-1).args, ['connect', 'CH#242']);
  assert.deepEqual(cli.processes.at(-1).kills, ['SIGTERM']);
  const count = cli.calls.length;
  await assert.rejects(cli.adapter.connect({ server: 'CH#242' }, { connectTimeoutMs: 0 }), TypeError);
  assert.equal(cli.calls.length, count);
});

test('completed connection failures carry termination evidence for the retry coordinator', async () => {
  const cli = fakeCli({ connect: { stdout: 'Error: Invalid server ID.', code: 1 } });
  await assert.rejects(cli.adapter.connect({ server: 'CH#242' }), error => {
    assert.equal(error.code, 'SERVER_UNAVAILABLE'); assert.equal(error.terminationConfirmed, true); return true;
  });
});

test('runtime process errors wait for closure and unconfirmed errors prevent later commands', async () => {
  for (const ignoreKill of [false, true]) {
    const cli = fakeCli({ connect: { error: Object.assign(new Error('private runtime failure'), { code: 'EIO' }), ignoreKill } }, { killGraceMs: 5 });
    await assert.rejects(cli.adapter.connect({ server: 'CH#242' }), error => {
      assert.equal(error.code, 'COMMAND_FAILED'); assert.equal(error.terminationConfirmed, !ignoreKill);
      assert.ok(!JSON.stringify(error).includes('private runtime')); return true;
    });
    assert.deepEqual(cli.processes.find(child => child.kills.length)?.kills, ignoreKill ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM']);
    if (ignoreKill) {
      const count = cli.calls.length;
      await assert.rejects(cli.adapter.getStatus(), expectCode('PROCESS_UNCONFIRMED'));
      assert.equal(cli.calls.length, count);
    }
  }
});

test('the retry coordinator works with adapter process cleanup and actual parsed CLI status', async () => {
  const { createVpnRetryEngine } = require('./vpn-retry');
  const { parseCatalog } = require('./vpn-catalog');
  let selected = null;
  const cli = fakeCli({ connect: calls => {
    selected = calls.at(-1).args[1];
    return selected === 'CH#241' ? { stdout: 'Error: Connection failed.', code: 1 } : 'Connected.';
  }, status: () => selected === 'CH#242' ? CONNECTED : DISCONNECTED });
  const engine = createVpnRetryEngine({ adapter: cli.adapter });
  const result = await engine.runRound({ catalog: parseCatalog('Switzerland,Zurich,CH#241\nSwitzerland,Zurich,CH#242\n'),
    selection: { order: 'file-order' }, retry: { initialDelayMs: 0 } });
  assert.equal(result.outcome, 'connected'); assert.equal(result.status.server.id, 'CH#242');
  assert.deepEqual(cli.calls.filter(call => call.args[0] === 'connect' && call.args[1] !== '--help').map(call => call.args),
    [['connect', 'CH#241'], ['connect', 'CH#242']]);
});

test('uncooperative child receives SIGKILL after timeout', async () => {
  const cli = fakeCli({ status: { hang: true, ignoreKill: true } }, { timeoutMs: 10, killGraceMs: 10 });
  await assert.rejects(cli.adapter.getStatus(), expectCode('TIMEOUT'));
  assert.deepEqual(cli.processes.at(-1).kills, ['SIGTERM', 'SIGKILL']);
  const callCount = cli.calls.length;
  await assert.rejects(cli.adapter.connect(), expectCode('PROCESS_UNCONFIRMED'));
  assert.equal(cli.calls.length, callCount);
});

test('split UTF-8 pipe chunks retain the server location', async () => {
  const bytes = Buffer.from(CONNECTED.replace('Zurich', 'Zürich'));
  const boundary = bytes.indexOf(Buffer.from('ü')) + 1;
  const cli = fakeCli({ status: { chunks: [bytes.subarray(0, boundary), bytes.subarray(boundary)] } });
  assert.equal((await cli.adapter.getStatus()).server.location, 'Zürich, Switzerland');
});

test('unrecognized help and account output remain actionable unknown states', async () => {
  const cli = fakeCli({ 'connect --help': 'Help output has changed.' });
  const result = await cli.adapter.diagnose();
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0].code, 'UNKNOWN_OUTPUT');
  assert.equal(cli.calls.length, 2);
  await assert.rejects(fakeCli({ info: 'Identity: private-user@example.com' }).adapter.getAuthentication(), expectCode('UNKNOWN_OUTPUT'));
});

test('spawn permission failure is classified without exposing its original message', async () => {
  const cli = fakeCli({ '--help': { error: Object.assign(new Error('password=private'), { code: 'EACCES' }) } });
  const result = await cli.adapter.diagnose();
  assert.equal(result.diagnostics[0].code, 'CLI_PERMISSION');
  assert.ok(!JSON.stringify(result).includes('password=private'));
});

test('pre-aborted and active cancellation do not continue with later commands', async () => {
  const controller = new AbortController(); controller.abort();
  const pre = fakeCli();
  await assert.rejects(pre.adapter.connect({}, { signal: controller.signal }), expectCode('CANCELED'));
  assert.equal(pre.calls.length, 0);
  const active = new AbortController();
  const cli = fakeCli({ connect: { hang: true } });
  await cli.adapter.inspect();
  const promise = cli.adapter.connect({}, { signal: active.signal });
  await new Promise(resolve => setImmediate(resolve));
  active.abort();
  await assert.rejects(promise, expectCode('CANCELED'));
  assert.ok(!cli.calls.some(call => call.args[0] === 'status'));
  assert.deepEqual(cli.processes.at(-1).kills, ['SIGTERM']);
});

test('output limit terminates instead of parsing an incomplete response', async () => {
  const cli = fakeCli({ status: { stdout: CONNECTED + 'x'.repeat(3000), hang: true } }, { maxOutputBytes: 2000 });
  await assert.rejects(cli.adapter.getStatus(), expectCode('OUTPUT_LIMIT'));
  assert.deepEqual(cli.processes.at(-1).kills, ['SIGTERM']);
});

test('overlapping mutations are rejected and lock is released after cancellation', async () => {
  const cli = fakeCli({ connect: { hang: true } });
  await cli.adapter.inspect();
  const controller = new AbortController();
  const pending = cli.adapter.connect({}, { signal: controller.signal });
  await assert.rejects(cli.adapter.disconnect(), expectCode('BUSY'));
  controller.abort(); await assert.rejects(pending, expectCode('CANCELED'));
  await assert.rejects(cli.adapter.disconnect(), expectCode('DISCONNECT_UNVERIFIED'));
});

test('real harmless subprocesses exercise missing executable, pipe output, and timeout cleanup', async () => {
  await assert.rejects(createProtonVpn({ executable: '/tmp/m3-proton-cli-does-not-exist', platform: 'linux' }).inspect(), expectCode('CLI_MISSING'));
  const children = [];
  const adapter = createProtonVpn({ platform: 'linux', timeoutMs: 3000, killGraceMs: 100,
    spawn: (_executable, args, options) => {
      const output = args[0] === '--help' ? ROOT_HELP : CONNECT_HELP;
      const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', output], options);
      children.push(child); return child;
    },
  });
  assert.equal((await adapter.inspect()).version, '1.0.5');
  const hanging = createProtonVpn({ platform: 'linux', timeoutMs: 30, killGraceMs: 100,
    spawn: (_executable, _args, options) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      children.push(child); return child;
    },
  });
  await assert.rejects(hanging.inspect(), expectCode('TIMEOUT'));
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});
