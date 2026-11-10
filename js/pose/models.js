// Pose and person-detector models: preprocessing, output decoding and keypoint maps.
// Pure functions over RGBA pixel buffers, so they run the same in a Worker and in Node.
// Constants match rtmlib / mmpose (pipeline.json in each model zip):
//   pose:     top-down crop, bbox padding 1.25, RGB, mean/std below, SimCC split ratio 2
//   detector: YOLOX letterbox, BGR 0-255, pad value 114, NMS inside the ONNX graph

export const MEAN = [123.675, 116.28, 103.53];
export const STD = [58.395, 57.12, 57.375];

// The keypoints the app uses, in one order for every model.
export const J = [
  'nose', 'lear', 'rear', 'lsho', 'rsho', 'lelb', 'relb', 'lwri', 'rwri',
  'lhip', 'rhip', 'lknee', 'rknee', 'lank', 'rank',
  'lheel', 'rheel', 'lbigtoe', 'rbigtoe', 'lsmalltoe', 'rsmalltoe',
];
export const JI = Object.fromEntries(J.map((n, i) => [n, i]));

// Index of each J keypoint in the model's own output.
const HALPE26 = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 24, 25, 20, 21, 22, 23];
const WHOLEBODY = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 22, 17, 20, 18, 21];

// minScore: a keypoint below this is treated as not found. Scores are not calibrated
// probabilities and RTMW-l 384 outputs a different scale (~2-8 on clear joints).
export const MODELS = {
  'rtmpose-m': { file: 'models/rtmpose_m_halpe26_256x192.onnx', w: 192, h: 256, map: HALPE26, minScore: 0.3, label: 'RTMPose-m (Halpe26)' },
  'rtmw-l-256': { file: 'models/rtmw_l_256x192.onnx', w: 192, h: 256, map: WHOLEBODY, minScore: 0.3, label: 'RTMW-l 256' },
  'rtmw-l-384': { file: 'models/rtmw_l_384x288.onnx', w: 288, h: 384, map: WHOLEBODY, minScore: 1.0, label: 'RTMW-l 384' },
};

// Lines drawn between keypoints.
export const BONES = [
  ['lsho', 'rsho'], ['lhip', 'rhip'], ['lsho', 'lhip'], ['rsho', 'rhip'],
  ['lsho', 'lelb'], ['lelb', 'lwri'], ['rsho', 'relb'], ['relb', 'rwri'],
  ['lhip', 'lknee'], ['lknee', 'lank'], ['rhip', 'rknee'], ['rknee', 'rank'],
  ['lank', 'lheel'], ['lheel', 'lbigtoe'], ['lank', 'lbigtoe'],
  ['rank', 'rheel'], ['rheel', 'rbigtoe'], ['rank', 'rbigtoe'],
];
export const DETECTOR = { file: 'models/yolox_tiny_humanart.onnx', size: 416 };

// Bilinear sample of an RGBA buffer; outside the image is black (cv2 warpAffine default).
function sample(rgba, W, H, x, y, out, o) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) out[o + c] = 0;
  for (let dy = 0; dy < 2; dy++) {
    const yy = y0 + dy;
    if (yy < 0 || yy >= H) continue;
    const wy = dy ? fy : 1 - fy;
    for (let dx = 0; dx < 2; dx++) {
      const xx = x0 + dx;
      if (xx < 0 || xx >= W) continue;
      const w = wy * (dx ? fx : 1 - fx);
      const p = (yy * W + xx) * 4;
      out[o] += rgba[p] * w; out[o + 1] += rgba[p + 1] * w; out[o + 2] += rgba[p + 2] * w;
    }
  }
}

// Box [x1,y1,x2,y2] -> centre and scale (w,h), padded and fitted to the model aspect ratio.
export function boxToCenterScale(box, inW, inH, padding = 1.25) {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  let sw = (box[2] - box[0]) * padding, sh = (box[3] - box[1]) * padding;
  const ar = inW / inH;
  if (sw > sh * ar) sh = sw / ar; else sw = sh * ar;
  return { cx, cy, sw, sh };
}

