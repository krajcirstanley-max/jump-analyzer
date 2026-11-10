// Contact sheets for Claude: many frames tiled into one JPEG, each stamped with its frame
// number, so a model can name exact frames. Built from the RGBA frames already decoded for
// the pose pass; no second decode.
import { jpeg } from './frames.mjs';

// 3x5 digit glyphs, one string row per line.
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'],
};

function stamp(img, W, x0, y0, text, px) {
  const w = text.length * 4 * px + px, h = 7 * px;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const o = (y * W + x) * 4; img[o] = 0; img[o + 1] = 0; img[o + 2] = 0; img[o + 3] = 255;
  }
  [...text].forEach((ch, k) => GLYPHS[ch]?.forEach((row, gy) => [...row].forEach((bit, gx) => {
    if (bit !== '1') return;
    for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) {
      const o = ((y0 + px + gy * px + dy) * W + (x0 + px + (k * 4 + gx) * px + dx)) * 4;
      img[o] = 255; img[o + 1] = 230; img[o + 2] = 0;
    }
  })));
}

// Bilinear sample of the source rectangle [sx, sy, sw, sh] into a tw x th tile at (ox, oy).
function blit(src, W, H, [sx, sy, sw, sh], dst, DW, ox, oy, tw, th) {
  for (let y = 0; y < th; y++) {
    const fy = sy + ((y + 0.5) * sh) / th - 0.5;
    const y1 = Math.max(0, Math.min(H - 1, Math.floor(fy))), y2 = Math.min(H - 1, y1 + 1), wy = Math.min(1, Math.max(0, fy - y1));
    for (let x = 0; x < tw; x++) {
      const fx = sx + ((x + 0.5) * sw) / tw - 0.5;
      const x1 = Math.max(0, Math.min(W - 1, Math.floor(fx))), x2 = Math.min(W - 1, x1 + 1), wx = Math.min(1, Math.max(0, fx - x1));
      const o = ((oy + y) * DW + ox + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = src[(y1 * W + x1) * 4 + c], b = src[(y1 * W + x2) * 4 + c];
        const d = src[(y2 * W + x1) * 4 + c], e = src[(y2 * W + x2) * 4 + c];
        dst[o + c] = (a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy;
      }
      dst[o + 3] = 255;
    }
  }
}

// Crop rectangle per frame. 'full' keeps the whole frame; otherwise a fixed-size window,
// the same zoom for every tile, centred on the athlete's box in that frame (the phone pans).
export function cropsFor(list, boxes, W, H, mode = 'athlete') {
  if (mode === 'full') return list.map(() => [0, 0, W, H]);
  const known = list.map(i => boxes?.[i]).filter(Boolean);
  if (!known.length) return list.map(() => [0, 0, W, H]);
  const tall = Math.max(...known.map(b => b[3] - b[1])), wide = Math.max(...known.map(b => b[2] - b[0]));
  // Room for the feet's ground and the free leg's reach; portrait tiles like the clips.
  const ch = Math.min(H, tall * 1.5), cw = Math.min(W, Math.max(wide * 1.4, ch * 0.75));
  let last = known[0];
  return list.map(i => {
    const b = boxes?.[i] ?? last; last = b;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2 + 0.05 * ch;
    return [Math.max(0, Math.min(W - cw, cx - cw / 2)), Math.max(0, Math.min(H - ch, cy - ch / 2)), cw, ch];
  });
}

// One JPEG with the frames in `list` tiled row by row, each stamped with its number.
export async function contactSheet(frames, list, { boxes, mode = 'athlete', cols = 8, tileW = 180 } = {}) {
  const crops = cropsFor(list, boxes, frames.W, frames.H, mode);
  const tileH = Math.round((tileW * crops[0][3]) / crops[0][2]);
  const rows = Math.ceil(list.length / cols), DW = cols * tileW, DH = rows * tileH;
  const img = new Uint8Array(DW * DH * 4);
  const pixels = await frames.pick(list);
  const px = Math.max(2, Math.round(tileW / 60));
  list.forEach((i, k) => {
    const ox = (k % cols) * tileW, oy = Math.floor(k / cols) * tileH, src = pixels.get(i);
    if (src) blit(src, frames.W, frames.H, crops[k], img, DW, ox, oy, tileW, tileH);
    stamp(img, DW, ox + 2, oy + 2, String(i), px);
  });
  return jpeg(img, DW, DH, { maxSide: Math.max(DW, DH), q: 3 });
}
