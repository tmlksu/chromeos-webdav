/**
 * 拡張のアイコンを生成する。
 *
 *   npm run icons
 *
 * 画像ライブラリを足さずに済ませたいので、PNG を直接書いている
 * (package.mjs が zip を直接書いているのと同じ理由)。
 * 形は下のベクタ定義 1 箇所だけで決まるので、色や形を変えたら作り直せばよい。
 *
 * 図案: 青の角丸正方形に白いフォルダ。16px でも潰れないよう、線ではなく面で作る。
 */
import { deflateSync, crc32 } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = 'extension/icons';
const SIZES = [16, 32, 48, 128];

/** 1 ピクセルあたりの標本数 (縦横それぞれ)。ここでアンチエイリアスをかける。 */
const SUPERSAMPLE = 4;

const BG = [0x1b, 0x4f, 0xa8]; // 濃い青。明色・暗色どちらのツールバーでも沈まない
const FG = [0xff, 0xff, 0xff];

/** 角丸長方形の符号付き距離。0 以下なら内側。座標は 0..1。 */
function roundRectSdf(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const qx = Math.max(Math.abs(px - cx) - hx, 0);
  const qy = Math.max(Math.abs(py - cy) - hy, 0);
  return Math.hypot(qx, qy) - r;
}

/**
 * フォルダの形。本体とタブの角丸長方形 2 つの和。
 * 別々に描くと境目に継ぎ目が出るので、和集合として一度に判定する。
 */
function insideFolder(x, y) {
  const body = roundRectSdf(x, y, 0.19, 0.40, 0.81, 0.73, 0.05);
  const tab = roundRectSdf(x, y, 0.19, 0.29, 0.44, 0.44, 0.045);
  return Math.min(body, tab) <= 0;
}

function insideBackground(x, y) {
  return roundRectSdf(x, y, 0.02, 0.02, 0.98, 0.98, 0.22) <= 0;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;
          if (insideBackground(x, y)) bg++;
          if (insideFolder(x, y)) fg++;
        }
      }
      const total = SUPERSAMPLE * SUPERSAMPLE;
      const bgA = bg / total;
      const fgA = fg / total;

      // 白いフォルダを青の上に重ね、その全体を背景の形で切り抜く
      const alpha = bgA;
      const mix = alpha === 0 ? 0 : Math.min(fgA / alpha, 1);
      const offset = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(BG[c] * (1 - mix) + FG[c] * mix);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput) >>> 0, 8 + data.length);
  return out;
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // ビット深度
  ihdr[9] = 6;  // カラータイプ 6 = RGBA
  // 10..12 は圧縮方式・フィルタ方式・インタレース。いずれも 0 が唯一の定義値

  // 各走査線の先頭にフィルタ種別のバイトが要る。0 = フィルタなし
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  const path = join(OUT_DIR, `icon-${size}.png`);
  await writeFile(path, png);
  console.log(`  ${path} (${size}x${size}, ${png.length} bytes)`);
}
