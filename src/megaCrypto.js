'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const { pipeline } = require('stream/promises');

function b64c(s) {
  return s.replace(/-/g, '+').replace(/_/g, '/');
}

/**
 * XOR two same-length Buffers in place into a new Buffer.
 */
function xorBuffers(a, b) {
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function deriveFileKey(keyBase64) {
  const buf    = Buffer.from(b64c(keyBase64), 'base64');
  const keyBytes = xorBuffers(buf.subarray(0, 16), buf.subarray(16, 32));
  const key      = keyBytes.toString('hex').toUpperCase();
  const iv       = buf.subarray(16, 24).toString('hex').toUpperCase() + '0000000000000000';
  const fullHex  = buf.toString('hex').toUpperCase();
  return { key, iv, fullHex };
}

function deriveFileKeyFromHex(fullHex) {
  const buf      = Buffer.from(fullHex, 'hex');
  const keyBytes = xorBuffers(buf.subarray(0, 16), buf.subarray(16, 32));
  const key      = keyBytes.toString('hex').toUpperCase();
  const iv       = buf.subarray(16, 24).toString('hex').toUpperCase() + '0000000000000000';
  return { key, iv };
}

function decryptECB(dataBase64, keyHex) {
  const key      = Buffer.from(keyHex, 'hex');
  const data     = Buffer.from(b64c(dataBase64), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, Buffer.alloc(0));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('hex');
}

function decryptAttr(attrBase64, keyHex) {
  const key      = Buffer.from(keyHex, 'hex');
  const data     = Buffer.from(b64c(attrBase64), 'base64');
  const iv       = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(data), decipher.final()]);
  const jsonStr = raw.slice(4).toString('utf8').replace(/\0+/g, '');
  try { return JSON.parse(jsonStr).n; } catch { return null; }
}

function computeChunkIv(baseIvHex, bytePosition) {
  const base      = BigInt('0x' + baseIvHex);
  const increment = BigInt(bytePosition) / 16n;
  const newIv     = (base + increment) & ((1n << 128n) - 1n);
  return newIv.toString(16).padStart(32, '0').toUpperCase();
}

/**
 * Returns a raw AES-128-CTR Decipher (a Transform stream) for the given
 * file key/iv. Callers pipe ciphertext into it and read plaintext back out
 * — used when streaming straight from the network into another process
 * (e.g. mediainfo) without ever writing to disk.
 */
function createDecipher(keyHex, ivHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv  = Buffer.from(ivHex, 'hex');
  return crypto.createDecipheriv('aes-128-ctr', key, iv);
}

/**
 * Decrypt an AES-128-CTR encrypted file chunk and write it to `outPath`.
 */
async function decryptChunkStream(keyHex, ivHex, encPath, outPath, append, onProgress = null, cancelToken = null, macAccumulator = null, signal = null) {
  const decipher = createDecipher(keyHex, ivHex);
  const input = fs.createReadStream(encPath);
  const output = fs.createWriteStream(outPath, { flags: append ? 'a' : 'w' });
  let processed = 0;
  decipher.on('data', chunk => {
    try { macAccumulator?.update(chunk); processed += chunk.length; onProgress?.(processed); }
    catch (error) { decipher.destroy(error); }
  });
  if (cancelToken) cancelToken.signal.catch(error => { input.destroy(error); decipher.destroy(error); output.destroy(error); });
  await pipeline(input, decipher, output, ...(signal ? [{ signal }] : []));
}

const { IncrementalMac, verifyFileMac } = require('./mega-mac');

module.exports = {
  b64c,
  deriveFileKey,
  deriveFileKeyFromHex,
  decryptECB,
  decryptAttr,
  computeChunkIv,
  decryptChunkStream,
  createDecipher,
  verifyFileMac,
  IncrementalMac,
};
