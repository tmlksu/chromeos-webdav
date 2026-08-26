/**
 * config.js のユニットテスト。chrome.storage はメモリ実装に差し替える。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUrl, shareIdFor, validateShare, ShareStore, STORAGE_KEY } from '../extension/config.js';

function memoryStorage(initial = {}) {
  let data = { ...initial };
  return {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (patch) => { data = { ...data, ...patch }; },
    _dump: () => data,
  };
}

test('normalizeUrl: 末尾スラッシュを落とす', () => {
  assert.equal(normalizeUrl('https://dav.example.com/'), 'https://dav.example.com');
  assert.equal(normalizeUrl('https://dav.example.com///'), 'https://dav.example.com');
  assert.equal(normalizeUrl('  https://dav.example.com  '), 'https://dav.example.com');
});

test('normalizeUrl: baseurl (サブパス) を保つ', () => {
  assert.equal(normalizeUrl('https://example.com/dav'), 'https://example.com/dav');
  assert.equal(normalizeUrl('https://example.com/dav/'), 'https://example.com/dav');
  assert.equal(normalizeUrl('https://example.com/a/b/'), 'https://example.com/a/b');
});

test('normalizeUrl: スキーム省略は https を補う', () => {
  assert.equal(normalizeUrl('dav.example.com'), 'https://dav.example.com');
  assert.equal(normalizeUrl('http://nas.local:8080'), 'http://nas.local:8080');
});

test('normalizeUrl: 既定ポートは畳まれ、非既定は残る', () => {
  assert.equal(normalizeUrl('https://example.com:443'), 'https://example.com');
  assert.equal(normalizeUrl('http://example.com:80'), 'http://example.com');
  assert.equal(normalizeUrl('http://example.com:8080'), 'http://example.com:8080');
});

test('normalizeUrl: 不正な入力は拒否する', () => {
  assert.throws(() => normalizeUrl(''), /空/);
  assert.throws(() => normalizeUrl('   '), /空/);
  assert.throws(() => normalizeUrl('ftp://example.com'), /http/);
  assert.throws(() => normalizeUrl('https://example.com/dav?a=1'), /クエリ/);
  assert.throws(() => normalizeUrl('https://example.com/dav#x'), /クエリ/);
});

test('shareIdFor: 決定的で、URL が違えば衝突しない', () => {
  const a = shareIdFor('https://dav.example.com');
  assert.equal(a, shareIdFor('https://dav.example.com'), '同じ URL なら同じ id');
  assert.notEqual(a, shareIdFor('https://dav.example.com/dav'));
  assert.notEqual(a, shareIdFor('http://dav.example.com'));
  assert.notEqual(shareIdFor('https://a.example.com/b'), shareIdFor('https://a.example.com_b'));
  assert.match(a, /^webdav-[a-zA-Z0-9._-]+$/, 'id に扱いにくい文字が混ざらないこと');
});

test('shareIdFor: 長い URL でも id が伸びすぎない', () => {
  const long = `https://example.com/${'segment/'.repeat(40)}`;
  assert.ok(shareIdFor(long).length < 80, shareIdFor(long));
});

test('validateShare: 正常系', () => {
  const { share, errors } = validateShare({
    name: 'Home NAS', url: 'https://dav.example.com/', authMode: 'none', autoMount: true,
  });
  assert.deepEqual(errors, []);
  assert.equal(share.url, 'https://dav.example.com');
  assert.equal(share.authMode, 'none');
  assert.equal(share.autoMount, true);
  assert.equal(share.id, shareIdFor('https://dav.example.com'));
});

test('validateShare: autoMount の既定は true', () => {
  const { share } = validateShare({ name: 'x', url: 'https://a.example.com' });
  assert.equal(share.autoMount, true);
  assert.equal(validateShare({ name: 'x', url: 'https://a.example.com', autoMount: false }).share.autoMount, false);
});

test('validateShare: 表示名と URL の不備を報告する', () => {
  assert.match(validateShare({ name: '', url: 'https://a.example.com' }).errors.join(), /表示名/);
  assert.match(validateShare({ name: 'x'.repeat(65), url: 'https://a.example.com' }).errors.join(), /64/);
  assert.match(validateShare({ name: 'x', url: 'ftp://a' }).errors.join(), /http/);
  assert.match(validateShare({ name: 'x', url: 'https://a', authMode: 'digest' }).errors.join(), /未知の認証方式/);
});

test('validateShare: Cloudflare Access を http に設定させない', () => {
  const { errors } = validateShare({ name: 'x', url: 'http://a.example.com', authMode: 'cloudflare-access' });
  assert.match(errors.join(), /https/);
});

test('validateShare: エラー時は share を返さない', () => {
  const { share, errors } = validateShare({ name: '', url: 'nope://x' });
  assert.equal(share, null);
  assert.ok(errors.length >= 2);
});

test('ShareStore: 保存・取得・一覧・削除', async () => {
  const storage = memoryStorage();
  const store = new ShareStore(storage);

  assert.deepEqual(await store.list(), []);

  const a = validateShare({ name: 'A', url: 'https://a.example.com' }).share;
  const b = validateShare({ name: 'B', url: 'https://b.example.com' }).share;
  await store.save(a);
  await store.save(b);

  assert.equal((await store.list()).length, 2);
  assert.equal((await store.get(a.id)).name, 'A');

  await store.remove(a.id);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.get(a.id), undefined);
});

test('ShareStore: 同じ URL の再保存は重複せず上書きされる', async () => {
  const store = new ShareStore(memoryStorage());
  await store.save(validateShare({ name: 'Old', url: 'https://a.example.com' }).share);
  await store.save(validateShare({ name: 'New', url: 'https://a.example.com/' }).share);

  const shares = await store.list();
  assert.equal(shares.length, 1, '末尾スラッシュ違いで重複した');
  assert.equal(shares[0].name, 'New');
});

test('ShareStore: 壊れた保存データでも落ちない', async () => {
  assert.deepEqual(await new ShareStore(memoryStorage({ [STORAGE_KEY]: 'garbage' })).list(), []);
  assert.deepEqual(await new ShareStore(memoryStorage({})).list(), []);
});

// --- Basic 認証 --------------------------------------------------------------

test('validateShare: Basic 認証はユーザー名が要る', () => {
  const { errors } = validateShare({ name: 'x', url: 'https://a.example.com', authMode: 'basic' });
  assert.match(errors.join(), /ユーザー名/);
});

test('validateShare: Basic 認証はパスワード空を許す (ユーザー名がトークンの構成)', () => {
  const { share, errors } = validateShare({
    name: 'x', url: 'https://a.example.com', authMode: 'basic', username: 'token',
  });
  assert.deepEqual(errors, []);
  assert.equal(share.username, 'token');
  assert.equal(share.password, '');
});

test('validateShare: Basic 認証を http に設定させない', () => {
  const { errors } = validateShare({
    name: 'x', url: 'http://a.example.com', authMode: 'basic', username: 'u', password: 'p',
  });
  assert.match(errors.join(), /https/);
});

test('validateShare: ユーザー名に : は使えない (RFC 7617)', () => {
  const { errors } = validateShare({
    name: 'x', url: 'https://a.example.com', authMode: 'basic', username: 'a:b', password: 'p',
  });
  assert.match(errors.join(), /:/);
});

test('validateShare: Basic 以外では資格情報を保存しない', () => {
  const { share } = validateShare({
    name: 'x', url: 'https://a.example.com', authMode: 'none', username: 'u', password: 'p',
  });
  assert.equal(share.username, undefined);
  assert.equal(share.password, undefined);
});
