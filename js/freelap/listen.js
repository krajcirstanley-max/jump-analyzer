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
  if (!ad) return null;
  const r = rep(ad);
  if (!(r.lap > 0 && r.lap < MAX_LAP_S)) return null;
  return { ...r, key: `${ad.chip}:${ad.fromLap}:${ad.block}`, who: CHIPS[ad.chip] ?? null, at };
}

// ble: nativeBle() or a stand-in. on: { rep(r), packet(count, hex), state(s, error) }.
// seen: keys already kept (from a stored list), so a rep is never added twice.
export function createListener(ble, on = {}, seen = new Set()) {
  let state = ble ? 'off' : 'none', sub = null, packets = 0, ready = false;
  const set = (s, err = null) => { state = s; on.state?.(s, err); };

  function take(result) {
    if (state !== 'on') return;   // Stop means nothing is taken in
    const bytes = freelapBytes(result);
    if (!bytes) return;
    packets++;
    on.packet?.(packets, [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' '));
    const r = readRep(bytes);
    if (!r || seen.has(r.key)) return;
    seen.add(r.key);
    on.rep?.(r);
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
        packets = 0;
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
