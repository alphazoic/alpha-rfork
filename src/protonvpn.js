'use strict';

const { spawn: systemSpawn } = require('child_process');
const { StringDecoder } = require('node:string_decoder');
const { createCliLogDiagnostics } = require('./protonvpn-log');

const SERVER_DIRECTORY_URL = 'https://account.proton.me/vpn/WireGuard';
const MESSAGES = {
  UNSUPPORTED_PLATFORM: ['Proton VPN integration requires Linux.', 'Run this integration in a Linux desktop session.'],
  CLI_MISSING: ['The Proton VPN CLI was not found.', 'Install the official Proton VPN Linux CLI using Proton’s distribution packages.'],
  CLI_PERMISSION: ['The Proton VPN CLI could not be executed.', 'Check executable permissions and the configured CLI path.'],
  UNSUPPORTED_CLI: ['This executable is not a recognized official Proton VPN CLI.', 'Use the current official Linux CLI, rather than the legacy community client.'],
  GUI_CONFLICT: ['The Proton VPN desktop app is running.', 'Close Proton’s GUI before using its CLI through M3.'],
  SESSION_UNAVAILABLE: ['The desktop D-Bus session is unavailable or inaccessible.', 'Run M3 as your desktop user in a session with accessible D-Bus services.'],
  SERVICE_UNAVAILABLE: ['A required VPN system service is unavailable.', 'Check NetworkManager and the services supplied by the official Proton VPN installation.'],
  KEYRING_UNAVAILABLE: ['Proton’s credential keyring is unavailable or locked.', 'Unlock your desktop keyring and run M3 as the user who signed into Proton.'],
  AUTH_REQUIRED: ['Proton VPN is not signed in.', 'Sign in once in a desktop terminal using protonvpn signin <username>, then retry.'],
  AUTH_FAILED: ['Proton VPN authentication failed.', 'Check your Proton session by signing in again using the official CLI.'],
  VPN_2FA_REQUIRED: ['The tunnel requires additional authentication and traffic is blocked.', 'Complete Proton’s requested security-key authentication before continuing.'],
  PLAN_RESTRICTED: ['Your Proton plan does not permit the requested selection.', 'Use the default fastest connection or choose a plan that supports server selection.'],
  SERVER_UNAVAILABLE: ['No available server matches the requested selection.', 'Choose another server or broaden the location selection.'],
  NETWORK_ERROR: ['Proton VPN encountered a network connection error.', 'Check network access and retry when connectivity is restored.'],
  CONNECTION_FAILED: ['Proton’s CLI reported that its connection attempt failed.', 'M3 has not verified a working tunnel. Check the connection details below.'],
  INVALID_SELECTION: ['The VPN server selection is invalid.', 'Choose a server ID, a country/city, or the default fastest connection.'],
  CAPABILITY_UNAVAILABLE: ['The installed CLI does not expose the required capability.', 'Check the installed CLI version and available commands.'],
  UNKNOWN_OUTPUT: ['The CLI response could not be verified.', 'Check the installed CLI version; M3 will treat this state as unknown.'],
  CONNECTION_UNVERIFIED: ['The CLI did not confirm a connected tunnel after connecting.', 'Check Proton VPN status before retrying.'],
  DISCONNECT_UNVERIFIED: ['The CLI did not confirm disconnection.', 'Check Proton VPN status before retrying.'],
  SERVER_MISMATCH: ['The connected server differs from the requested server.', 'Check Proton VPN status and choose another server if necessary.'],
  NO_CANDIDATES: ['No eligible preferred server or country remains.', 'Adjust the preferred pool or wait before retrying excluded servers.'],
  BUSY: ['A VPN connection command is already running.', 'Wait for the current command to finish.'],
  TIMEOUT: ['The Proton VPN command exceeded its time limit.', 'Check Proton’s services before retrying.'],
  CANCELED: ['The Proton VPN command was canceled.', ''],
  OUTPUT_LIMIT: ['The Proton VPN command produced excessive output.', 'Check the CLI installation and retry.'],
  PROCESS_UNCONFIRMED: ['A previous VPN command could not be confirmed terminated.', 'Check the outstanding CLI process before creating a new adapter or retrying.'],
  COMMAND_FAILED: ['The Proton VPN command failed.', 'Check the official CLI in a desktop terminal for more information.'],
};

