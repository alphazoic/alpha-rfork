'use strict';
const { megaToolPath } = require('./mega-paths');

const network = require('./network-operations');

const fs            = require('fs');
const path          = require('path');
const { spawnNetwork: spawn }     = require('./network-operations');

const { loadConfig, getImportCsv, getAccountCsv } = require('./config');
const { formatFileSize, parseCSVLine }             = require('./utils');
const { getBinPath }                               = require('../binPath');
const { ensureMegaCmdServer, megaSwitch, megaLogout,
  megaCmdBin, megaSpawnOpts, megaEnv,
  getMegacmdFileLink, importMegaLink }        = require('./megacmd');
  const { obscurePass, rcloneRemote }                = require('./rclone');
  const { runCommandWithTimeout, runCommand }        = require('./proc-utils');
  const { updateAccountRow, markSecurityUpgrade }    = require('./account-manager');

  // ── CSV logging ───────────────────────────────────────────────────────────────

  // Header for import_log.csv. Mirrors upload_log.csv's columns, with
  // "Last Login Date" renamed to "Import Date" since it's stamped at import
  // time rather than account-login time. File Link is generated via megacmd
  // right after the import completes (see doImportMegaLink).
  const IMPORT_CSV_HEADER = 'File Name,File Size,File Link,Folder Link,Email,Password,Import Date,Folder Name\n';

  // Escapes a CSV field per RFC 4180 — same convention used by upload-engine.js.
  function csvField(v) {
    const s = String(v ?? '');
    return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Appends one row to import_log.csv for a single imported file.
  // fileSize is in bytes. fileLink is the megacmd-generated public link for
  // the file (blank if it couldn't be generated). destFolder is the MEGAcmd
  // remote path the file was imported into (e.g. "/Movies/Action") — its
  // basename becomes Folder Name.
  function appendImportRow({ fileName, fileSize, fileLink, email, password, destFolder }) {
    const csvPath = getImportCsv();
    if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, IMPORT_CSV_HEADER, 'utf8');

    const sizeStr    = formatFileSize(fileSize);
    const now        = new Date().toLocaleString('sv').replace('T', ' ');
    const folderName = path.basename(destFolder || '') || 'Root';

    const row = [fileName, sizeStr, fileLink || '', '', email, password, now, folderName].map(csvField).join(',') + '\n';
    fs.appendFileSync(csvPath, row, 'utf8');
  }

  // ── Account tree building ─────────────────────────────────────────────────────
  //
  // Converts a flat list of { path, size, isDir } entries (paths relative to the
  // account root, e.g. "/Root/folder/file.mp4") into the tree format that the
  // View & Import renderer expects:
  //   { email, rootHandle, rootName, files: [{handle,name,size,parentHandle}], folders: [...] }
  //
  // 'handle' is the normalised full path — it doubles as a stable unique ID.

  function _buildAccountTree(entries, email) {
    const foldersMap = new Map();
    const files      = [];

    function ensureFolder(segments, depth) {
      const handle = '/' + segments.slice(0, depth + 1).join('/');
      if (!foldersMap.has(handle)) {
        const parentHandle = depth === 0 ? 'root' : '/' + segments.slice(0, depth).join('/');
        foldersMap.set(handle, { handle, name: segments[depth], parentHandle });
      }
      return handle;
    }

    for (const { path: filePath, size, isDir } of entries) {
      const segments = filePath.replace(/^\//, '').split('/').filter(Boolean);
      if (!segments.length) continue;
      // Ensure every ancestor folder node exists in the map
      const limit = isDir ? segments.length : segments.length - 1;
      for (let i = 0; i < limit; i++) ensureFolder(segments, i);
      if (!isDir) {
        const handle       = '/' + segments.join('/');
        const parentHandle = segments.length === 1 ? 'root' : '/' + segments.slice(0, -1).join('/');
        files.push({ handle, name: segments[segments.length - 1], size: size || 0, parentHandle });
      }
    }

    // A path can end up in both collections: once correctly inferred as a folder
    // and once again as a plain file if the source tool's own line for that same
    // path wasn't flagged as a directory. The inferred folder is always the
    // trustworthy one, so drop the duplicate.
    const dedupedFiles = files.filter(f => !foldersMap.has(f.handle));

    return {
      email,
      rootHandle: 'root',
      rootName:   'MEGA Drive',
      files:      dedupedFiles,
      folders:    Array.from(foldersMap.values()),
    };
  }

  // mega-exec find / output: one path per line, dirs end with '/'.
  // Sizes are not available from `find`; they show as 0.
  function _parseMegaCmdFind(out, email) {
    const entries = [];
    for (const line of out.split('\n').map(l => l.trim()).filter(Boolean)) {
      if (line === '/') continue;
      const isDir = line.endsWith('/');
      entries.push({ path: line.replace(/\/$/, ''), size: 0, isDir });
    }
    return _buildAccountTree(entries, email);
  }

  // megatools ls --long output (several variants exist across versions):
  //   <size>  <date> <time>  /Root/path
  //   [FD]  <size>  <date>   /Root/path
  //   /Root/path                         (plain ls, no --long)
  function _parseMegatoolsLs(out, email) {
    const entries = [];
    for (const line of out.split('\n').map(l => l.trim()).filter(Boolean)) {
      let size = 0, rawPath = '';
      let m;
      // Format: <digits> <date> <time> /Root/...
      m = line.match(/^(\d+)\s+\S+\s+\S+\s+(\/Root\S*)$/);
      if (m) { size = parseInt(m[1], 10); rawPath = m[2]; }
      // Format: [FDfd] <digits> <date> /Root/...
      if (!rawPath) {
        m = line.match(/^[FDfd]\s+(\d+)\s+\S+\s+(\/Root\S*)$/);
        if (m) { size = parseInt(m[1], 10); rawPath = m[2]; }
      }
      // Format: plain path only
      if (!rawPath) {
        m = line.match(/^(\/Root\S*)$/);
        if (m) rawPath = m[1];
      }
      if (!rawPath) continue;
      const isDir = rawPath.endsWith('/');
      entries.push({ path: rawPath.replace(/\/$/, ''), size: isDir ? 0 : size, isDir });
    }
    return _buildAccountTree(entries, email);
  }

  // rclone lsjson remote: --recursive output: JSON array of {Path, Name, Size, IsDir}
  function _parseRcloneLsjson(out, email) {
    let arr = [];
    try { arr = JSON.parse(out.trim()); } catch { /* malformed — leave arr empty */ }
    const entries = arr
    .filter(item => item.Path)
    .map(item => ({
      path:  '/' + item.Path.replace(/^\//, ''),
                  size:  item.IsDir ? 0 : (item.Size || 0),
                  isDir: Boolean(item.IsDir),
    }));
    return _buildAccountTree(entries, email);
  }

  // ── Import quota helpers ──────────────────────────────────────────────────────

  // Parses the relevant public identifiers out of a mega.nz URL.
  function _parseMegaPublicUrl(url) {
    // Direct file:              https://mega.nz/file/HANDLE#KEY
    let m = url.match(/mega\.nz\/file\/([^#?/\s]+)/);
    if (m) return { type: 'file', handle: m[1], folderHandle: null };
    // File inside public folder: https://mega.nz/folder/FOLDER#KEY/file/FILEHANDLE
    m = url.match(/mega\.nz\/folder\/([^#?/\s]+)[^/]*\/file\/([^#?/\s]+)/);
    if (m) return { type: 'folder-file', folderHandle: m[1], handle: m[2] };
    return null;
  }

  // ── Link classifier ───────────────────────────────────────────────────────────
  // Classifies a MEGA URL into one of four categories for Bulk Import's queue-analysis
  // step. Uses regex rather than parseUrl() because:
  //   1. Must never throw — invalid/unknown URLs return 'unknown' so the queue-analysis
  //      step can skip them gracefully rather than abort the entire run.
  //   2. Handles legacy formats (#! / #F!) without parseUrl's strict validation.
  //   3. These patterns must stay in sync with view-import.js's isSingleFileLink()
  //      so both renderer and backend classify every URL shape identically.
  function classifyMegaLink(url) {
    if (/mega\.nz\/file\/[^#?/\s]+/.test(url))                          return 'bare-file';
    if (/mega\.nz\/folder\/[^#?/\s]+[^/]*\/file\/[^#?/\s]+/.test(url)) return 'folder-file';
    if (/mega\.nz\/folder\/[^#?/\s]+/.test(url))                        return 'folder-root';
    if (/mega\.nz\/#(?!F!)![^!]+!/.test(url))                           return 'bare-file';   // legacy file
    if (/mega\.nz\/#F!/.test(url))                                       return 'folder-root'; // legacy folder
    return 'unknown';
  }

  // Queries MEGA's public API and returns the file's size in bytes, or null on failure.
  async function getMegaPublicFileSize(url) {
    const parsed = _parseMegaPublicUrl(url);
    if (!parsed) return null;
    try {
      const apiUrl = parsed.type === 'file'
      ? 'https://g.api.mega.co.nz/cs'
      : `https://g.api.mega.co.nz/cs?n=${parsed.folderHandle}`;
      const body = parsed.type === 'file'
      ? JSON.stringify([{ a: 'g', p: parsed.handle }])
      : JSON.stringify([{ a: 'g', g: 1, n: parsed.handle }]);
      const resp = await network.fetchNetwork(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const item = Array.isArray(data) ? data[0] : data;
      return typeof item?.s === 'number' ? item.s : null;
    } catch {
      return null;
    }
  }

  // Returns the current usage in KB for the given email from the account CSV.
  function _getAccountUsageKb(email) {
    try {
      const rows = fs.readFileSync(getAccountCsv(), 'utf8').trim().split('\n').slice(1);
      for (let i = rows.length - 1; i >= 0; i--) {
        const cols = parseCSVLine(rows[i]);
        if ((cols[0] || '').trim() === email) return (parseFloat(cols[2]) || 0) * 1024 * 1024; // GB → KB
      }
    } catch { /* non-fatal */ }
    return 0;
  }

  // Runs `mega-exec find <remotePath>` and returns the full remote paths of
  // every FILE (not folder) found under it. Used right after a folder import
  // ("Import All") to discover where each file actually landed — megacmd's
  // `import` may preserve the public folder's nested structure inside
  // destFolder rather than flattening everything directly into it, so we
  // can't assume a file ends up at destFolder/<name>.
  async function _findFilesUnderPath(remotePath) {
    try {
      const out = await runCommandWithTimeout(megaCmdBin(), ['find', remotePath], megaSpawnOpts(), 60000);
      return out.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !l.endsWith('/')); // directories end with '/' — files don't
    } catch {
      return [];
    }
  }

  // ── Exported IPC logic ────────────────────────────────────────────────────────

  // browse-account-files: log in to an account and return a file tree.
  // Tries tools in the order defined by cfg.toolOrderView.
  // NOTE: this switches the active MEGAcmd session — do not call while an upload
  // is in progress if that upload is also using megacmd.
  async function browseAccountFiles({ email, password }) {
    const cfg       = loadConfig();
    const toolOrder = (cfg.toolOrderView && cfg.toolOrderView.length)
    ? cfg.toolOrderView
    : ['megacmd', 'rclone', 'megatools'];

    let lastErr = null;

    for (const tool of toolOrder) {
      try {
        if (tool === 'megacmd') {
          await ensureMegaCmdServer();
          await megaSwitch(email, password);
          const out = await runCommandWithTimeout(megaCmdBin(), ['find', '/'], megaSpawnOpts(), 90000);
          await megaLogout();
          markSecurityUpgrade(email);
          return { ok: true, data: _parseMegaCmdFind(out, email), tool };

        } else if (tool === 'megatools') {
          const out = await runCommand(
            getBinPath('megatools'),
                                       ['ls', '--long', '-r', '-u', email, '-p', password],
                                       { stdio: 'pipe' }
          );
          return { ok: true, data: _parseMegatoolsLs(out, email), tool };

        } else if (tool === 'rclone') {
          const obscured = await obscurePass(password);
          const remote   = rcloneRemote(email, obscured);
          const out = await runCommand(
            getBinPath('rclone'),
                                       ['lsjson', `${remote}:`, '--recursive', '--no-modtime'],
                                       { stdio: 'pipe' }
          );
          return { ok: true, data: _parseRcloneLsjson(out, email), tool };
        }
      } catch (err) {
        network.interruption(err);
        lastErr = err;
      }
    }

    return { ok: false, error: lastErr?.message || 'All tools failed to list account files' };
  }

  // get-account-file-links: generate public share links for specific file paths.
  // `tool` should be the same tool used for browsing so path formats match.
  // Returns { ok, links: [{ path, url }] }
  async function getAccountFileLinks({ email, password, paths, tool }) {
    const cfg       = loadConfig();
    const viewOrder = (cfg.toolOrderView && cfg.toolOrderView.length)
    ? cfg.toolOrderView
    : ['megacmd', 'rclone', 'megatools'];
    // Start with the browse tool so path formats are most likely to match, then
    // fall back through the full configured order.
    const toolOrder = tool
    ? [tool, ...viewOrder.filter(t => t !== tool)]
    : viewOrder;

    // Normalize a file handle path for the target tool.
    // megatools paths have a /Root/ prefix; megacmd and rclone do not.
    function normPath(p, targetTool) {
      return megaToolPath(p, tool || 'megatools', targetTool);
    }

    for (const t of toolOrder) {
      try {
        if (t === 'megacmd') {
          await ensureMegaCmdServer();
          await megaSwitch(email, password);
          const links = [];
          for (const p of paths) {
            const url = await getMegacmdFileLink(normPath(p, 'megacmd'));
            links.push({ path: p, url: url || null });
          }
          await megaLogout();
          return { ok: true, links };

        } else if (t === 'rclone') {
          const obscured = await obscurePass(password);
          const links    = [];
          for (const p of paths) {
            try {
              const rPath = normPath(p, 'rclone');
              const out   = await runCommand(getBinPath('rclone'), [
                'link', `:mega:${rPath}`,
                '--mega-user', email,
                '--mega-pass', obscured,
              ], { stdio: 'pipe' });
              const url = out.split('\n').map(l => l.trim()).find(l => l.startsWith('https://'));
              links.push({ path: p, url: url || null });
            } catch { links.push({ path: p, url: null }); }
          }
          return { ok: true, links };

        } else if (t === 'megatools') {
          const links = [];
          for (const p of paths) {
            const mPath = normPath(p, 'megatools');
            const url = await new Promise(resolve => {
              const proc = spawn(getBinPath('megatools'), [
                'export', '-u', email, '-p', password, mPath,
              ], { stdio: ['ignore', 'pipe', 'pipe'] });
              let out = '';
              const onData = d => { out += d.toString(); };
              proc.stdout?.on('data', onData);
              proc.stderr?.on('data', onData);
              proc.on('error', () => resolve(null));
              proc.on('close', () => {
                const line = out.split('\n').map(l => l.trim()).find(l => l.startsWith('https://'));
                resolve(line || null);
              });
            });
            links.push({ path: p, url });
          }
          return { ok: true, links };
        }
      } catch (err) {
        network.interruption(err);
        // try next tool in order
      }
    }

    return { ok: false, error: 'No available tool could generate download links for these files' };
  }

  // check-import-quota: fetch all file sizes from MEGA's public API and verify the
  // total fits within the account's configured threshold before any import begins.
  async function checkImportQuota({ email, urls, sizes }) {
    const cfg                = loadConfig();
    const accountThresholdKb = (parseFloat(cfg.accountThresholdGb) || 19.5) * 1024 * 1024;
    const currentUsageKb     = _getAccountUsageKb(email);
    const availableKb        = accountThresholdKb - currentUsageKb;

    // Prefer sizes the renderer already knows from the folder tree it fetched when
    // the public link was opened. An isolated per-file 'g' lookup against MEGA's
    // public API (the fallback below) frequently fails to resolve a size for a
    // file inside a public folder without a preceding 'f' listing call, so we
    // only hit the network here when the caller couldn't supply sizes itself.
    const haveClientSizes = Array.isArray(sizes) && sizes.length === urls.length
    && sizes.every(s => typeof s === 'number' && Number.isFinite(s));

    const fileSizes   = haveClientSizes
    ? sizes
    : await Promise.all(urls.map(u => getMegaPublicFileSize(u)));
    const unknownUrls = urls.filter((_, i) => fileSizes[i] === null);
    if (unknownUrls.length > 0) {
      return {
        ok: false,
        error: `Could not determine the size of ${unknownUrls.length} file(s) from the MEGA API — import blocked to prevent exceeding account quota. Ensure the link(s) are valid and publicly accessible, then try again.`,
      };
    }
    const totalBytes = fileSizes.reduce((sum, s) => sum + s, 0);

    if (totalBytes / 1024 > availableKb) {
      const fmt = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(1) + ' MB';
      return {
        ok: false,
        error: `Not enough space: need ${fmt(totalBytes)} but only ${fmt(availableKb * 1024)} is available in this account (threshold: ${cfg.accountThresholdGb || 19.5} GB).`,
      };
    }

    return { ok: true, fileSizes, totalBytes };
  }

  // importSingleFileInSession: import one public MEGA file link into the ALREADY
  // logged-in MEGAcmd session's cloud drive at destFolder.
  //
  // The CALLER is responsible for ensureMegaCmdServer() + megaSwitch() BEFORE and
  // megaLogout() + updateAccountRow() AFTER, so that a queue engine can import many
  // files into the same account session back-to-back without logging out between each.
  //
  // Does NOT call updateAccountRow() — the caller owns the running usageKb tally.
  // Returns { ok: true, fileLink } on success, { ok: false, error } on failure.
  async function importSingleFileInSession({ email, password, url, destFolder, fileName, fileBytes }) {
    const result = await importMegaLink(url, destFolder);
    if (!result.ok) return { ok: false, error: result.error, kind: result.kind };
    const filePath = destFolder.replace(/\/$/, '') + '/' + fileName;
    const fileLink = await getMegacmdFileLink(filePath);
    appendImportRow({ fileName, fileSize: fileBytes, fileLink, email, password, destFolder });
    return { ok: true, fileLink };
  }

  // doImportMegaLink: copy a public MEGA file/folder link directly into the
  // logged-in account's own cloud drive at destFolder, via megacmd's `import`.
  // This is a server-side MEGA-to-MEGA copy — no data passes through this machine.
  //
  // After a successful import we generate a public link for every imported
  // file (via megacmd export, same mechanism as the uploader) and log it in
  // import_log.csv. Link generation happens BEFORE megaLogout() since it
  // needs the same logged-in MEGAcmd session that performed the import.
  async function doImportMegaLink({ email, password, url, destFolder, fileBytes, fileName, importFiles }) {
    try {
      await ensureMegaCmdServer();
      await megaSwitch(email, password);

      // "Import Selected" path: file name is known upfront — delegate to the shared
      // session helper so the logic lives in exactly one place (DRY).
      // doImportMegaLink's external contract is unchanged: it still manages its own
      // login/logout, so view-import.js callers require no modification.
      if (fileName) {
        const res = await importSingleFileInSession({ email, password, url, destFolder, fileName, fileBytes });
        await megaLogout();
        if (res.ok) markSecurityUpgrade(email);
        if (res.ok && fileBytes) updateAccountRow(email, fileBytes / 1024);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      }

      // For direct file-link imports (no importFiles list, no fileName supplied
      // by the caller) snapshot the destination folder now so we can detect
      // which file(s) actually landed after the import.
      // (fileName is always falsy here, so isSingleFile simplifies to the importFiles check.)
      const isSingleFile = !Array.isArray(importFiles) || importFiles.length === 0;
      // Snapshot destFolder's contents before import in both cases now — the
      // verification fallback below needs this for folder imports too, not
      // just single-file links.
      const preImportPaths = await _findFilesUnderPath(destFolder).catch(() => []);

      let result = await importMegaLink(url, destFolder);

      // MEGAcmd can report a non-ok result (non-zero exit, a timeout if the
      // import took longer than expected, or success wording that doesn't
      // match our regex) even when the import actually succeeded server-side.
      // This used to only be checked for single-file links, but whole-folder
      // "Import All" imports are just as exposed to it — often more so, since
      // they take longer — so verify against the filesystem in both cases
      // instead of trusting the CLI's own ok/error split blindly.
      if (!result.ok) {
        const verifyPaths     = await _findFilesUnderPath(destFolder).catch(() => []);
        const newPaths        = verifyPaths.filter(p => !preImportPaths.includes(p));
        const sawExpectedFile = isSingleFile
        ? newPaths.length > 0
        : importFiles.some(f => newPaths.some(p => path.posix.basename(p) === f.name));
        if (sawExpectedFile) result = { ok: true };
      }

      if (result.ok && Array.isArray(importFiles) && importFiles.length) {
          // "Import All": one import call brought in every file at once, possibly
          // nested under destFolder. Find out where everything actually landed,
          // then match each imported file to its real remote path by basename.
          const remotePaths = await _findFilesUnderPath(destFolder);
          const pool = remotePaths.slice();
          for (const f of importFiles) {
            const idx         = pool.findIndex(p => path.posix.basename(p) === f.name);
            const matchedPath = idx !== -1 ? pool.splice(idx, 1)[0] : null;
            const fileLink    = matchedPath ? await getMegacmdFileLink(matchedPath) : '';
            appendImportRow({ fileName: f.name, fileSize: f.size, fileLink, email, password, destFolder });
          }
        } else if (result.ok && isSingleFile) {
          // Single-file public link: the file name and size weren't known upfront.
          // Diff the destination against the pre-import snapshot to find what
          // landed, then fetch the size from MEGA's public API if not supplied.
          const postImportPaths = await _findFilesUnderPath(destFolder).catch(() => []);
          const newPaths        = postImportPaths.filter(p => !preImportPaths.includes(p));
          const effectiveSize   = fileBytes || await getMegaPublicFileSize(url) || 0;
          for (const filePath of newPaths) {
            const detectedName = path.posix.basename(filePath);
            const fileLink     = await getMegacmdFileLink(filePath).catch(() => '');
            appendImportRow({ fileName: detectedName, fileSize: effectiveSize, fileLink, email, password, destFolder });
          }
          await megaLogout();
          markSecurityUpgrade(email);
          if (effectiveSize) updateAccountRow(email, effectiveSize / 1024);
          return result;
        }

        await megaLogout();
        if (result.ok) markSecurityUpgrade(email);
        if (result.ok && fileBytes) {
          updateAccountRow(email, fileBytes / 1024);
        }
        return result;
    } catch (err) {
      network.interruption(err);
      return { ok: false, error: err?.message || 'Import failed' };
    }
  }

  module.exports = {
    appendImportRow,
    browseAccountFiles: network.wrap('account-files', browseAccountFiles),
    getAccountFileLinks: network.wrap('account-links', getAccountFileLinks),
    checkImportQuota: network.wrap('import-quota', checkImportQuota),
    doImportMegaLink: network.wrap('import', doImportMegaLink),
    // ── Bulk Import exports (Task B) ──────────────────────────────────────────
    classifyMegaLink,          // B2 — link type classifier for queue analysis
    getMegaPublicFileSize: network.wrap('metadata', getMegaPublicFileSize),
    importSingleFileInSession: network.wrap('megacmd', importSingleFileInSession),
    _findFilesUnderPath: network.wrap('megacmd', _findFilesUnderPath),
  };
