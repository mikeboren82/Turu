// One-off asset-processing script (2026-09-22, "Home Screen Visual Redesign"): the new logo file
// (assets/Logo Turu Gradient.png) was supplied as an OPAQUE RGB PNG with a solid black background
// baked into the pixels (confirmed via PNG header: colorType=2, no alpha channel) - not a code/
// resizeMode bug, the asset itself has no transparency. This converts it to a proper RGBA PNG:
// background pixels (near the sampled corner color) become transparent, with a smooth alpha
// falloff + edge decontamination (un-blending the background out of anti-aliased edge pixels) so
// the cutout has no dark fringe. Run once, writes assets/Logo Turu Gradient.png in place.
const fs = require('fs');
const { PNG } = require('pngjs');

const SRC = process.argv[2] || 'assets/Logo Turu Gradient.png';
const DST = process.argv[3] || SRC;

const png = PNG.sync.read(fs.readFileSync(SRC));
const { width, height, data } = png;

// sample the background color from several corner/edge pixels (median-ish: just average a few
// known-background points) rather than trusting a single pixel to noise/compression artifacts.
function pixelAt(x, y) {
  const idx = (width * y + x) << 2;
  return [data[idx], data[idx + 1], data[idx + 2]];
}
const samples = [pixelAt(2, 2), pixelAt(width - 3, 2), pixelAt(2, height - 3), pixelAt(width - 3, height - 3), pixelAt(Math.floor(width / 2), 2)];
const bg = [0, 1, 2].map((c) => Math.round(samples.reduce((s, p) => s + p[c], 0) / samples.length));
console.log('sampled background color:', bg);

const THRESH_LOW = 18; // distance below this -> fully transparent
const THRESH_HIGH = 70; // distance above this -> fully opaque
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

let transparentCount = 0, edgeCount = 0, opaqueCount = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (width * y + x) << 2;
    const px = [data[idx], data[idx + 1], data[idx + 2]];
    const d = dist(px, bg);
    let alpha;
    if (d <= THRESH_LOW) { alpha = 0; transparentCount++; }
    else if (d >= THRESH_HIGH) { alpha = 255; opaqueCount++; }
    else { alpha = Math.round(((d - THRESH_LOW) / (THRESH_HIGH - THRESH_LOW)) * 255); edgeCount++; }

    if (alpha > 0 && alpha < 255) {
      // edge decontamination: observed = fg*a + bg*(1-a)  =>  fg = (observed - bg*(1-a)) / a
      const a = alpha / 255;
      for (let c = 0; c < 3; c++) {
        const fg = (px[c] - bg[c] * (1 - a)) / a;
        data[idx + c] = Math.max(0, Math.min(255, Math.round(fg)));
      }
    }
    data[idx + 3] = alpha;
  }
}
console.log(`pixels: ${transparentCount} transparent, ${edgeCount} edge/decontaminated, ${opaqueCount} opaque (of ${width * height} total)`);

fs.writeFileSync(DST, PNG.sync.write(png));
console.log('wrote', DST);
