(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RforkSettings = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MiB = 1048576;
  const number = (key, label, value, min = 0, max = Number.MAX_SAFE_INTEGER, extra = {}) =>
    ({ key, label, value, type: 'number', min, max, ...extra });
  const toggle = (key, label, value, extra = {}) => ({ key, label, value, type: 'boolean', ...extra });
  const fields = [
    number('workers', 'Workers per file', 8, 1, 20, { integer: true, basic: true, help: 'Usually 5–12. More workers do not necessarily increase speed.' }),
    toggle('https', 'HTTPS', true, { basic: true, help: 'Required for restart/resume. Ordinary uploads can use HTTP for comparison.' }),
    toggle('bundling', 'Bundle upload requests (boost)', false, { basic: true, help: 'Groups native chunks into larger requests. Native encryption chunks stay unchanged.' }),
    number('bundleSizeMiB', 'Maximum bundled request (MiB)', 4, 1, 64, { bytes: true, basic: true, help: 'Remembered when boost is off. Actual requests can be smaller.' }),
    number('pacingMs', 'Data-request pacing (ms)', 10, 0, 2147483647, { help: '0 disables the delay between data requests, including retries.' }),
    number('dataRetries', 'Additional data retries (-1 inherits)', -1, -1, 2147483647, { integer: true, help: '0 disables extra attempts. Never repeats an uncertain final commit.' }),
    toggle('retryBodyErrors', 'Replay incomplete response bodies', false, { help: 'Opt-in ciphertext replay within the data retry budget.' }),
    toggle('diagnostics', 'Collect upload diagnostics', false, { help: 'Safe aggregate counters in the upload log; no upload URLs or keys.' }),
    number('bandwidthMiB', 'Payload bandwidth cap (MiB/s)', 0, 0, Number.MAX_SAFE_INTEGER / MiB, { bytes: true, help: '0 is unlimited. Per rfork process; excludes repeated wire traffic.' }),
    number('readBufferMiB', 'Source read buffer (MiB)', 16, 0, Number.MAX_SAFE_INTEGER / MiB, { bytes: true, help: 'Ordinary uploads only. Not a worker socket or request buffer.' }),
    number('maxConnections', 'Maximum backend requests (0 unlimited)', 0, 0, 2147483647, { integer: true }),
    number('tpsLimit', 'HTTP requests per second (0 unlimited)', 0),
    number('tpsBurst', 'HTTP request burst', 1, 1, 2147483647, { integer: true }),
    number('connectTimeoutSeconds', 'Connection timeout (seconds)', 20, 0.001, 2147483647),
    number('idleTimeoutSeconds', 'Network idle timeout (seconds)', 60, 0.001, 2147483647),
    number('stallSeconds', 'Upload no-progress watchdog (seconds)', 90, 0, 2147483647, { help: '0 disables it. Applies during ordinary data transfer, not local preparation or finalization. Resume uses its I/O and attempt limits.' }),
    number('maxDurationSeconds', 'Maximum attempt duration (seconds)', 0, 0, 2147483647, { help: '0 is unlimited. Includes resume source verification.' }),
    number('maxTransferMiB', 'Maximum attempt payload (MiB)', 0, 0, Number.MAX_SAFE_INTEGER / MiB, { bytes: true, help: '0 is unlimited. Resume counts pending bytes. Reaching a limit holds the destination for inspection.' }),
    { key: 'cutoffMode', label: 'Payload cutoff mode', type: 'select', value: 'hard', options: ['hard', 'soft', 'cautious'] },
    toggle('http2', 'Allow HTTP/2', true),
    toggle('keepAlive', 'Reuse HTTP connections', true),
    number('statsSeconds', 'Progress update interval (seconds)', 1, 0.001, 2147483647),
    toggle('resume', 'Keep restart checkpoints', false, { recovery: true, help: 'New local-file transfers only. Existing names are refused. Retained transfers keep their identity even if this is turned off.' }),
    number('checkpointIntervalSeconds', 'Checkpoint flush interval (seconds)', 1, 0, 2147483647, { recovery: true, help: '0 flushes coalesced progress immediately. Longer intervals reduce writes but may repeat more data after a crash.' }),
    { key: 'checkpointRoot', label: 'Private checkpoint location', type: 'string', value: '', recovery: true, help: 'Blank uses M3’s private local profile. Choose a private local directory; Windows requires fixed local NTFS. Existing transfers keep their original locations.' },
  ].map(Object.freeze);
  function normalizeRforkSettings(input = {}) {
    const fail = detail => { throw new Error('rfork: ' + detail); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('settings must be an object');
    if (input.schemaVersion !== undefined && input.schemaVersion !== 1) fail('unsupported settings version');
    for (const key of Object.keys(input)) if (key !== 'schemaVersion' && !fields.some(f => f.key === key)) fail('unknown setting ' + key);
    const out = { schemaVersion: 1 };
    for (const f of fields) {
      const value = input[f.key] === undefined ? f.value : input[f.key];
      if (f.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < f.min || value > f.max ||
          (f.integer && !Number.isSafeInteger(value)) || (f.bytes && !Number.isSafeInteger(value * MiB))) fail(f.label + ' is outside its valid range');
      } else if (f.type === 'boolean' ? typeof value !== 'boolean' : f.type === 'select' ? !f.options.includes(value) : typeof value !== 'string' || value.includes('\0')) fail('invalid ' + f.label);
      out[f.key] = value;
    }
    if (out.resume && !out.https) fail('restart/resume requires HTTPS');
    return Object.freeze(out);
  }
  function rforkArgs(input, { resume = false } = {}) {
    const s = normalizeRforkSettings(input);
    if (resume && !s.https) throw new Error('rfork: restart/resume requires HTTPS');
    const bytes = n => String(n * MiB) + 'B';
    const args = [
      '--mega-use-https=' + s.https, '--mega-upload-concurrency', String(s.workers),
      '--mega-upload-request-size', s.bundling ? bytes(s.bundleSizeMiB) : '0',
      '--mega-upload-pacing', s.pacingMs + 'ms', '--mega-upload-retries', String(s.dataRetries),
      '--mega-upload-retry-body-errors=' + s.retryBodyErrors, '--mega-upload-diagnostics=' + s.diagnostics,
      '--retries', '1', '--low-level-retries', '1', '--transfers', '1',
      '--bwlimit', bytes(s.bandwidthMiB), '--max-connections', String(s.maxConnections),
      '--tpslimit', String(s.tpsLimit), '--tpslimit-burst', String(s.tpsBurst),
      '--contimeout', s.connectTimeoutSeconds + 's', '--timeout', s.idleTimeoutSeconds + 's',
      '--max-duration', s.maxDurationSeconds + 's', '--cutoff-mode', s.cutoffMode,
      '--disable-http2=' + !s.http2, '--disable-http-keep-alives=' + !s.keepAlive,
      '--use-json-log', '--stats', s.statsSeconds + 's', '--stats-log-level', 'NOTICE',
    ];
    if (!resume) args.push('--buffer-size', bytes(s.readBufferMiB));
    if (s.maxTransferMiB) args.push('--max-transfer', bytes(s.maxTransferMiB));
    return args;
  }
  function effectiveRforkSettings(input, { resume = false } = {}) {
    const { checkpointRoot, ...settings } = normalizeRforkSettings(input);
    return { ...settings, resume: resume || settings.resume,
      requestSizeBytes: settings.bundling ? settings.bundleSizeMiB * MiB : 0,
      ...(resume || settings.resume ? { readBufferMiB: null } : {}) };
  }
  function summarizeRforkSettings(input) {
    const s = normalizeRforkSettings(input);
    const request = s.bundling ? s.bundleSizeMiB : 1;
    return `${s.workers} workers; ${s.https ? 'HTTPS' : 'HTTP'}; ${s.bundling ? 'requests up to ' + request + ' MiB' : 'native requests'}; pacing ${s.pacingMs} ms; data retries ${s.dataRetries === -1 ? 'inherit (1)' : s.dataRetries}; ${s.resume ? 'restart checkpoints' : 'ordinary upload'}. Request buffers up to ${(s.workers + 1) * request} MiB + ${s.workers} MiB encryption scratch; source buffers, MACs, fingerprints and runtime are additional.`;
  }
  return { fields: Object.freeze(fields), normalizeRforkSettings, rforkArgs, effectiveRforkSettings, summarizeRforkSettings };
});
