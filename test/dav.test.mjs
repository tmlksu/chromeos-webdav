/**
 * dav.js のユニットテスト。fixture は実際の rclone serve webdav の出力。
 * 実行: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseMultiStatus,
  decodeXmlText,
  decodePath,
  encodePath,
  normalizePath,
  basename,
  joinPath,
  DavClient,
  DavHttpError,
} from '../extension/dav.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const byName = (entries, name) => entries.find((e) => e.name === name);

test('decodeXmlText: 定義済み実体と文字参照', () => {
  assert.equal(decodeXmlText('a &amp; b'), 'a & b');
  assert.equal(decodeXmlText('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeXmlText('&quot;q&quot; &apos;a&apos;'), '"q" \'a\'');
  assert.equal(decodeXmlText('&#65;&#x42;'), 'AB');
  assert.equal(decodeXmlText('&#x1F600;'), '\u{1F600}');
  assert.equal(decodeXmlText('no entities'), 'no entities');
  assert.equal(decodeXmlText('&unknown;'), '&unknown;', '未知の実体は素通し');
});

test('path ヘルパ', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('/a/b/'), '/a/b');
  assert.equal(normalizePath('a/b'), '/a/b');
  assert.equal(basename('/'), '');
  assert.equal(basename('/a/b.txt'), 'b.txt');
  assert.equal(joinPath('/', 'x'), '/x');
  assert.equal(joinPath('/a', 'x'), '/a/x');
});

test('encodePath / decodePath は日本語・記号を往復できる', () => {
  const samples = [
    '/画像/写真 001.jpg',
    '/ドキュメント & メモ/議事録 2026-01.txt',
    '/report #3 (final).md',
    '/a+b=c.txt',
    '/100% progress.md',
    "/it's here.txt",
    '/[draft] notes.txt',
    '/~backup~.txt',
    '/émoji 🎵 track.mp3',
    "/quote'and\"double",
  ];
  for (const path of samples) {
    assert.equal(decodePath(encodePath(path)), path, `round trip failed: ${path}`);
  }
  assert.equal(encodePath('/a b'), '/a%20b');
  assert.equal(encodePath('/a&b'), '/a%26b');
  assert.equal(encodePath('/a#b'), '/a%23b');
});

test('decodePath: 不正な % シーケンスは落とさず生のまま返す', () => {
  assert.equal(decodePath('/bad%zz/ok'), '/bad%zz/ok');
});

test('decodePath: セグメント内の %2F はスラッシュとして復元される', () => {
  assert.equal(decodePath('/dir/a%2Fb'), '/dir/a/b');
});

test('root Depth:1 (allprop) を解析する', () => {
  const entries = parseMultiStatus(fixture('propfind-root-depth1.xml'));
  assert.ok(entries.length > 10, `entries=${entries.length}`);

  const root = entries[0];
  assert.equal(root.path, '/');
  assert.equal(root.name, '');
  assert.equal(root.isDirectory, true);

  const media = byName(entries, 'sample-media.bin');
  assert.ok(media, 'sample-media.bin が見つからない');
  assert.equal(media.isDirectory, false);
  assert.equal(media.size, 2097152);
  assert.ok(media.modificationTime instanceof Date);
  assert.equal(Number.isNaN(media.modificationTime.getTime()), false);

  const docs = byName(entries, 'My Documents');
  assert.ok(docs);
  assert.equal(docs.isDirectory, true);
  assert.equal(docs.size, 0);
});

test('root Depth:1: 日本語ディレクトリ名がデコードされる', () => {
  const entries = parseMultiStatus(fixture('propfind-root-depth1.xml'));
  for (const name of ['画像', 'ドキュメント & メモ']) {
    const entry = byName(entries, name);
    assert.ok(entry, `${name} が見つからない`);
    assert.equal(entry.isDirectory, true);
    assert.equal(entry.path, `/${name}`);
  }
});

test('root Depth:1: サーバがエンコードしない文字も正しく読める', () => {
  const entries = parseMultiStatus(fixture('propfind-root-depth1.xml'));
  // rclone は + = ~ をそのまま href に出す。%XX と混在しても壊れないこと。
  const cases = {
    'a+b=c.txt': false,
    '~backup~.txt': false,
    "it's here.txt": false,
    '[draft] notes.txt': false,
    'report #3 (final).md': false,
    'rock & roll.txt': false,
    '100% progress.md': false,
    'émoji 🎵 track.mp3': false,
    '100% done': true,
  };
  for (const [name, isDirectory] of Object.entries(cases)) {
    const entry = byName(entries, name);
    assert.ok(entry, `${name} が見つからない`);
    assert.equal(entry.isDirectory, isDirectory, `${name} の種別が違う`);
    assert.equal(entry.path, `/${name}`);
  }
});

test('prop 限定 PROPFIND: 404 propstat の空プロパティを採用しない', () => {
  const xml = fixture('propfind-root-depth1-proplimited.xml');
  // このfixtureは 200 と 404 の propstat が同居していることが前提
  assert.ok(xml.includes('404 Not Found'), 'fixture に 404 propstat が含まれていない');

  const entries = parseMultiStatus(xml);
  const media = byName(entries, 'sample-media.bin');
  assert.ok(media);
  assert.equal(media.size, 2097152, '200 propstat 側の getcontentlength を採用すべき');

  const docs = byName(entries, 'My Documents');
  assert.ok(docs);
  assert.equal(docs.isDirectory, true, '404 propstat があっても collection 判定は保たれる');
});

test('特殊文字 (& / 空白 / 日本語) を含むディレクトリ配下を解析する', () => {
  const entries = parseMultiStatus(fixture('propfind-specialchars-depth1.xml'));
  const self = entries[0];
  assert.equal(self.path, '/ドキュメント & メモ');
  assert.equal(self.isDirectory, true);

  const child = entries.find((e) => e.name === '議事録 2026-01.txt');
  assert.ok(child, '子ファイルが解析されていない');
  assert.equal(child.isDirectory, false);
  assert.equal(child.path, '/ドキュメント & メモ/議事録 2026-01.txt');

  // href の &amp; が & に戻り、再エンコードで %26 になること
  assert.ok(encodePath(self.path).includes('%26'));
  assert.equal(decodePath(encodePath(self.path)), self.path);
});

test('ファイルの Depth:0', () => {
  const entries = parseMultiStatus(fixture('propfind-file-depth0.xml'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'sample-media.bin');
  assert.equal(entries[0].isDirectory, false);
  assert.equal(entries[0].size, 2097152);
});

test('ディレクトリの Depth:0', () => {
  const entries = parseMultiStatus(fixture('propfind-dir-depth0.xml'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].isDirectory, true);
  assert.equal(entries[0].name, '画像');
  assert.equal(entries[0].size, 0);
});

test('名前空間プレフィックスに依存しない', () => {
  const xml = `<?xml version="1.0"?>
    <multistatus xmlns="DAV:">
      <response>
        <href>/dir/</href>
        <propstat><prop><resourcetype><collection/></resourcetype></prop>
        <status>HTTP/1.1 200 OK</status></propstat>
      </response>
    </multistatus>`;
  const alt = xml.replace(/<(\/?)(multistatus|response|href|propstat|prop|resourcetype|collection|status)/g, '<$1lp1:$2');
  for (const variant of [xml, alt]) {
    const entries = parseMultiStatus(variant);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, '/dir');
    assert.equal(entries[0].isDirectory, true);
  }
});

test('属性内の > で誤って要素を切らない', () => {
  const xml = `<multistatus xmlns:D="DAV:"><D:response>
      <D:href>/x.txt</D:href>
      <D:propstat><D:prop>
        <D:displayname note="a > b">x.txt</D:displayname>
        <D:getcontentlength>7</D:getcontentlength>
        <D:resourcetype/>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></multistatus>`;
  const entries = parseMultiStatus(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].size, 7);
  assert.equal(entries[0].displayName, 'x.txt');
  assert.equal(entries[0].isDirectory, false);
});

test('絶対 URL 形式の href を扱える', () => {
  const xml = `<multistatus xmlns="DAV:"><response>
      <href>https://dav.example.com/a/b.txt</href>
      <propstat><prop><getcontentlength>3</getcontentlength><resourcetype/></prop>
      <status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
  const entries = parseMultiStatus(xml);
  assert.equal(entries[0].path, '/a/b.txt');
});

test('baseurl が設定されていれば path から剥がす', () => {
  const xml = `<multistatus xmlns="DAV:"><response>
      <href>/dav/sub/file.txt</href>
      <propstat><prop><getcontentlength>3</getcontentlength><resourcetype/></prop>
      <status>HTTP/1.1 200 OK</status></propstat></response>
      <response><href>/dav/</href>
      <propstat><prop><resourcetype><collection/></resourcetype></prop>
      <status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
  const entries = parseMultiStatus(xml, { baseUrlPath: '/dav' });
  assert.equal(entries[0].path, '/sub/file.txt');
  assert.equal(entries[1].path, '/');
});

test('壊れた XML でも例外を投げず、読めた分だけ返す', () => {
  const truncated = fixture('propfind-root-depth1.xml').slice(0, 900);
  const entries = parseMultiStatus(truncated);
  assert.ok(Array.isArray(entries));
});

// --- DavClient ---

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function xmlResponse(body, status = 207) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test('DavClient.urlFor: パスをエンコードして URL にする', () => {
  const client = new DavClient('https://dav.example.com', mockFetch(() => {}));
  assert.equal(client.urlFor('/'), 'https://dav.example.com');
  assert.equal(client.urlFor('/画像'), 'https://dav.example.com/%E7%94%BB%E5%83%8F');
  assert.equal(client.urlFor('/a b&c'), 'https://dav.example.com/a%20b%26c');
});

test('DavClient.urlFor: baseurl 付き', () => {
  const client = new DavClient('https://h/dav/', mockFetch(() => {}));
  assert.equal(client.baseUrlPath, '/dav');
  assert.equal(client.urlFor('/x.txt'), 'https://h/dav/x.txt');
});

test('readDirectory は自分自身を除外する', async () => {
  const fetchImpl = mockFetch(() => xmlResponse(fixture('propfind-specialchars-depth1.xml')));
  const client = new DavClient('https://dav.example.com', fetchImpl);
  const path = '/ドキュメント & メモ';
  const entries = await client.readDirectory(path);

  assert.equal(entries.some((e) => e.path === path), false, '自分自身が残っている');
  assert.ok(entries.length > 0);
  assert.equal(fetchImpl.calls[0].init.headers.Depth, '1');
});

test('readDirectory: 末尾スラッシュ付きで要求しても自分自身を除外する', async () => {
  const fetchImpl = mockFetch(() => xmlResponse(fixture('propfind-specialchars-depth1.xml')));
  const client = new DavClient('https://dav.example.com', fetchImpl);
  const entries = await client.readDirectory('/ドキュメント & メモ/');
  assert.equal(entries.some((e) => e.name === 'ドキュメント & メモ'), false);
});

test('propfind: 非 2xx は DavHttpError になる', async () => {
  const client = new DavClient('https://h', mockFetch(() => ({ ok: false, status: 404, text: async () => '' })));
  await assert.rejects(() => client.getMetadata('/nope'), (err) => {
    assert.ok(err instanceof DavHttpError);
    assert.equal(err.status, 404);
    return true;
  });
});

// --- Range GET 境界条件 ---

const FILE = new Uint8Array(1000).map((_, i) => i % 251);

/**
 * @param {{honorRange?: boolean, strict?: boolean}} [options]
 *   honorRange:false — Range を無視して 200 で全量返すサーバ
 *   strict:true      — 末尾を跨ぐ Range を切り詰めず 416 で断るサーバ (dufs で実測)。
 *                      RFC 7233 は切り詰めを求めているが、断る実装が現実にある。
 */
