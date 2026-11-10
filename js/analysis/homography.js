// Plane-to-plane homographies, shared by the server (camera tracking) and the analysis
// (ground metres). 3x3 as a flat array of 9 with h[8] = 1.
export function applyH(h, [x, y]) { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; }
export function homography(src, dst) { // least squares DLT with h33 = 1 (normalised for conditioning)
  const norm = pts => { const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
    const d = pts.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / n || 1, k = Math.SQRT2 / d;
    return { T: [k, 0, -k * mx, 0, k, -k * my, 0, 0, 1], p: pts.map(([x, y]) => [k * (x - mx), k * (y - my)]) }; };
  const a = norm(src), b = norm(dst);
  const M = Array.from({ length: 8 }, () => new Float64Array(8)), r = new Float64Array(8);
  a.p.forEach(([x, y], i) => { const [u, v] = b.p[i];
    const rows = [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -v * x, -v * y], v]];
    for (const [row, rhs] of rows) for (let p = 0; p < 8; p++) { r[p] += row[p] * rhs; for (let q = 0; q < 8; q++) M[p][q] += row[p] * row[q]; } });
  for (let i = 0; i < 8; i++) { let p = i; for (let k = i + 1; k < 8; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]]; [r[i], r[p]] = [r[p], r[i]]; if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let k = 0; k < 8; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let q = i; q < 8; q++) M[k][q] -= f * M[i][q]; r[k] -= f * r[i]; } }
  const hn = [...Array(8)].map((_, i) => r[i] / M[i][i]).concat(1);
  // H = Tb^-1 * Hn * Ta
  const mul = (A, B) => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]));
  const Tb = b.T, kb = Tb[0], TbInv = [1 / kb, 0, -Tb[2] / kb, 0, 1 / kb, -Tb[5] / kb, 0, 0, 1];
  const h = mul(mul(TbInv, hn), a.T);
  return h.map(v => v / h[8]);
}
export function invertH(h) {
  const [a, b, c, d, e, f, g, k, l] = h;
  const A = e * l - f * k, B = -(d * l - f * g), C = d * k - e * g;
  const det = a * A + b * B + c * C;
  const inv = [A, -(b * l - c * k), b * f - c * e, B, a * l - c * g, -(a * f - c * d), C, -(a * k - b * g), a * e - b * d].map(v => v / det);
  return inv.map(v => v / inv[8]);
}

