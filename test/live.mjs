/**
 * 稼働中の WebDAV サーバに対する結合テスト。
 * chrome API は使わず DavClient + 素の fetch だけで、
 * 「PROPFIND で得た名前をそのまま次のリクエストに使える」ことを実データで確認する。
 *
 * サーバ固有の前提を置かず、ツリーを歩いて見つけたものを検証するので、
 * 自分の WebDAV サーバにそのまま向けられる。
 *
 *   node test/live.mjs http://127.0.0.1:8080
 *
 * Cloudflare Access の背後にあるサーバに向ける場合:
 *
 *   cloudflared access login https://dav.example.com
 *   CF_ACCESS_TOKEN=$(cloudflared access token -app=https://dav.example.com) \
 *     node test/live.mjs https://dav.example.com
 *
 * Basic 認証なら DAV_USER / DAV_PASS を渡す。
 */
import assert from 'node:assert/strict';
import { DavClient } from '../extension/dav.js';
import { createAuth } from '../extension/auth.js';

const BASE = process.argv[2] || process.env.DAV_URL || 'http://127.0.0.1:8080';
const MAX_DEPTH = Number(process.env.DAV_MAX_DEPTH || 2);
const MAX_ENTRIES_PER_DIR = Number(process.env.DAV_MAX_ENTRIES || 40);

// Basic 認証は拡張の実装をそのまま通す。ここで Authorization を組み立て直すと、
// 検証しているのがテスト側のコードになってしまう。
//
// なお authMode 'basic' は設定画面では https にしか設定できないが (config.js)、
// それは保存時のポリシーであって BasicAuth 自体の制約ではない。
// ローカルの http サーバに向けた検証はこの経路で問題なくできる。
const auth = process.env.DAV_USER
  ? createAuth({
    url: BASE,
    authMode: 'basic',
    username: process.env.DAV_USER,
    password: process.env.DAV_PASS || '',
  })
  : createAuth({ url: BASE, authMode: 'none' });

// cf-access-token は CLI 検証用の経路 (拡張本体は cookie を使う)。
const cfHeaders = process.env.CF_ACCESS_TOKEN
  ? { 'cf-access-token': process.env.CF_ACCESS_TOKEN }
  : {};

const client = new DavClient(BASE, (url, init = {}) =>
  auth.fetch(url, { ...init, headers: { ...(init.headers || {}), ...cfHeaders } }));

let checks = 0;
let dirCount = 0;
const failures = [];
const files = [];

function record(label, fn) {
  try {
    fn();
    checks++;
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

/** 一覧で得た各エントリを Depth:0 で引き直し、パスが往復することを確かめる。 */
async function walk(path, depth) {
  const entries = await client.readDirectory(path);
  dirCount++;

  record(`${path} は自分自身を含まない`, () => {
    assert.equal(entries.some((e) => e.path === path.replace(/\/$/, '') || e.path === '/'), false);
  });

  for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
    record(`${entry.path} の name`, () => {
      assert.notEqual(entry.name, '', 'name が空');
      assert.equal(entry.path.endsWith(`/${entry.name}`), true, 'path と name が食い違う');
    });

    // 一覧で得たパスをそのまま Depth:0 で引けること。
    // ここが FSP の往復 (name を返す → その name でリクエストが来る) に対応する。
    let meta;
    try {
      meta = await client.getMetadata(entry.path);
    } catch (error) {
      failures.push(`${entry.path} を引き直せない (エンコードの不一致?): ${error.message}`);
      continue;
    }
    record(`${entry.path} の往復`, () => {
      assert.equal(meta.path, entry.path);
      assert.equal(meta.isDirectory, entry.isDirectory);
      if (!entry.isDirectory) assert.equal(meta.size, entry.size);
    });

    if (entry.isDirectory) {
      if (depth > 0) await walk(entry.path, depth - 1);
    } else if (entry.size > 0) {
      files.push(entry);
    }
  }
}

/** Range GET の境界条件。中身は全量 GET と突き合わせる。 */
async function verifyRanges(entry) {
  const size = entry.size;
  const whole = Buffer.from(await client.readRange(entry.path, 0, size));
  record(`${entry.path} 全量 GET の長さ`, () => assert.equal(whole.length, size));

  const cases = [
    ['先頭', 0, Math.min(1024, size)],
    ['中間', Math.floor(size / 2), Math.min(4096, size)],
    ['末尾ちょうど', Math.max(0, size - 512), 512],
    ['末尾超過', Math.max(0, size - 100), 4096],
    ['1 バイト', Math.min(7, size - 1), 1],
    ['EOF 以降', size, 1024],
  ];

  for (const [label, offset, length] of cases) {
    const actual = Buffer.from(await client.readRange(entry.path, offset, length));
    const expected = whole.subarray(offset, Math.min(offset + length, size));
    record(`${entry.path} Range ${label} (offset=${offset} length=${length})`, () => {
      assert.equal(actual.length, expected.length, `長さ ${actual.length} != ${expected.length}`);
      assert.equal(actual.equals(expected), true, '内容が全量 GET と一致しない');
    });
  }
}

console.log(`base=${BASE}`);
if (cfHeaders['cf-access-token']) console.log('  auth: cf-access-token');
if (process.env.DAV_USER) console.log(`  auth: basic (${process.env.DAV_USER})`);

await walk('/', MAX_DEPTH);

console.log(`走査: ${dirCount} ディレクトリ / ファイル ${files.length} 件`);

// Range 検証の対象を選ぶ。
// 最大ファイルは必ず入れる (境界条件は十分な大きさが無いと意味がない)。
// 加えて、名前が厄介なファイルを 2 件。エンコードと Range を同時に踏ませる。
const score = (name) => (/[^\w.\-]/.test(name) ? 1 : 0) + (/[&#%+='"\[\]~ ]/.test(name) ? 1 : 0);
const largest = [...files].sort((a, b) => b.size - a.size)[0];
const trickiest = [...files]
  .filter((entry) => entry !== largest)
  .sort((a, b) => score(b.name) - score(a.name) || b.size - a.size)
  .slice(0, 2);
const targets = [largest, ...trickiest].filter(Boolean);

for (const entry of targets) {
  console.log(`Range 検証: ${entry.path} (${entry.size} bytes)`);
  await verifyRanges(entry);
}
if (targets.length === 0) failures.push('検証できるファイルが 1 つも無かった');

console.log(`\nチェック数: ${checks}`);
if (failures.length) {
  console.error(`\n失敗 ${failures.length} 件:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('すべて合格');