function rangeServer(body, { honorRange = true, strict = false } = {}) {
  return mockFetch(async (url, init) => {
    if (!honorRange) {
      return {
        ok: true, status: 200,
        arrayBuffer: async () => body.buffer.slice(0),
      };
    }
    const tooFar = { ok: false, status: 416, arrayBuffer: async () => new ArrayBuffer(0) };
    const m = /bytes=(\d+)-(\d*)/.exec(init.headers.Range);
    const start = Number(m[1]);
    const open = m[2] === '';
    const end = open ? body.length - 1 : Number(m[2]);
    if (start >= body.length) return tooFar;
    if (strict && !open && end >= body.length) return tooFar;
    const slice = body.slice(start, Math.min(end + 1, body.length));
    return { ok: false, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  });
}

test('readRange: offset=0', async () => {
  const fetchImpl = rangeServer(FILE);
  const client = new DavClient('https://h', fetchImpl);
  const buf = await client.readRange('/f', 0, 100);
  assert.equal(buf.byteLength, 100);
  assert.deepEqual(new Uint8Array(buf), FILE.slice(0, 100));
  assert.equal(fetchImpl.calls[0].init.headers.Range, 'bytes=0-99');
});

test('readRange: 1 バイトだけ', async () => {
  const client = new DavClient('https://h', rangeServer(FILE));
  const buf = await client.readRange('/f', 500, 1);
  assert.deepEqual(new Uint8Array(buf), FILE.slice(500, 501));
});

test('readRange: ファイル末尾ちょうど', async () => {
  const client = new DavClient('https://h', rangeServer(FILE));
  const buf = await client.readRange('/f', 900, 100);
  assert.equal(buf.byteLength, 100);
  assert.deepEqual(new Uint8Array(buf), FILE.slice(900));
});

test('readRange: length がファイル末尾を超える場合は残り全部', async () => {
  const client = new DavClient('https://h', rangeServer(FILE));
  const buf = await client.readRange('/f', 950, 500);
  assert.equal(buf.byteLength, 50);
  assert.deepEqual(new Uint8Array(buf), FILE.slice(950));
});

test('readRange: offset がファイル末尾以降なら空 (416)', async () => {
  const client = new DavClient('https://h', rangeServer(FILE));
  const buf = await client.readRange('/f', 1000, 10);
  assert.equal(buf.byteLength, 0);
});

test('readRange: length<=0 はリクエストを発行しない', async () => {
  const fetchImpl = rangeServer(FILE);
  const client = new DavClient('https://h', fetchImpl);
  assert.equal((await client.readRange('/f', 0, 0)).byteLength, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('readRange: Range を無視して 200 を返すサーバでも正しく切り出す', async () => {
  const client = new DavClient('https://h', rangeServer(FILE, { honorRange: false }));
  const buf = await client.readRange('/f', 900, 100);
  assert.equal(buf.byteLength, 100);
  assert.deepEqual(new Uint8Array(buf), FILE.slice(900, 1000));
});

// --- 末尾を跨ぐ Range を 416 で断るサーバ (dufs) -----------------------------
// FSP は固定長で読むので最後のチャンクは必ず末尾を跨ぐ。ここで空を返すと
// 「どのファイルも末尾が欠ける」「小さいファイルは丸ごと空になる」ことになる。

test('readRange: 末尾を跨ぐ Range を断るサーバでも残りを返す', async () => {
  const client = new DavClient('https://h', rangeServer(FILE, { strict: true }));
  const buf = await client.readRange('/f', 950, 500);
  assert.equal(buf.byteLength, 50);
  assert.deepEqual(new Uint8Array(buf), FILE.slice(950));
});

test('readRange: 断るサーバ + 要求がファイル全体より長い (小さいファイル)', async () => {
  const small = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const client = new DavClient('https://h', rangeServer(small, { strict: true }));
  const buf = await client.readRange('/f', 0, 512);
  assert.deepEqual(new Uint8Array(buf), small);
});

test('readRange: 断るサーバでも offset が末尾以降なら空', async () => {
  const client = new DavClient('https://h', rangeServer(FILE, { strict: true }));
  const buf = await client.readRange('/f', 1000, 10);
  assert.equal(buf.byteLength, 0);
});

test('readRange: 引き直しは要求した length を越えない', async () => {
  // 開放レンジで引き直すと残り全部が返ってくることがある。length で切ること。
  const client = new DavClient('https://h', mockFetch(async () => ({
    ok: false, status: 206,
    arrayBuffer: async () => FILE.buffer.slice(0), // 要求より長い 1000 バイト
  })));
  const buf = await client.readRange('/f', 0, 10);
  assert.equal(buf.byteLength, 10);
  assert.deepEqual(new Uint8Array(buf), FILE.slice(0, 10));
});

test('readRange: 断られなければ引き直さない (1 リクエストで済む)', async () => {
  let calls = 0;
  const inner = rangeServer(FILE);
  const client = new DavClient('https://h', (url, init) => { calls++; return inner(url, init); });
  await client.readRange('/f', 0, 100);
  assert.equal(calls, 1);
});