// Crops the region into a normalized NCHW float tensor for the pose model.
export function poseInput(rgba, W, H, cs, inW, inH, out = new Float32Array(3 * inW * inH), offset = 0) {
  const px = new Float32Array(3);
  const plane = inW * inH;
  const sx = cs.sw / inW, sy = cs.sh / inH;
  // Same mapping as mmpose's get_warp_matrix + cv2.warpAffine: output pixel i samples
  // cx + (i - inW/2)·s, the inverse of the decode below.
  for (let j = 0; j < inH; j++) {
    const y = cs.cy + (j - inH / 2) * sy;
    for (let i = 0; i < inW; i++) {
      sample(rgba, W, H, cs.cx + (i - inW / 2) * sx, y, px, 0);
      const k = offset + j * inW + i;
      out[k] = (px[0] - MEAN[0]) / STD[0];
      out[k + plane] = (px[1] - MEAN[1]) / STD[1];
      out[k + 2 * plane] = (px[2] - MEAN[2]) / STD[2];
    }
  }
  return out;
}

// SimCC decode for one item of a batch -> J-ordered [x, y, score] in image pixels.
export function decodeSimcc(simx, simy, Wx, Wy, K, item, cs, inW, inH, map, split = 2) {
  const out = new Float32Array(J.length * 3);
  for (let j = 0; j < J.length; j++) {
    const k = map[j];
    const bx = (item * K + k) * Wx, by = (item * K + k) * Wy;
    let ix = 0, vx = -Infinity, iy = 0, vy = -Infinity;
    for (let t = 0; t < Wx; t++) if (simx[bx + t] > vx) { vx = simx[bx + t]; ix = t; }
    for (let t = 0; t < Wy; t++) if (simy[by + t] > vy) { vy = simy[by + t]; iy = t; }
    const score = 0.5 * (vx + vy);
    out[j * 3] = (ix / split) / inW * cs.sw + cs.cx - cs.sw / 2;
    out[j * 3 + 1] = (iy / split) / inH * cs.sh + cs.cy - cs.sh / 2;
    out[j * 3 + 2] = score;
  }
  return out;
}

// YOLOX letterbox of a region of the image (roi = [x, y, w, h], default whole image).
export function detectorInput(rgba, W, H, size = DETECTOR.size, roi = [0, 0, W, H]) {
  const [rx, ry, rw, rh] = roi;
  const ratio = Math.min(size / rh, size / rw);
  const nw = Math.floor(rw * ratio), nh = Math.floor(rh * ratio);
  const plane = size * size;
  const out = new Float32Array(3 * plane).fill(114);
  const px = new Float32Array(3);
  const s = 1 / ratio;
  for (let j = 0; j < nh; j++) {
    const y = ry + (j + 0.5) * s - 0.5;
    for (let i = 0; i < nw; i++) {
      sample(rgba, W, H, rx + (i + 0.5) * s - 0.5, y, px, 0);
      const k = j * size + i;
      out[k] = px[2]; out[k + plane] = px[1]; out[k + 2 * plane] = px[0]; // BGR
    }
  }
  return { tensor: out, ratio, roi };
}

// Detector output -> person boxes in image pixels [x1, y1, x2, y2, score].
export function decodeDetections(dets, labels, n, ratio, roi, minScore = 0.3) {
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const s = dets[i * 5 + 4];
    if (s < minScore || Number(labels[i]) !== 0) continue;
    boxes.push([
      dets[i * 5] / ratio + roi[0], dets[i * 5 + 1] / ratio + roi[1],
      dets[i * 5 + 2] / ratio + roi[0], dets[i * 5 + 3] / ratio + roi[1], s,
    ]);
  }
  return boxes;
}
