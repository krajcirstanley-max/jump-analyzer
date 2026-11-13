// Listening for Freelap chips, like the MyFreelap app (Stanley, 2026-11-13: "keď stlačím Start tak
// bude fungovať, keď Stop tak neprijíma"). Start opens a Bluetooth scan and every FxChip broadcast
// that arrives is decoded; Stop closes it and nothing is taken in until the next Start.
// The chip repeats one rep about every 125 ms for a few seconds after the finish, so a rep is kept
// once (same chip, same start, same finish). Format and decoder: ./frame.js.
import { COMPANY_ID, decodeAdvertisement, hexBytes, rep } from './frame.js';

// Whose chip is whose (vault memory "Freelap chips").
export const CHIPS = { 'BA-8358': 'stanley', 'BD-4125': 'miska' };

const PLUGIN = 'BluetoothLe';
const MAX_LAP_S = 600;   // anything longer is not a run

// The Bluetooth plugin of the iPhone app, called through Capacitor's bridge directly (the web app
// has no bundler, so the plugin's own JS wrapper isn't loaded). null in Safari: no Bluetooth there.
export function nativeBle(cap = globalThis.Capacitor) {
  if (!cap?.isNativePlatform?.() || !cap.nativePromise || !cap.addListener) return null;
  return {
    initialize: () => cap.nativePromise(PLUGIN, 'initialize', {}),
    isEnabled: async () => (await cap.nativePromise(PLUGIN, 'isEnabled', {}))?.value !== false,
    start: opts => cap.nativePromise(PLUGIN, 'requestLEScan', opts),
    stop: () => cap.nativePromise(PLUGIN, 'stopLEScan', {}),
    onResult: cb => cap.addListener(PLUGIN, 'onScanResult', d => d && cb(d)),
  };
}

// The Freelap bytes of one scan result, or null. iOS gives manufacturer data as
// { "<company id in decimal>": "58 00 42 41 …" } with the company ID already taken off.
export function freelapBytes(result) {
  const md = result?.manufacturerData;
  if (!md) return null;
  const v = md[String(COMPANY_ID)];
  if (v == null) return null;
  if (typeof v === 'string') return hexBytes(v);
  if (v instanceof DataView) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return v instanceof Uint8Array ? v : null;
}

// One received broadcast to a rep, or null if it isn't a run (an empty or odd frame).
export function readRep(bytes, at = Date.now()) {
  const ad = decodeAdvertisement(bytes);
  return ad ? repOf(ad, ad.laps, at) : null;
}
function repOf(ad, laps, at) {
  const r = rep(ad, laps);
  if (!(r.lap > 0 && r.lap < MAX_LAP_S)) return null;
  return { ...r, key: `${ad.chip}:${ad.fromLap}:${ad.block}`, who: CHIPS[ad.chip] ?? null, at };
}

// Intermediates sent apart from the run, read against the run they belong to. Two layouts are
// tried: 4-byte crossings (as in the frames Stanley captured) and 3-byte ones (the garmin-freelap
// layout for a scan response). iOS strips the company ID, so they start at byte 0. A reading is
// kept only if every crossing falls, in order, between that run's start and finish.
export function lapsFromScanResponse(bytes, ad) {
  if (!bytes?.length || bytes[0] === 0x58) return null;
  return readCrossings(bytes, ad, 4) ?? readCrossings(bytes, ad, 3);
}
function readCrossings(bytes, ad, width) {
  const from = ad.fromLap >>> 0, to = ad.block >>> 0, laps = [];
  for (let i = 0; i + width <= bytes.length && laps.length < 10; i += width) {
    let v = 0;
    for (let k = width - 1; k >= 0; k--) v = v * 256 + bytes[i + k];
    if (!v) break;
    let full = v;
    if (width === 3) { full = (from - (from % 0x1000000)) + v; if (full < from) full += 0x1000000; }
    if (!(full > from && full < to)) return null;
    if (laps.length && full <= laps[laps.length - 1]) return null;
    laps.push(full);
  }
  return laps.length ? laps : null;
}

// ble: nativeBle() or a stand-in. on: { rep(r), update(r), packet(count, hex), state(s, error) }.
// seen: runs already kept (key -> how many legs), from the stored list, so a run is never added
// twice. iPhone may hand over the short frame (start and finish) before the one that carries the
// intermediate (Stanley, 2026-11-13: "len medzičas nejde"), so a later frame of the same run with
// more legs updates it instead of being dropped as a repeat.
export function createListener(ble, on = {}, seen = new Map()) {
  if (seen instanceof Set) seen = new Map([...seen].map(k => [k, 0]));
  const lastRun = new Map();   // device -> { ad, at }: the run a separate intermediate frame belongs to
  let state = ble ? 'off' : 'none', sub = null, packets = 0, ready = false;
  const set = (s, err = null) => { state = s; on.state?.(s, err); };

  // For finding out why nothing arrives: every device heard, and whether a chip was heard by name.
  const devices = new Set();
  let named = 0;
  function take(result) {
    if (state !== 'on') return;   // Stop means nothing is taken in
    devices.add(result?.device?.deviceId ?? JSON.stringify(result?.device ?? ''));
    const isChip = /freelap/i.test(result?.localName ?? result?.device?.name ?? '');
    if (isChip) named++;
    on.heard?.({ devices: devices.size, named, md: isChip ? result.manufacturerData ?? null : undefined });
    const bytes = freelapBytes(result);
    if (!bytes) return;
    packets++;
    on.packet?.(packets, [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' '));
    const dev = result?.device?.deviceId ?? '';
    const now = Date.now();
    const ad = decodeAdvertisement(bytes);
    let r = null;
    if (ad) {
      r = repOf(ad, ad.laps, now);
      if (r) lastRun.set(dev, { ad, at: now });
    } else {
      const last = lastRun.get(dev);
      const laps = last && now - last.at < 5000 && last.ad.laps.length === 0 ? lapsFromScanResponse(bytes, last.ad) : null;
      if (laps) r = repOf(last.ad, laps, now);
    }
    if (!r) return;
    if (!seen.has(r.key)) { seen.set(r.key, r.legs.length); on.rep?.(r); return; }
    if (r.legs.length > seen.get(r.key)) { seen.set(r.key, r.legs.length); on.update?.(r); }
  }

  return {
    get state() { return state; },
    get packets() { return packets; },
    async start() {
      if (!ble || state === 'on' || state === 'starting') return;
      set('starting');
      try {
        if (!ready) { await ble.initialize(); ready = true; }
        // initialize succeeds with Bluetooth switched off, and the scan would then hear nothing.
        if (ble.isEnabled && !(await ble.isEnabled())) throw new Error('BLE powered off');
        sub ??= await ble.onResult(take);
        // Every advertisement, repeats included: the chip's frames all look alike to iOS.
        // A scan left running (the page reloaded under it) makes the plugin stop it and refuse
        // once; the second try starts clean.
        await ble.start({ allowDuplicates: true }).catch(e => {
          if (!/already scanning/i.test(e?.message ?? e)) throw e;
          return ble.start({ allowDuplicates: true });
        });
        packets = 0; named = 0; devices.clear();
        set('on');
      } catch (e) {
        set('off', e?.message ?? String(e));
      }
    },
    async stop() {
      if (!ble || state === 'off') return;
      set('off');
      try { await ble.stop(); } catch { /* already stopped */ }
    },
  };
}