// Public errors deliberately contain no raw output, command arguments, usernames,
// URLs, tokens, or Python tracebacks. Consumers can safely log code/message/action.
class ProtonVpnError extends Error {
  constructor(code, operation = null, exitCode = null) {
    const [message, action] = MESSAGES[code] || MESSAGES.COMMAND_FAILED;
    super(message);
    this.name = 'ProtonVpnError';
    this.code = code;
    this.action = action;
    this.operation = operation;
    this.exitCode = exitCode;
  }
}

function cleanOutput(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').trim();
}

function outputErrorCode(output) {
  const s = cleanOutput(output);
  if (/2FA Required:|connected to the VPN, but all traffic is blocked/i.test(s)) return 'VPN_2FA_REQUIRED';
  if (/desktop app is currently running|CLI and GUI cannot run simultaneously/i.test(s)) return 'GUI_CONFLICT';
  if (/keyring.*(?:locked|unavailable|error)|(?:locked|unavailable).*keyring|SecretServiceNotAvailable|KeyringError/i.test(s)) return 'KEYRING_UNAVAILABLE';
  if (/org\.freedesktop\.(?:NetworkManager|systemd)|proton.*daemon.*(?:not running|unavailable)|ServiceUnknown|NameHasNoOwner/i.test(s)) return 'SERVICE_UNAVAILABLE';
  if (/DBUS_SESSION_BUS_ADDRESS|session (?:D-Bus|bus).*unavailable|dbus_fast|Cannot autolaunch D-Bus|Failed to connect to (?:the )?(?:session )?bus/i.test(s)) return 'SESSION_UNAVAILABLE';
  if (/not available on the free plan|requires? (?:a )?(?:paid|higher).*plan|RequiresHigherTierError/i.test(s)) return 'PLAN_RESTRICTED';
  if (/Authentication required|AuthenticationRequiredError|not signed in|not logged in|please sign in/i.test(s)) return 'AUTH_REQUIRED';
  if (/Authentication failed|AuthenticationFailedError|session was invalidated/i.test(s)) return 'AUTH_FAILED';
  if (/No servers found|Invalid server ID|no servers available|ServerNotFoundError/i.test(s)) return 'SERVER_UNAVAILABLE';
  if (/Connection failed|VPNConnectionError/i.test(s)) return 'CONNECTION_FAILED';
  if (/Network connectivity issues|ProtonAPINotReachable|ECONNRESET|ETIMEDOUT|network.*(?:unreachable|unavailable)/i.test(s)) return 'NETWORK_ERROR';
  if (/Unknown action|No such (?:command|option)/i.test(s)) return 'CAPABILITY_UNAVAILABLE';
  if (/^Error:|Traceback \(most recent call last\)|unexpected error occurred/im.test(s)) return 'COMMAND_FAILED';
  return null;
}

// Proton's background agent callback can fail after status has already been
// printed. Only this recognized stderr traceback may accompany usable status;
// arbitrary errors, contradictory status, and failed commands still fail.
function isBackgroundAgentDiagnostic(stderr) {
  const text = cleanOutput(stderr);
  return outputErrorCode(text) === 'COMMAND_FAILED' &&
    /Traceback \(most recent call last\)/.test(text) &&
    /exception calling callback|Exception in callback|_handle_future_result/i.test(text) &&
    /^(?:[\w.]+\.)?LocalAgentError:[^\n]*$/m.test(text) &&
    !/^Error:|^Status:|^Server:|unexpected error occurred/im.test(text) &&
    !text.split('\n').some(line => /^(?:[\w.]+\.)?\w*(?:Error|Exception):/.test(line) && !/^(?:[\w.]+\.)?LocalAgentError:/.test(line));
}

const SERVER_ID = /^[A-Z]{2}(?:-[A-Z0-9]+)?#\d+$/i;

