// The overlay burned into a copy of the clip for Photos (Stanley, 2026-11-22: "aj vypálené v galérii").
// On the phone, free: Mediabunny decodes the clip, every frame is drawn on a canvas with the same
// overlay the player shows (hud.js drawAt), and encoded again to MP4. The copy is made when it is
// saved, from the numbers of that moment, so a corrected tape distance or Freelap time is in it the
// next time it is saved; nothing wrong stays baked in.
import { drawAt } from './hud.js';
import * as mb from '../vendor/mediabunny.min.mjs';

// blob: the clip; timeline(t): what is on screen t s after the first frame; flagScale: frame pixels of
// the server's reading -> pixels of this clip (cone flags). Resolves the MP4 blob.
export async function burnClip(blob, timeline, { flagScale = null, serverW = null, onProgress = () => {}, signal = null } = {}) {
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  let canvas = null, ctx = null, t0 = null, k = flagScale;
  const conv = await mb.Conversion.init({
    input, output,
    video: {
      forceTranscode: true,
      // 60 fps and 12 Mbit/s: a 10 s portrait clip at 120 fps came out 52-64 MB at the default quality
      frameRate: 60,
      bitrate: 12e6,
      process: sample => {
        const w = sample.displayWidth, h = sample.displayHeight;
        if (!canvas) {
          canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
          ctx = canvas.getContext('2d');
          if (k == null) k = serverW ? w / serverW : 1;
        }
        if (t0 == null) t0 = sample.timestamp;
        ctx.clearRect(0, 0, w, h);
        sample.draw(ctx, 0, 0, w, h);
        drawAt(ctx, { x: 0, y: 0, w, h }, timeline(sample.timestamp - t0), p => [p[0] * k, p[1] * k]);
        return canvas;
      },
    },
    audio: { discard: true },
  });
  if (!conv.isValid) throw new Error(`Video sa nedá prekódovať (${conv.discardedTracks?.map(d => d.reason).join(', ') || 'neznámy dôvod'}).`);
  conv.onProgress = p => onProgress(p);
  if (signal) signal.addEventListener('abort', () => conv.cancel?.(), { once: true });
  await conv.execute();
  input.dispose?.();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

// Into Photos through the app (SprintCamera.saveChunk, 2 MB base64 slices); in a browser, a download.
export async function saveToPhotos(blob, name = 'video') {
  const plug = globalThis.Capacitor?.Plugins?.SprintCamera;
  if (!plug?.saveChunk) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.mp4`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return { downloaded: true };
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, SLICE = 2 * 1024 * 1024;
  for (let at = 0, n = 0; at < blob.size; at += SLICE, n++) {
    const buf = new Uint8Array(await blob.slice(at, at + SLICE).arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    await plug.saveChunk({ id, data: btoa(bin), first: n === 0, last: at + SLICE >= blob.size });
  }
  return { saved: true };
}

// The button's whole job: make the copy, show the progress on the button, save it.
export async function burnAndSave(btn, blob, timeline, opts = {}) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const out = await burnClip(blob, timeline, { ...opts, onProgress: p => { btn.textContent = `Pripravujem video ${Math.round(p * 100)} %`; } });
    btn.textContent = 'Ukladám do Fotiek…';
    const r = await saveToPhotos(out, opts.name ?? 'video');
    btn.textContent = r.saved ? 'Uložené vo Fotkách ✓' : 'Stiahnuté ✓';
  } catch (e) {
    btn.textContent = label;
    alert(`Video s overlay sa nepodarilo uložiť: ${e?.message ?? e}`);
  } finally {
    btn.disabled = false;
    setTimeout(() => { if (/✓/.test(btn.textContent)) btn.textContent = label; }, 4000);
  }
}
