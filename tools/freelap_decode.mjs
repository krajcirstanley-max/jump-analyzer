// Decodes a Freelap frame copied from nRF Connect (Manufacturer data), to compare with MyFreelap.
// node tools/freelap_decode.mjs "<advertisement hex>" ["<scan response hex>"]
import { hexBytes, decodeAdvertisement, decodeScanResponse, rep } from '../js/freelap/frame.js';

const [adHex, srHex] = process.argv.slice(2);
if (!adHex) { console.log('usage: node tools/freelap_decode.mjs "<advertisement hex>" ["<scan response hex>"]'); process.exit(1); }
const ad = decodeAdvertisement(hexBytes(adHex));
if (!ad) { console.log('Not a Freelap advertisement (needs to start 63 03 58 … or 58 …).'); process.exit(1); }
const laps = srHex ? decodeScanResponse(hexBytes(srHex)) ?? [] : ad.laps;
const r = rep(ad, laps);
console.log(`chip ${r.chip}  flag ${r.flag}`);
console.log(`lap ${r.lap.toFixed(2)} s   total from session start ${r.total.toFixed(2)} s`);
console.log(`legs ${r.legs.map(x => x.toFixed(2)).join(' + ')} s`);
console.log('unknown bytes 18-23', ad.raw.map(b => b.toString(16).padStart(2, '0')).join(' '), '| ticks', { offset: ad.offset, start: ad.fromLap, finish: ad.block, laps });