function parseStatus(output) {
  const text = cleanOutput(output);
  const unknown = { state: 'unknown', server: null };
  if (outputErrorCode(text)) return unknown;
  const states = [...text.matchAll(/^Status:\s*(Connected|Disconnected)\s*$/gim)];
  if (states.length !== 1 || [...text.matchAll(/^Status:/gim)].length !== 1) return unknown;
  if (states[0][1].toLowerCase() === 'disconnected') {
    if (/^Server:/im.test(text)) return unknown;
    return { state: 'disconnected', server: null };
  }
  const servers = [...text.matchAll(/^Server:\s*(\S+)\s+in\s+(.+)$/gim)];
  if (servers.length !== 1 || !SERVER_ID.test(servers[0][1])) return unknown;
  const location = servers[0][2].trim();
  if (location.length > 160 || !/^[\p{L}\p{M}\d ,.'&’()-]+$/u.test(location)) return unknown;
  const load = text.match(/^Load:\s*(\d+(?:\.\d+)?)%\s*$/im);
  const protocol = text.match(/^Protocol:\s*([a-z0-9-]+)\s*$/im);
  return {
    state: 'connected',
    server: {
      id: servers[0][1].toUpperCase(), location,
      loadPercent: load && Number(load[1]) <= 100 ? Number(load[1]) : null,
      protocol: protocol ? protocol[1].toLowerCase() : null,
    },
  };
}

function parseCapabilities(rootHelp, connectHelp = '') {
  const root = cleanOutput(rootHelp);
  if (!/Proton VPN command-line interface for Linux\./i.test(root)) throw new ProtonVpnError('UNSUPPORTED_CLI', 'inspect');
  const version = root.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/);
  const section = root.split(/^Commands:\s*$/m)[1]?.split(/^\S/m)[0] || '';
  const commands = Object.fromEntries(['info', 'status', 'connect', 'disconnect', 'servers', 'countries', 'cities', 'config']
    .map(name => [name, new RegExp(`^\\s+${name}\\s+`, 'm').test(section)]));
  const help = cleanOutput(connectHelp);
  const selectorsKnown = /^Usage:.*\bconnect\b/im.test(help) && !outputErrorCode(help);
  const options = help.split(/^Options:\s*$/m)[1]?.split(/^\S/m)[0] || '';
  return {
    version: version ? version[1] : null, commands, selectorsKnown,
    selectors: {
      server: selectorsKnown && /^Usage:.*\[SERVER_NAME\]/im.test(help),
      country: selectorsKnown && /^\s+--country\b/m.test(options),
      city: selectorsKnown && /^\s+--city\b/m.test(options),
      random: selectorsKnown && /^\s+--random\b/m.test(options),
    },
  };
}

function normalizeTarget(target = {}) {
  if (!target || typeof target !== 'object' || Array.isArray(target) ||
      Object.keys(target).some(key => !['server', 'country', 'city', 'random'].includes(key))) {
    throw new ProtonVpnError('INVALID_SELECTION');
  }
  const result = {};
  for (const key of ['server', 'country', 'city']) {
    if (target[key] === undefined) continue;
    if (typeof target[key] !== 'string') throw new ProtonVpnError('INVALID_SELECTION');
    const value = target[key].trim();
    const valid = key === 'server' ? SERVER_ID.test(value) : /^[\p{L}][\p{L}\p{M}\d .'-]{0,79}$/u.test(value);
    if (!valid) throw new ProtonVpnError('INVALID_SELECTION');
    result[key] = key === 'server' || (key === 'country' && value.length === 2) ? value.toUpperCase() : value;
  }
  if (target.random !== undefined && typeof target.random !== 'boolean') throw new ProtonVpnError('INVALID_SELECTION');
  if (target.random) result.random = true;
  if (result.server && (result.country || result.city || result.random)) throw new ProtonVpnError('INVALID_SELECTION');
  return result;
}

function selectPreferredTarget(pool = {}, capabilities) {
  if (!pool || typeof pool !== 'object' || Array.isArray(pool) ||
      Object.keys(pool).some(key => !['servers', 'countries', 'excludeServers'].includes(key))) {
    throw new ProtonVpnError('INVALID_SELECTION');
  }
  const { servers = [], countries = [], excludeServers = [] } = pool;
  for (const list of [servers, countries, excludeServers]) {
    if (!Array.isArray(list) || list.length > 100) throw new ProtonVpnError('INVALID_SELECTION');
  }
  const normalizedServers = servers.map(server => normalizeTarget({ server }).server);
  const normalizedCountries = countries.map(country => normalizeTarget({ country }).country);
  const excluded = new Set(excludeServers.map(server => normalizeTarget({ server }).server));
  if (normalizedServers.length && capabilities?.selectors?.server) {
    const server = normalizedServers.find(id => !excluded.has(id));
    if (server) return { server };
  }
  if (normalizedCountries.length && capabilities?.selectors?.country) return { country: normalizedCountries[0] };
  if (!normalizedServers.length && !normalizedCountries.length && !excluded.size) return {};
  throw new ProtonVpnError('NO_CANDIDATES', 'select');
}

function positiveInteger(value, fallback) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number <= 0 || number > 2147483647) throw new TypeError('Invalid adapter process limit.');
  return number;
}

