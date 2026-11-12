// Freelap FxChip BLE broadcast frames. The chip never accepts a connection: for a few seconds after
// a Finish crossing it broadcasts the rep (about every 125 ms) as Bluetooth manufacturer data under
// Freelap's company ID 0x0363. Any phone in range can read it; MyFreelap is just another listener.
// Device name "FreeLap BGM" for every chip; the chip is told apart by the ID in the data.
//
// VERIFIED 2026-11-13 by Stanley with nRF Connect on an iPhone against MyFreelap: 2 chips (BA-8358,
// BD-4125), 5 runs, every time equal to the hundredth (vault: "Freelap FxChip BLE - format").
// Layout after the company ID:
//   0 type 0x58 · 1 flag (00, 08 when the two start fields differ) · 2-3 ID letters · 4-5 ID number
//   6-9 session start · 10-13 START the time counts from · 14-17 FINISH · 18-23 unknown
//   (00 0D A1 D2 xx 11, xx changes: 30/31/33, maybe battery) · 24+ intermediates, uint32 each,
//   zero = empty. Times are uint32 little-endian ticks of 1/1024 s; MyFreelap rounds to 1/100 s.
// Started from tools/freelap_frame.py of github.com/MaximumTrainer/garmin-freelap (MIT, copyright
// its authors). Where the real capture differs from it (intermediates as 4-byte values in the same
// payload, not 3-byte values in a scan response), the capture wins. Only one intermediate has been
// seen so far, so 4-byte spacing with two or more is still to be confirmed.

export const COMPANY_ID = 0x0363;
const FRAME_TYPE = 0x58;            // 'X': an FxChip BLE frame
const TICKS_PER_CS = 10.24;         // the chip counts 1/1024 s; accuracy is 1/100 s
const MAX_LAPS = 10;                // the chip remembers 10 intermediate times
const AD_LEN = 26;                  // advertisement payload, company ID included
const MASK = 0x7fffffff;            // the vendor document gives two masks; they differ only on huge counters

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

// "0x6303 58 01 …", "<63035801…>", "63:03:58" all read as bytes.
export function hexBytes(text) {
  const h = String(text).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (h.length % 2) return null;
  return Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));
}

// The bytes after the company ID. iOS gives the manufacturer data with the company ID first
// (little-endian: 63 03); a copy that starts at the frame type (58) is taken as already without it.
function body(bytes) {
  if (!bytes || bytes.length < 2) return null;
  if (u16(bytes, 0) === COMPANY_ID) return bytes.subarray(2);
  return bytes[0] === FRAME_TYPE ? bytes : null;
}

export function decodeAdvertisement(bytes) {
  const b = body(bytes);
  if (!b || b.length < AD_LEN - 2 || b[0] !== FRAME_TYPE) return null;
  const prefix = String.fromCharCode(b[2], b[3]);
  if (!/^[A-Z]{2}$/.test(prefix)) return null;
  const chipId = u16(b, 4);
  const laps = [];
  for (let i = 0; i < MAX_LAPS && 24 + i * 4 + 4 <= b.length; i++) {
    const v = u32(b, 24 + i * 4);
    if (!v) break;
    laps.push(v);
  }
  return {
    chip: `${prefix}-${String(chipId).padStart(4, '0')}`,   // as printed on the chip, e.g. BA-8358
    flag: b[1], offset: u32(b, 6), fromLap: u32(b, 10), block: u32(b, 14), laps,
    raw: [...b.subarray(18, 24)],   // meaning not settled
  };
}

// The garmin-freelap layout for a scan response (3-byte crossings). Not seen in a real capture yet;
// kept so a capture that shows one can be read.
export function decodeScanResponse(bytes) {
  const b = body(bytes);
  if (!b) return null;
  const laps = [];
  for (let i = 0; i < MAX_LAPS && i * 3 + 3 <= b.length; i++) {
    const v = u24(b, i * 3);
    if (!v) break;
    laps.push(v);
  }
  return laps;
}

export const centiseconds = ticks => Math.round(ticks / TICKS_PER_CS);   // MyFreelap rounds
export const seconds = ticks => centiseconds(ticks) / 100;

// The rep: total from the session origin, this lap, and each leg (finish included). The legs add
// up to the lap, which is the cheapest check that a frame was read right.
export function rep(ad, laps = ad.laps ?? []) {
  const legs = [];
  let prev = ad.fromLap & MASK;
  for (const v of laps) { legs.push(v - prev); prev = v; }
  legs.push((ad.block & MASK) - prev);
  return {
    chip: ad.chip, flag: ad.flag,
    lap: seconds((ad.block & MASK) - (ad.fromLap & MASK)),
    total: seconds((ad.block & MASK) - (ad.offset & MASK)),
    legs: legs.map(seconds),
  };
}

// For tests and the fake chip: a frame in the same layout.
export function buildAdvertisement({ prefix, chipId, flag = 0, offset, fromLap, block, laps = [] }) {
  const out = [COMPANY_ID & 0xff, COMPANY_ID >> 8, FRAME_TYPE, flag & 0xff, prefix.charCodeAt(0), prefix.charCodeAt(1), chipId & 0xff, chipId >> 8];
  const u32le = v => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  for (const v of [offset, fromLap, block]) u32le(v);
  out.push(0x00, 0x0d, 0xa1, 0xd2, 0x33, 0x11);
  for (let i = 0; i < 2; i++) u32le(laps[i] ?? 0);
  return Uint8Array.from(out);
}
export function buildScanResponse(laps) {
  const out = [COMPANY_ID & 0xff, COMPANY_ID >> 8];
  for (let i = 0; i < MAX_LAPS; i++) { const v = laps[i] ?? 0; out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff); }
  return Uint8Array.from(out);
}
