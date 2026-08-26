import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataCache, CachedDavClient, DEFAULT_TTL_MS } from '../extension/cache.js';

/** 時計を手で進められるようにする。実時間に依存させない。 */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const entryFor = (path, extra = {}) => ({
  path, name: path.slice(path.lastIndexOf('/') + 1),
  isDirectory: false, size: 1, modificationTime: null, mimeType: null, displayName: null,
  ...extra,
});

/** getMetadata / readDirectory の呼ばれた回数を数える DavClient のスタブ。 */
function fakeClient(tree) {
  const calls = { getMetadata: 0, readDirectory: 0, readRange: 0 };
  return {
    calls,
    async getMetadata(path) {
      calls.getMetadata++;
      const entry = tree[path];
      if (!entry) throw new Error(`no such path: ${path}`);
      return entry;
    },
    async readDirectory(path) {
      calls.readDirectory++;
      return Object.values(tree).filter((e) => e.path !== path && e.path.startsWith(path === '/' ? '/' : `${path}/`));
    },
    async readRange(path, offset, length) {
      calls.readRange++;
      return new ArrayBuffer(length);
    },
  };
}

// --- MetadataCache -----------------------------------------------------------

test('MetadataCache: TTL 内は返し、過ぎたら返さない', () => {
  const c = clock();
  const cache = new MetadataCache({ ttlMs: 100, now: c.now });
  cache.set('/a', entryFor('/a'));

  assert.equal(cache.get('/a').path, '/a');
  c.advance(99);
  assert.equal(cache.get('/a').path, '/a');
  c.advance(1); // ちょうど期限
  assert.equal(cache.get('/a'), undefined);
});

test('MetadataCache: 期限切れは引いた時点で捨てる', () => {
  const c = clock();
  const cache = new MetadataCache({ ttlMs: 10, now: c.now });
  cache.set('/a', entryFor('/a'));
  c.advance(20);
  cache.get('/a');
  assert.equal(cache.size, 0);
});

test('MetadataCache: setMany は path を持つものだけ入れる', () => {
  const cache = new MetadataCache();
  cache.setMany([entryFor('/a'), entryFor('/b'), null, undefined, { name: 'path なし' }]);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('/b').path, '/b');
});

test('MetadataCache: 上限を超えたら古いものから落とす', () => {
  const cache = new MetadataCache({ maxEntries: 3 });
  for (const p of ['/a', '/b', '/c', '/d']) cache.set(p, entryFor(p));
  assert.equal(cache.size, 3);
  assert.equal(cache.get('/a'), undefined); // 最古が落ちる
  assert.equal(cache.get('/d').path, '/d');
});

test('MetadataCache: 入れ直したものは新しい扱いになる', () => {
  const cache = new MetadataCache({ maxEntries: 2 });
  cache.set('/a', entryFor('/a'));
  cache.set('/b', entryFor('/b'));
  cache.set('/a', entryFor('/a')); // /a を最後尾へ
  cache.set('/c', entryFor('/c')); // ここで落ちるのは /b
  assert.equal(cache.get('/b'), undefined);
  assert.equal(cache.get('/a').path, '/a');
});

test('MetadataCache: clear で空になる', () => {
  const cache = new MetadataCache();
  cache.setMany([entryFor('/a'), entryFor('/b')]);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('MetadataCache: 既定の TTL は短い (古いものが残り続けない)', () => {
  assert.ok(DEFAULT_TTL_MS > 0 && DEFAULT_TTL_MS <= 30_000);
});

// --- CachedDavClient ---------------------------------------------------------

const TREE = {
  '/dir': entryFor('/dir', { isDirectory: true }),
  '/dir/a.txt': entryFor('/dir/a.txt'),
  '/dir/b.txt': entryFor('/dir/b.txt'),
  '/dir/c.txt': entryFor('/dir/c.txt'),
};

test('readDirectory の直後の getMetadata は通信しない', async () => {
  // これがこのキャッシュの存在理由。Files アプリは一覧のあと 1 件ずつ引いてくる。
  const inner = fakeClient(TREE);
  const client = new CachedDavClient(inner);

  const entries = await client.readDirectory('/dir');
  assert.equal(entries.length, 3);

  for (const entry of entries) await client.getMetadata(entry.path);

  assert.equal(inner.calls.readDirectory, 1);
  assert.equal(inner.calls.getMetadata, 0, '一覧で得たぶんは引き直さない');
});

test('getMetadata はキャッシュが無ければ 1 回だけ引く', async () => {
  const inner = fakeClient(TREE);
  const client = new CachedDavClient(inner);
  await client.getMetadata('/dir/a.txt');
  await client.getMetadata('/dir/a.txt');
  assert.equal(inner.calls.getMetadata, 1);
});

test('TTL が過ぎたら引き直す', async () => {
  const c = clock();
  const inner = fakeClient(TREE);
  const client = new CachedDavClient(inner, { ttlMs: 100, now: c.now });

  await client.readDirectory('/dir');
  await client.getMetadata('/dir/a.txt');
  assert.equal(inner.calls.getMetadata, 0);

  c.advance(101);
  await client.getMetadata('/dir/a.txt');
  assert.equal(inner.calls.getMetadata, 1);
});

test('readDirectory 自体はキャッシュしない (一覧は毎回取り直す)', async () => {
  const inner = fakeClient(TREE);
  const client = new CachedDavClient(inner);
  await client.readDirectory('/dir');
  await client.readDirectory('/dir');
  assert.equal(inner.calls.readDirectory, 2);
});

test('readRange は素通し (中身はキャッシュしない)', async () => {
  const inner = fakeClient(TREE);
  const client = new CachedDavClient(inner);
  const buf = await client.readRange('/dir/a.txt', 0, 16);
  assert.equal(buf.byteLength, 16);
  assert.equal(inner.calls.readRange, 1);
});

test('getMetadata のエラーはキャッシュしない', async () => {
  const inner = fakeClient(TREE);
  const client = new CachedDavClient(inner);
  await assert.rejects(() => client.getMetadata('/missing'));
  await assert.rejects(() => client.getMetadata('/missing'));
  assert.equal(inner.calls.getMetadata, 2, '404 を握って残さない');
});
