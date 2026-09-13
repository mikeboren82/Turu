// TuRu Cleaner - validate an image URL before it is attached to an activity: reachable, real image
// content type, not tiny (bytes and real pixel dimensions parsed from the header bytes - JPEG SOF,
// PNG IHDR, GIF, WebP VP8/VP8L/VP8X), not a logo/icon/placeholder/tracking pixel by URL pattern.
// Nothing here writes to the database.
const { fetchHead } = require('../lib/fetchPage');

const BAD_URL = /logo|sprite|icon|favicon|placeholder|pixel\.gif|\.svg(\?|$)|1x1|blank\.|spacer|tracking|badge|avatar|emoji|loader|loading/i;
const MIN_BYTES = 8 * 1024;
const MIN_W = 300, MIN_H = 200;

function readDimensions(buf) {
  if (buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF') return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X' && buf.length >= 30) return { type: 'webp', width: (buf.readUIntLE(24, 3)) + 1, height: (buf.readUIntLE(27, 3)) + 1 };
  }
  // JPEG: walk markers to SOF0/1/2
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return { type: 'jpeg', width: null, height: null };
  }
  return null;
}

// -> { ok, reason?, url, contentType, bytes, width, height }
async function probeImage(url, opts = {}) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'not_http', url };
  if (BAD_URL.test(url)) return { ok: false, reason: 'url_pattern', url };
  const r = await fetchHead(url, opts);
  if (!r.ok) return { ok: false, reason: r.status ? `http_${r.status}` : 'unreachable', url };
  const ct = (r.contentType || '').toLowerCase();
  const dims = readDimensions(r.bytes);
  if (!ct.startsWith('image/') && !dims) return { ok: false, reason: 'not_image', url, contentType: ct };
  if (r.length && r.length < MIN_BYTES) return { ok: false, reason: 'too_small_bytes', url, bytes: r.length };
  if (dims && dims.width != null && (dims.width < MIN_W || dims.height < MIN_H)) return { ok: false, reason: 'too_small_px', url, width: dims.width, height: dims.height };
  if (dims && dims.width != null && (dims.width / Math.max(1, dims.height) > 6 || dims.height / Math.max(1, dims.width) > 6)) return { ok: false, reason: 'banner_ratio', url, width: dims.width, height: dims.height };
  return { ok: true, url: r.finalUrl || url, contentType: ct || (dims ? 'image/' + dims.type : ''), bytes: r.length, width: dims?.width ?? null, height: dims?.height ?? null };
}

module.exports = { probeImage, readDimensions, BAD_URL, MIN_W, MIN_H, MIN_BYTES };