function selectionLabel(target) {
  if (target.server) return 'server ' + target.server;
  const place = target.city || target.country;
  return (target.random ? 'random available' : 'fastest available') + (place ? ' in ' + place : '');
}

function explainConnectFailure(error, target, facts, state, attempt, maxAttempts) {
  let server = null;
  try { if (facts?.server) server = normalizeTarget({ server: facts.server }).server; } catch { /* no raw log fields */ }
  const seconds = Number.isSafeInteger(facts?.timeoutSeconds) && facts.timeoutSeconds > 0 && facts.timeoutSeconds <= 300 ? facts.timeoutSeconds : null;
  const selection = selectionLabel(target);
  error.message = seconds ? `Proton’s ${selection} connection timed out after ${seconds} seconds` :
    `Proton’s CLI reported a connection failure for ${selection}`;
  error.message += ` (attempt ${attempt} of ${maxAttempts}). ` +
    (state === 'disconnected' ? 'Proton reports disconnected.' : state === 'connected' ? 'Proton still reports connected; M3 has not verified the resulting connection.' : 'M3 could not determine the resulting VPN state.');
  error.action = 'Command: protonvpn connect. ' + (Number.isInteger(error.exitCode) ? `CLI exit code: ${error.exitCode}. ` : '') +
    (server ? `CLI-selected server: ${server}. ` : '') + 'Use Check setup / status to refresh the observed state.';
  error.connection = { selection, state, attempt, maxAttempts, ...(server ? { server } : {}), ...(seconds ? { timeoutSeconds: seconds } : {}) };
  return error;
}

