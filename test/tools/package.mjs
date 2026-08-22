/** extension/ を zip に固める。chrome://extensions の「読み込む」でも使えるが配布用。 */
import { createWriteStream } from 'node:fs';
import { readdir, mkdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const SRC = 'extension';
const OUT = 'dist/webdav-for-files.zip';

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const files = await walk(SRC);
await mkdir('dist', { recursive: true });

const chunks = [];
const central = [];
let offset = 0;

for (const path of files) {
  const name = relative(SRC, path).split('\\').join('/');
  const data = await readFile(path);
  const compressed = deflateRawSync(data);
  const crc = crc32(data) >>> 0;
  const nameBytes = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 名
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  chunks.push(local, nameBytes, compressed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(compressed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBytes);

  offset += local.length + nameBytes.length + compressed.length;
  console.log(`  ${name} (${data.length} → ${compressed.length})`);
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

const stream = createWriteStream(OUT);
stream.write(Buffer.concat([...chunks, centralBuf, end]));
stream.end();
console.log(`-> ${OUT}`);
