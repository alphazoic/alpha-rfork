'use strict';

const network = require('./network-operations');

const https = require('https');
const { parseUrl }           = require('./parser');
const { decryptECB, decryptAttr, deriveFileKeyFromHex } = require('./megaCrypto');

const API_ROOT   = 'https://g.api.mega.co.nz';
const TIMEOUT_MS = 20_000;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function apiPost(url, body) {
    return new Promise((resolve, reject) => {
        const u    = new URL(url);
        const data = JSON.stringify(body);
        const req  = network.requestNetwork(https, 'request',
            {
                hostname: u.hostname,
                path:     u.pathname + u.search,
                method:   'POST',
                headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            },
            (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    try   { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                    catch { reject(new Error('Invalid response from MEGA API')); }
                });
            }
        );
        req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ── Key extraction ────────────────────────────────────────────────────────────

/**
 * MEGA's k field can be "ownerA:encKey" or "ownerA:encKeyA/ownerB:encKeyB/…".
 * Find the entry whose owner matches our share ID, falling back to the first entry.
 */
function extractNodeKey(kField, shareId, rootH) {
    if (typeof kField !== 'string' || !kField.includes(':')) return null;
    const entries = kField.split('/');
    const match   = entries.find(e => e.startsWith((rootH ?? shareId) + ':'))
    || entries.find(e => e.startsWith(shareId + ':'));
    const chosen  = match || entries.find(e => e.includes(':')) || entries[0];
    const sep     = chosen.indexOf(':');
    return sep >= 0 ? chosen.slice(sep + 1) : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch and decrypt the full file tree for a MEGA folder link.
 *
 * @param   {string} rawUrl   e.g. "https://mega.nz/folder/XYZABC#secretKey"
 * @returns {{ baseUrl, rootName, rootHandle, files, folders }}
 *   files:   Array<{ handle: string, name: string, size: number, parentHandle: string }>
 *   folders: Array<{ handle: string, name: string, parentHandle: string }>
 */
async function fetchFolderTree(rawUrl) {
    const parsed = parseUrl(rawUrl.trim());
    if (parsed.linkType !== 'folder') throw new Error('Not a MEGA folder link');

    const { id, key } = parsed;

    // Extract the raw (URL-safe base64) key from the original URL *before* parser
    // normalisation swaps – → + and _ → /. We need the original form for the base
    // URL so that constructed file links remain valid MEGA URLs.
    // `key` from parseUrl is still used for crypto — Buffer.from handles standard base64.
    const rawFragment = rawUrl.trim().split('#')[1] || '';
    const rawKey      = rawFragment.split('/')[0];
    const baseUrl     = `https://mega.nz/folder/${id}#${rawKey}`;
    const shareKeyHex = Buffer.from(key, 'base64').toString('hex');

    // Fetch the complete node listing for this share
    const res = await apiPost(`${API_ROOT}/cs?id=0&n=${id}`, [{ a: 'f', c: 1, ca: 1, r: 1 }]);

    if (!Array.isArray(res) || typeof res[0] !== 'object' || !res[0].f) {
        throw new Error(`MEGA API error (code: ${Array.isArray(res) ? res[0] : res})`);
    }

    const nodes      = res[0].f;
    const allHandles = new Set(nodes.map(n => n.h));

    // Root folder = the folder node whose parent isn't in this share's node set
    const rootHandle = nodes.find(n => n.t === 1 && !allHandles.has(n.p))?.h ?? null;

    const files   = [];
    const folders = [];
    let rootName  = 'Shared Folder';

    for (const node of nodes) {
        const encKey = extractNodeKey(node.k, id, rootHandle);
        if (!encKey) continue;

        let name = `[${node.h}]`;   // placeholder if decryption fails
        try {
            const nodeKeyHex = decryptECB(encKey, shareKeyHex);
            //  • Folders (t=1): ECB output is the 16-byte AES key directly
            //  • Files   (t=0): ECB output is 32 bytes; XOR halves to get the 16-byte AES key
            const attrKey = node.t === 1 ? nodeKeyHex : deriveFileKeyFromHex(nodeKeyHex).key;
            name = decryptAttr(node.a, attrKey);
        } catch { /* leave placeholder */ }

        if (node.t === 1) {
            folders.push({ handle: node.h, name, parentHandle: node.p });
            if (node.h === rootHandle) rootName = name;
        } else if (node.t === 0) {
            files.push({ handle: node.h, name, size: node.s ?? 0, parentHandle: node.p });
        }
    }

    return { baseUrl, rootName, rootHandle, files, folders };
}

module.exports = { fetchFolderTree: network.wrap('metadata', fetchFolderTree) };
