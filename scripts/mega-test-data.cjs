'use strict';
const crypto = require('node:crypto');
const key = '00112233445566778899AABBCCDDEEFF', iv = '10203040506070800000000000000000';
// Independent block-by-block formulation (production uses streamed native CBC).
function referenceMac(data) {
  const encrypt = block => {
    const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'hex'), null); cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block), cipher.final()]);
  };
  let aggregate = Buffer.alloc(16), offset = 0, size = 131072;
  while (offset < data.length) {
    const end = Math.min(offset + size, data.length); let mac = Buffer.from(iv.slice(0, 16).repeat(2), 'hex');
    for (; offset < end; offset += 16) {
      const block = Buffer.alloc(16); data.copy(block, 0, offset, Math.min(offset + 16, end));
      for (let i = 0; i < 16; i++) block[i] ^= mac[i]; mac = encrypt(block);
    }
    offset = end; for (let i = 0; i < 16; i++) aggregate[i] ^= mac[i]; aggregate = encrypt(aggregate);
    size = Math.min(1048576, size + 131072);
  }
  const result = Buffer.alloc(8);
  result.writeUInt32BE((aggregate.readUInt32BE(0) ^ aggregate.readUInt32BE(4)) >>> 0, 0);
  result.writeUInt32BE((aggregate.readUInt32BE(8) ^ aggregate.readUInt32BE(12)) >>> 0, 4);
  return result.toString('hex');
}
module.exports = { referenceMac, key, iv };