function createProtonVpn({ executable = 'protonvpn', spawn = systemSpawn, platform = process.platform,
  env = process.env, timeoutMs, statusRefreshTimeoutMs, connectTimeoutMs, maxOutputBytes, killGraceMs, retryDelayMs = 1500, diagnostics, onTerminalEvent } = {}) {
  if (typeof executable !== 'string' || !executable || executable.startsWith('-') || /[\x00-\x1f]/.test(executable)) {
    throw new TypeError('Invalid Proton CLI executable.');
  }
  const limits = {
    timeout: positiveInteger(timeoutMs, 15000), statusRefreshTimeout: positiveInteger(statusRefreshTimeoutMs, 90000), connectTimeout: positiveInteger(connectTimeoutMs, 90000),
    output: positiveInteger(maxOutputBytes, 256 * 1024), grace: positiveInteger(killGraceMs, 500),
  };
  let cachedCapabilities = null;
  let mutationRunning = false;
  let terminalSequence = 0;
  let closing = false, shutdownPromise = null, cliAvailable = false;
  const shutdownToken = Symbol('shutdown'), tasks = new Set(), running = new Set();
  function tracked(fn) {
    return (...args) => {
      if (closing) return Promise.reject(new ProtonVpnError('CANCELED'));
      const promise = fn(...args); tasks.add(promise);
      promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
      return promise;
    };
  }
  const unconfirmedProcesses = new Set(), commandDiagnostics = [];
  function recordDiagnostic(error) {
    commandDiagnostics.push({ time: Date.now(), ...toDiagnostic(error) });
    if (commandDiagnostics.length > 50) commandDiagnostics.shift();
  }
  const retryDelay = positiveInteger(retryDelayMs, 1500);
  const connectionLog = diagnostics || (spawn === systemSpawn ? createCliLogDiagnostics({ env }) : null);

  function pause(signal) {
    if (signal?.aborted) return Promise.reject(new ProtonVpnError('CANCELED', 'connect'));
    return new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new ProtonVpnError('CANCELED', 'connect')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, retryDelay);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  function run(args, { signal, timeout = limits.timeout, onDiagnostic, allowStatusRefresh = false, shutdownToken: token } = {}) {
    if (platform !== 'linux') return Promise.reject(new ProtonVpnError('UNSUPPORTED_PLATFORM', args[0]));
    if (closing && token !== shutdownToken) return Promise.reject(new ProtonVpnError('CANCELED', args[0]));
    if (signal?.aborted) return Promise.reject(new ProtonVpnError('CANCELED', args[0]));
    if (unconfirmedProcesses.size) return Promise.reject(new ProtonVpnError('PROCESS_UNCONFIRMED', args[0]));
    return new Promise((resolve, reject) => {
      let child, timer, killTimer, finalTimer, done = false, stopping = null;
      let bytes = 0;
      const stdoutChunks = [], stderrChunks = [];
      const operation = args.includes('--help') ? 'inspect' : args[0];
      let deadlineMs = timeout, refreshNotice = '', refreshExtended = false;
      const commandId = ++terminalSequence, startedAt = Date.now();
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      let observedBytes = 0, outputOmitted = false;
      const observe = (kind, text, details = {}) => {
        try { onTerminalEvent?.({ commandId, kind, text, time: Date.now(), elapsedMs: Date.now() - startedAt, ...details }); } catch { /* diagnostic observer only */ }
      };
      observe('cmd', [executable, ...args].join(' '), { phase: 'start', deadlineMs: timeout });
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finalTimer);
        signal?.removeEventListener('abort', onAbort);
        running.delete(cancelForShutdown);
        observe('m3', `Command ${error ? error.code : 'completed'} · elapsed ${Date.now() - startedAt}ms`, { phase: 'result', code: error?.code || null });
        if (error) { recordDiagnostic(error); reject(error); } else resolve(value);
      };
      const stop = code => {
        if (done || stopping) return;
        stopping = new ProtonVpnError(code, operation);
        observe('m3', `${code === 'TIMEOUT' ? 'Deadline exceeded (' + deadlineMs + 'ms)' : code}${observedBytes ? '' : ' · no stdout or stderr received'}`, { phase: 'stop', code });
        try { observe('m3', 'Sending SIGTERM'); child.kill('SIGTERM'); } catch { /* still try SIGKILL below */ }
        if (done) return;
        killTimer = setTimeout(() => {
          try { observe('m3', 'Sending SIGKILL'); child.kill('SIGKILL'); } catch { /* bounded completion below */ }
          if (!done) finalTimer = setTimeout(() => {
            // A bounded error is not proof that the CLI stopped. Prevent another
            // command from overlapping a process that may still change routes.
            unconfirmedProcesses.add(child);
            stopping.terminationConfirmed = false;
            observe('m3', 'Process termination unconfirmed; further Proton commands are blocked.', { phase: 'unconfirmed' });
            finish(stopping);
          }, limits.grace);
        }, limits.grace);
      };
      const onAbort = () => stop('CANCELED');
      const cancelForShutdown = () => stop('CANCELED');
      running.add(cancelForShutdown);
      const processError = error => {
        const failure = stopping || new ProtonVpnError(
          error.code === 'ENOENT' ? 'CLI_MISSING' : ['EACCES', 'EPERM'].includes(error.code) ? 'CLI_PERMISSION' : 'COMMAND_FAILED', operation);
        observe('m3', 'Process error: ' + String(error.message || error.code || 'Unknown process error'), { phase: 'process-error' });
        // A failed spawn creates no running process. Other child errors do not
        // prove closure and must follow the same termination handshake.
        if (!child || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) && !child.pid) {
          observe('m3', 'Proton process could not start.', { phase: 'spawn-failed' });
          failure.terminationConfirmed = true; finish(failure);
        } else stop('COMMAND_FAILED');
      };
      try {
        child = spawn(executable, args, {
          shell: false, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...env, LC_ALL: 'C', LANG: 'C', TERM: 'dumb', NO_COLOR: '1' },
        });
        if (child.pid) cliAvailable = true;
      } catch (error) { processError(error); return; }
      const capture = stream => data => {
        // Observe before parsing and keep observing shutdown/late output. This
        // bounded diagnostic path never changes the command's existing parser.
        if (onTerminalEvent && observedBytes < 1024 * 1024) {
          const buffer = Buffer.from(data), available = 1024 * 1024 - observedBytes;
          const text = decoders[stream].write(buffer.subarray(0, available));
          observedBytes += buffer.length;
          if (text) observe(stream, text);
          if (buffer.length > available) { outputOmitted = true; observe('m3', 'Further output omitted: 1 MiB per-command diagnostic limit reached.'); }
        } else if (onTerminalEvent && !outputOmitted) {
          outputOmitted = true; observe('m3', 'Further output omitted: 1 MiB per-command diagnostic limit reached.');
        }
        if (done || stopping) return;
        // Official CLI 1.0.5 refreshes its expired catalog even for `status`.
        // Permit that explicitly announced work once, with an absolute ceiling.
        // An explicit caller/round timeout is never extended.
        if (operation === 'status' && allowStatusRefresh && !refreshExtended && stream === 'stdout') {
          refreshNotice += data.toString('utf8');
          if (/(?:^|\n)Server list is outdated, updating\.\.\. This may take a moment\.(?:\r?\n|$)/.test(refreshNotice)) {
            refreshExtended = true;
            if (limits.statusRefreshTimeout > deadlineMs) {
              deadlineMs = limits.statusRefreshTimeout;
              clearTimeout(timer); timer = setTimeout(() => stop('TIMEOUT'), Math.max(1, deadlineMs - (Date.now() - startedAt)));
              observe('m3', `Proton is refreshing its server list; status deadline extended to ${deadlineMs / 1000}s from command start.`, { phase: 'deadline', deadlineMs });
            }
          }
          refreshNotice = refreshNotice.slice(-256);
        }
        bytes += Buffer.byteLength(data);
        if (bytes > limits.output) { stop('OUTPUT_LIMIT'); return; }
        (stream === 'stdout' ? stdoutChunks : stderrChunks).push(Buffer.from(data));
      };
      child.stdout?.on('data', capture('stdout'));
      child.stderr?.on('data', capture('stderr'));
      child.once('error', processError);
      child.once('close', (code, closeSignal) => {
        if (code === 0) cliAvailable = true;
        for (const stream of ['stdout', 'stderr']) { const tail = decoders[stream].end(); if (tail) observe(stream, tail); }
        observe('m3', `Process closed · exit ${code ?? 'none'}${closeSignal ? ' · signal ' + closeSignal : ''} · elapsed ${Date.now() - startedAt}ms`,
          { phase: 'close', exitCode: code, signal: closeSignal || null });
        // The promise may already have returned a bounded cleanup error. A late
        // close is still authoritative evidence that future commands are safe.
        unconfirmedProcesses.delete(child);
        if (done) return;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const errorCode = outputErrorCode(`${stdout}\n${stderr}`);
        if (stopping) { stopping.terminationConfirmed = true; finish(stopping); }
        else if (code === 0 && operation === 'status' && isBackgroundAgentDiagnostic(stderr) && parseStatus(stdout).state === 'connected') {
          const diagnostic = new ProtonVpnError('COMMAND_FAILED', operation, code);
          diagnostic.reason = 'background-agent-error';
          recordDiagnostic(diagnostic);
          try { onDiagnostic?.(toDiagnostic(diagnostic)); } catch { /* observer only */ }
          finish(null, cleanOutput(stdout));
        }
        else if (errorCode || code !== 0) {
          const error = new ProtonVpnError(errorCode || 'COMMAND_FAILED', operation, code);
          error.reason = isBackgroundAgentDiagnostic(stderr) ? 'background-agent-error' : errorCode ? 'cli-error-output' : 'process-exit';
          error.terminationConfirmed = true; finish(error);
        }
        else finish(null, cleanOutput(stdout));
      });
      timer = setTimeout(() => stop('TIMEOUT'), timeout);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async function inspect(options = {}) {
    const { signal, refresh = false } = options;
    if (signal?.aborted) throw new ProtonVpnError('CANCELED', 'inspect');
    if (cachedCapabilities && !refresh) return structuredClone(cachedCapabilities);
    const root = await run(['--help'], { signal, shutdownToken: options.shutdownToken });
    let capabilities = parseCapabilities(root);
    const diagnostics = [];
    if (capabilities.commands.connect) {
      try {
        capabilities = parseCapabilities(root, await run(['connect', '--help'], { signal, shutdownToken: options.shutdownToken }));
        if (!capabilities.selectorsKnown) diagnostics.push(toDiagnostic(new ProtonVpnError('UNKNOWN_OUTPUT', 'inspect')));
      }
      catch (error) {
        if (error.code === 'CANCELED') throw error;
        diagnostics.push(toDiagnostic(error));
      }
    }
    const result = { ...capabilities, diagnostics };
    // Cache only complete discovery. Session/setup problems must be rechecked.
    if (capabilities.selectorsKnown) cachedCapabilities = result;
    return structuredClone(result);
  }

  async function requireCommand(name, options) {
    const capabilities = await inspect(options);
    if (!capabilities.commands[name]) throw new ProtonVpnError('CAPABILITY_UNAVAILABLE', name);
    return capabilities;
  }

  async function getStatus(options = {}) {
    await requireCommand('status', options);
    const diagnostics = [];
    const status = parseStatus(await run(['status'], { ...options, allowStatusRefresh: options.timeout === undefined, onDiagnostic: item => diagnostics.push(item) }));
    return diagnostics.length ? { ...status, diagnostics } : status;
  }

  async function getAuthentication(options = {}) {
    await requireCommand('info', options);
    const info = await run(['info'], options);
    const account = info.match(/^Account:\s*'([^'\n]*)'\s*$/m);
    if (!account) throw new ProtonVpnError('UNKNOWN_OUTPUT', 'info');
    // Return only authentication state, never the account name.
    return { state: !account[1] || /^(None|null)$/i.test(account[1]) ? 'signed-out' : 'signed-in' };
  }

  async function getServerDirectory(options = {}) {
    await requireCommand('servers', options);
    const text = await run(['servers'], options);
    if (!text.includes(SERVER_DIRECTORY_URL)) throw new ProtonVpnError('UNKNOWN_OUTPUT', 'servers');
    return { kind: 'external-directory', url: SERVER_DIRECTORY_URL, automatedEnumeration: false };
  }

  async function mutate(name, target, options) {
    if (mutationRunning) throw new ProtonVpnError('BUSY', name);
    mutationRunning = true;
    try {
      // This bounds M3's child process only. It does not change the official
      // CLI's internal connection wait. Coordinators disable the old fastest
      // retry and own candidate/round limits themselves.
      const commandTimeout = positiveInteger(options.connectTimeoutMs, limits.connectTimeout);
      const capabilities = await requireCommand(name, options);
      const args = [name];
      if (name === 'connect') {
        for (const key of Object.keys(target)) {
          if (!capabilities.selectors[key]) throw new ProtonVpnError('CAPABILITY_UNAVAILABLE', name);
        }
        if (target.server) args.push(target.server);
        if (target.country) args.push('--country', target.country);
        if (target.city) args.push('--city', target.city);
        if (target.random) args.push('--random');
      }
      // Status support is required before making a change we could not verify.
      if (!capabilities.commands.status) throw new ProtonVpnError('CAPABILITY_UNAVAILABLE', name);
      const maxAttempts = name === 'connect' && !Object.keys(target).length && options.retryFastest !== false ? 2 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const token = name === 'connect' ? connectionLog?.begin() : null;
        if (name === 'connect') options.onProgress?.({ phase: 'connecting', attempt, maxAttempts,
          message: `Connecting using ${selectionLabel(target)} (attempt ${attempt} of ${maxAttempts})…` });
        try {
          await run(args, { signal: options.signal, timeout: commandTimeout, shutdownToken: options.shutdownToken });
        } catch (error) {
          if (name === 'connect' && ['CONNECTION_FAILED', 'COMMAND_FAILED'].includes(error.code) && Number.isInteger(error.exitCode)) {
            const facts = connectionLog?.finish(token) || {};
            let observed = 'unknown';
            try { observed = (await getStatus({ signal: options.signal })).state; }
            catch (statusError) { if (options.signal?.aborted || statusError.code === 'CANCELED') throw new ProtonVpnError('CANCELED', name); }
            explainConnectFailure(error, target, facts, observed, attempt, maxAttempts);
            if (error.code === 'CONNECTION_FAILED' && observed === 'disconnected' && attempt < maxAttempts) {
              options.onProgress?.({ phase: 'retrying', attempt: attempt + 1, maxAttempts,
                message: error.message + ` Retrying fastest available (attempt ${attempt + 1} of ${maxAttempts})…` });
              await pause(options.signal); continue;
            }
            throw error;
          }
          // Official CLI 1.0.5 can print "Disconnected." then exit 1 during
          // asynchronous cleanup. A completed process's generic failure is not
          // proof the tunnel stayed connected. Verify the postcondition below;
          // never override cancellation, timeout, auth/session errors, or a child
          // whose termination was not confirmed. Do not repeat the mutation.
          if (name !== 'disconnect' || error.code !== 'COMMAND_FAILED' || !Number.isInteger(error.exitCode)) throw error;
        }
        const status = await getStatus({ signal: options.signal, shutdownToken: options.shutdownToken });
        if (name === 'connect') {
          if (status.state !== 'connected' || target.server && status.server.id !== target.server) {
            const error = new ProtonVpnError(status.state !== 'connected' ? 'CONNECTION_UNVERIFIED' : 'SERVER_MISMATCH', name);
            error.terminationConfirmed = true;
            throw error;
          }
        } else if (status.state !== 'disconnected') throw new ProtonVpnError('DISCONNECT_UNVERIFIED', name);
        return status;
      }
    } finally { mutationRunning = false; }
  }

  async function diagnose(options = {}) {
    const result = {
      installed: false, version: null, capabilities: null, ready: false,
      authentication: 'unknown', status: { state: 'unknown', server: null },
      environment: { sessionBusAddressPresent: Boolean(env.DBUS_SESSION_BUS_ADDRESS) }, diagnostics: [],
    };
    try {
      result.capabilities = await inspect({ ...options, refresh: true });
      result.installed = true;
      result.version = result.capabilities.version;
      result.diagnostics.push(...result.capabilities.diagnostics);
      if (result.diagnostics.length) return result;
      const auth = await getAuthentication(options);
      result.authentication = auth.state;
      if (auth.state === 'signed-out') throw new ProtonVpnError('AUTH_REQUIRED', 'info');
      result.status = await getStatus(options);
      if (result.status.state === 'unknown') throw new ProtonVpnError('UNKNOWN_OUTPUT', 'status');
      result.ready = Boolean(result.capabilities.commands.connect && result.capabilities.commands.disconnect &&
        result.capabilities.commands.status && result.capabilities.selectorsKnown);
      if (!result.ready) throw new ProtonVpnError('CAPABILITY_UNAVAILABLE', 'inspect');
    } catch (error) {
      if (error.code === 'CANCELED') throw error;
      if (error.code === 'AUTH_REQUIRED') result.authentication = 'signed-out';
      result.diagnostics.push(toDiagnostic(error));
    }
    return result;
  }

  function shutdown({ signal, requireDisconnect = true } = {}) {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      // Cancel status/discovery/connect operations and wait for their bounded
      // cleanup before issuing the final mutation on this same adapter.
      for (const stop of [...running]) stop();
      await Promise.allSettled([...tasks]);
      if (unconfirmedProcesses.size) throw new ProtonVpnError('PROCESS_UNCONFIRMED', 'disconnect');
      if (platform !== 'linux') return { state: 'unsupported' };
      try { return await mutate('disconnect', null, { signal, shutdownToken }); }
      catch (error) {
        // Proton is optional on installations that never used/configured it.
        if (error.code === 'CLI_MISSING' && !cliAvailable && !requireDisconnect) return { state: 'not-installed' };
        throw error;
      }
    })();
    shutdownPromise.then(() => { shutdownPromise = null; }, () => { shutdownPromise = null; });
    return shutdownPromise;
  }

  return {
    inspect: tracked(inspect), diagnose: tracked(diagnose), getStatus: tracked(getStatus),
    getAuthentication: tracked(getAuthentication), getServerDirectory: tracked(getServerDirectory), shutdown,
    getProcessState: () => ({ blocked: unconfirmedProcesses.size > 0 }),
    getDiagnostics: () => structuredClone(commandDiagnostics),
    connect: tracked(async (target = {}, options = {}) => mutate('connect', normalizeTarget(target), options)),
    disconnect: tracked((options = {}) => mutate('disconnect', null, options)),
    selectPreferredTarget: tracked(async (pool, options = {}) => selectPreferredTarget(pool, await inspect(options))),
  };
}

