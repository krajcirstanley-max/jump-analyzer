// Runs the detector and pose models through ONNX Runtime (WASM, single thread).
// Shared by the browser worker and the Node test runner.
import { MODELS, DETECTOR, J, boxToCenterScale, poseInput, decodeSimcc, detectorInput, decodeDetections } from './models.js';

export class PoseEngine {
  constructor(ort) { this.ort = ort; this.sessions = {}; this.ms = {}; }

  // loadBytes(path) -> Uint8Array
  async load(keys, loadBytes) {
    for (const k of keys) {
      if (this.sessions[k]) continue;
      const file = k === 'detector' ? DETECTOR.file : MODELS[k].file;
      this.sessions[k] = await this.ort.InferenceSession.create(await loadBytes(file), { executionProviders: ['wasm'] });
    }
  }

  #time(k, t0) { const m = this.ms[k] || (this.ms[k] = { n: 0, total: 0 }); m.n++; m.total += performance.now() - t0; }

  // People in the frame (or in roi = [x, y, w, h]) -> [[x1, y1, x2, y2, score]].
  async detect(rgba, W, H, roi) {
    const t0 = performance.now();
    const di = detectorInput(rgba, W, H, DETECTOR.size, roi);
    const r = await this.sessions.detector.run({ input: new this.ort.Tensor('float32', di.tensor, [1, 3, DETECTOR.size, DETECTOR.size]) });
    const boxes = decodeDetections(r.dets.data, r.labels.data, r.dets.dims[1], di.ratio, di.roi);
    this.#time('detector', t0);
    return boxes;
  }

  // Keypoints (J order, [x, y, score] flat) for the person in box.
  async pose(rgba, W, H, box, key) {
    const t0 = performance.now();
    const m = MODELS[key];
    const cs = boxToCenterScale(box, m.w, m.h);
    const input = poseInput(rgba, W, H, cs, m.w, m.h);
    const r = await this.sessions[key].run({ input: new this.ort.Tensor('float32', input, [1, 3, m.h, m.w]) });
    const [, K, Wx] = r.simcc_x.dims;
    const kp = decodeSimcc(r.simcc_x.data, r.simcc_y.data, Wx, r.simcc_y.dims[2], K, 0, cs, m.w, m.h, m.map);
    this.#time(key, t0);
    return kp;
  }
}

export const meanScore = kp => { let s = 0; for (let j = 0; j < J.length; j++) s += kp[j * 3 + 2]; return s / J.length; };
