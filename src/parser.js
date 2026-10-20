'use strict';

function parseUrl(rawUrl) {
  // Strip UTF-8 BOM (U+FEFF) that some copy sources prepend, then trim all
  // leading/trailing whitespace including invisible Unicode space characters.
  const url = rawUrl.replace(/^\uFEFF/, '').trim().replace(/\r/g, '').replace(/\n/g, '');

  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) throw new Error('Invalid MEGA URL: missing # fragment.');

  const pathPart = url.slice(0, hashIdx);
  const fragment = url.slice(hashIdx + 1);

  // ── Legacy format: https://mega.nz/#!ID!KEY  or  https://mega.nz/#F!ID!KEY ──
  if (fragment.startsWith('!') || fragment.startsWith('F!')) {
    const isFolder = fragment.startsWith('F!');
    const inner    = isFolder ? fragment.slice(2) : fragment.slice(1);
    const bangIdx  = inner.indexOf('!');
    if (bangIdx === -1) throw new Error('Invalid legacy MEGA URL: cannot find ID/KEY separator.');
    const id     = inner.slice(0, bangIdx);
    const rawKey = inner.slice(bangIdx + 1);
    const key    = rawKey.replace(/-/g, '+').replace(/_/g, '/');
    if (!id || !key) throw new Error('Invalid legacy MEGA URL: empty ID or KEY.');
    return { linkType: isFolder ? 'folder' : 'file', id, key, fileInFolder: null };
  }

  // ── Modern format: https://mega.nz/file/ID#KEY  or  /folder/ID#KEY ──────────
  const pathSegments = pathPart.split('/');
  const linkType = pathSegments[3];
  const id       = pathSegments[4];

  const fragSegments = fragment.split('/');
  const rawKey = fragSegments[0];
  const key    = rawKey.replace(/-/g, '+').replace(/_/g, '/');
  const f6     = fragSegments[1] || '';
  const f7     = fragSegments[2] || '';

  if (!id || !key || key.includes(':')) {
    throw new Error(
      `Invalid URL — could not extract ID or KEY.\n` +
      `  linkType = ${JSON.stringify(linkType)}\n` +
      `  id       = ${JSON.stringify(id)}\n` +
      `  key      = ${JSON.stringify(key)}`
    );
  }

  if (linkType === 'file') {
    const bareKey = key.replace(/=/g, '');
    if (bareKey.length !== 43) throw new Error('Invalid key length for file link.');
    return { linkType: 'file', id, key, fileInFolder: null };

  } else if (linkType === 'folder') {
    const bareKey = key.replace(/=/g, '');
    if (bareKey.length !== 22) throw new Error('Invalid key length for folder link.');
    if (f6 === 'folder') {
      return { linkType: 'folder', id, key, fileInFolder: null, subfolderHandle: f7 || null };
    }
    const fileInFolder = (f6 === 'file' && f7) ? f7 : null;
    return { linkType: 'folder', id, key, fileInFolder };

  } else if (linkType === 'embed') {
    throw new Error(
      'Embed links (/embed/…) are not supported for direct download. ' +
      'Open the link in a browser, then copy the standard /file/… URL from the address bar.'
    );

  } else {
    throw new Error(`Cannot determine link type (got "${linkType}"). Expected "file" or "folder".`);
  }
}

module.exports = { parseUrl };