function toDiagnostic(error) {
  const known = error instanceof ProtonVpnError;
  const safe = new ProtonVpnError(known && Object.hasOwn(MESSAGES, error.code) ? error.code : 'COMMAND_FAILED');
  const operation = known && ['inspect', 'status', 'connect', 'disconnect', 'info', 'servers', 'select'].includes(error.operation) ? error.operation : null;
  const result = { code: safe.code, message: safe.message, action: safe.action, operation };
  if (known && Number.isInteger(error.exitCode)) result.exitCode = error.exitCode;
  if (known && ['background-agent-error', 'cli-error-output', 'process-exit'].includes(error.reason)) result.reason = error.reason;
  else result.reason = safe.code;
  if (safe.code === 'COMMAND_FAILED' && operation) {
    result.message = result.reason === 'background-agent-error' ? `Proton’s ${operation} command reported a background agent error.` :
      `Proton’s ${operation} command reported an error${result.exitCode === 0 ? ' despite exiting with code 0' : ''}.`;
  }
  if (known && error.connection?.server) {
    try { result.protonSelectedServer = normalizeTarget({ server: error.connection.server }).server; } catch { /* no raw fields */ }
  }
  const seconds = known ? error.connection?.timeoutSeconds : null;
  if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 300) {
    result.protonTimeoutSeconds = seconds;
    result.message = `Proton's CLI connection wait timed out after ${seconds} seconds.`;
  }
  return result;
}

module.exports = { createProtonVpn, ProtonVpnError, parseStatus, parseCapabilities,
  normalizeTarget, selectPreferredTarget, toDiagnostic, SERVER_DIRECTORY_URL };
