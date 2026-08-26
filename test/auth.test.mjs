/**
 * auth.js のユニットテスト。chrome.tabs / chrome.cookies はスタブに差し替える。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AccessAuth,
  AccessAuthError,
  BasicAuth,
  BasicAuthError,
  basicCredentials,
  createAuth,
  isAuthExpired,
  cookieDomainMatches,
  ACCESS_COOKIE,
} from '../extension/auth.js';

const ORIGIN = 'https://dav.example.com';

function makeStubs() {
  const listeners = new Set();
  const state = { cookie: null, tabs: new Map(), nextTabId: 1, created: 0, removed: [] };

  const cookies = {
    get: async ({ name }) => (name === ACCESS_COOKIE && state.cookie ? state.cookie : null),
    onChanged: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
    },
  };
  const tabs = {
    create: async ({ url }) => {
      const id = state.nextTabId++;
      state.tabs.set(id, { id, url });
      state.created++;
      return { id, url };
    },
    get: async (id) => {
      if (!state.tabs.has(id)) throw new Error('no such tab');
      return state.tabs.get(id);
    },
    update: async (id) => state.tabs.get(id),
    remove: async (id) => {
      state.removed.push(id);
      state.tabs.delete(id);
    },
  };

  /** ユーザーがログインを終えて Access が cookie を設置した状況を再現する。 */
  const completeLogin = (domain = 'dav.example.com') => {
    state.cookie = { name: ACCESS_COOKIE, domain, value: 'jwt' };
    for (const fn of [...listeners]) fn({ removed: false, cookie: state.cookie });
  };

  return { cookies, tabs, state, completeLogin, listenerCount: () => listeners.size };
}

const redirected = () => ({ type: 'opaqueredirect', status: 0, ok: false });
const ok = (body = '') => ({ type: 'basic', status: 200, ok: true, text: async () => body });

test('isAuthExpired: リダイレクトと 401 のみ失効扱い', () => {
  assert.equal(isAuthExpired({ type: 'opaqueredirect', status: 0 }), true);
  assert.equal(isAuthExpired({ status: 0 }), true);
  assert.equal(isAuthExpired({ status: 401 }), true);
  assert.equal(isAuthExpired({ status: 302 }), true);

  // 404/403 で失効判定するとログインタブが暴発するので false であること
  assert.equal(isAuthExpired({ status: 404, ok: false }), false);
  assert.equal(isAuthExpired({ status: 403, ok: false }), false);
  assert.equal(isAuthExpired({ status: 500, ok: false }), false);
  assert.equal(isAuthExpired({ status: 207, ok: true }), false);
  assert.equal(isAuthExpired(null), false);
});

test('cookieDomainMatches', () => {
  assert.equal(cookieDomainMatches('dav.example.com', 'dav.example.com'), true);
  assert.equal(cookieDomainMatches('.example.com', 'dav.example.com'), true);
  assert.equal(cookieDomainMatches('example.com', 'dav.example.com'), true);
  assert.equal(cookieDomainMatches('other.net', 'dav.example.com'), false);
  assert.equal(cookieDomainMatches('example.com', 'evilexample.com'), false);
  assert.equal(cookieDomainMatches('', 'dav.example.com'), false);
});

test('fetch: 認証済みならそのまま返し、ログインタブを開かない', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, {
    deps: { ...stubs, fetch: async () => ok('<xml/>') },
  });
  const response = await auth.fetch(`${ORIGIN}/`);
  assert.equal(response.status, 200);
  assert.equal(stubs.state.created, 0);
});

test('fetch: 失効を検知したらログイン後に再試行して成功する', async () => {
  const stubs = makeStubs();
  let call = 0;
  const auth = new AccessAuth(ORIGIN, {
    deps: {
      ...stubs,
      fetch: async () => (++call === 1 ? redirected() : ok('<xml/>')),
    },
  });

  const promise = auth.fetch(`${ORIGIN}/`);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stubs.state.created, 1, 'ログインタブが開かれていない');
  stubs.completeLogin();

  const response = await promise;
  assert.equal(response.status, 200);
  assert.equal(call, 2, '再試行されていない');
  assert.deepEqual(stubs.state.removed, [1], '認証後にログインタブが閉じられていない');
  assert.equal(stubs.listenerCount(), 0, 'cookie リスナが残っている');
});

test('fetch: 再試行後もリダイレクトなら AccessAuthError', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, { deps: { ...stubs, fetch: async () => redirected() } });

  const promise = auth.fetch(`${ORIGIN}/`);
  await new Promise((r) => setTimeout(r, 10));
  stubs.completeLogin();

  await assert.rejects(() => promise, (error) => {
    assert.ok(error instanceof AccessAuthError);
    assert.equal(error.code, 'still_unauthenticated');
    return true;
  });
});

test('single-flight: 同時 3 リクエストでもログインタブは 1 つだけ', async () => {
  const stubs = makeStubs();
  let call = 0;
  const auth = new AccessAuth(ORIGIN, {
    deps: {
      ...stubs,
      fetch: async () => (stubs.state.cookie ? ok() : (call++, redirected())),
    },
  });

  const all = Promise.all([auth.fetch(`${ORIGIN}/a`), auth.fetch(`${ORIGIN}/b`), auth.fetch(`${ORIGIN}/c`)]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stubs.state.created, 1, `タブが ${stubs.state.created} 個開いた`);
  stubs.completeLogin();

  const responses = await all;
  assert.equal(responses.length, 3);
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(stubs.state.removed, [1]);
});

test('ログイン待ちの取りこぼし: リスナ登録前に cookie があっても解決する', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, { deps: { ...stubs, fetch: async () => ok() } });
  // hasCookie は true だが onChanged は二度と発火しない状況
  stubs.state.cookie = { name: ACCESS_COOKIE, domain: 'dav.example.com', value: 'jwt' };
  await auth.login(); // 即座に解決すること (hasCookie の早期リターン)
  assert.equal(stubs.state.created, 0);
});

test('タイムアウト: 90s 相当で AccessAuthError(timeout)、タブは閉じない', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, {
    timeoutMs: 40,
    deps: { ...stubs, fetch: async () => redirected() },
  });

  await assert.rejects(() => auth.fetch(`${ORIGIN}/`), (error) => {
    assert.ok(error instanceof AccessAuthError);
    assert.equal(error.code, 'timeout');
    return true;
  });
  assert.equal(stubs.state.created, 1);
  assert.deepEqual(stubs.state.removed, [], 'MFA 入力中の可能性があるためタブは残す');
  assert.equal(stubs.listenerCount(), 0, 'タイムアウト時も cookie リスナを外すこと');
});

test('タイムアウト後の再ログインは既存タブを使い回す', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, {
    timeoutMs: 30,
    deps: { ...stubs, fetch: async () => redirected() },
  });

  await assert.rejects(() => auth.login());
  assert.equal(stubs.state.created, 1);

  const second = auth.login();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stubs.state.created, 1, '2 枚目のタブが開かれた');
  stubs.completeLogin();
  await second;
});

test('別ドメインの CF_Authorization では解決しない', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, {
    timeoutMs: 40,
    deps: { ...stubs, fetch: async () => redirected() },
  });

  const promise = auth.login();
  await new Promise((r) => setTimeout(r, 5));
  // 無関係なドメインの cookie が飛んできても無視されること
  stubs.completeLogin('unrelated.example.com');
  // completeLogin は state.cookie も立ててしまうので、ここでは戻しておく
  stubs.state.cookie = null;

  await assert.rejects(() => promise, (error) => error.code === 'timeout');
});

test('ensureAuthenticated: get-identity が 200 なら何もしない', async () => {
  const stubs = makeStubs();
  const urls = [];
  const auth = new AccessAuth(ORIGIN, {
    deps: { ...stubs, fetch: async (url) => (urls.push(url), ok('{}')) },
  });
  assert.equal(await auth.ensureAuthenticated(), true);
  assert.equal(urls[0], `${ORIGIN}/cdn-cgi/access/get-identity`);
  assert.equal(stubs.state.created, 0);
});

test('ensureAuthenticated: 未認証ならログインタブを出す', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, { deps: { ...stubs, fetch: async () => redirected() } });

  const promise = auth.ensureAuthenticated();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stubs.state.created, 1);
  stubs.completeLogin();
  assert.equal(await promise, true);
});

test('ensureAuthenticated: 5xx はログイン不要 (失効ではない)', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, {
    deps: { ...stubs, fetch: async () => ({ status: 502, ok: false }) },
  });
  assert.equal(await auth.ensureAuthenticated(), true);
  assert.equal(stubs.state.created, 0);
});

test('ensureAuthenticated: ネットワーク断は false を返す', async () => {
  const stubs = makeStubs();
  const auth = new AccessAuth(ORIGIN, {
    deps: { ...stubs, fetch: async () => { throw new TypeError('Failed to fetch'); } },
  });
  assert.equal(await auth.ensureAuthenticated(), false);
  assert.equal(stubs.state.created, 0);
});

test('fetch は credentials:include / redirect:manual を必ず付ける', async () => {
  const stubs = makeStubs();
  let seen = null;
  const auth = new AccessAuth(ORIGIN, {
    deps: { ...stubs, fetch: async (_url, init) => { seen = init; return ok(); } },
  });
  await auth.fetch(`${ORIGIN}/`, { method: 'PROPFIND', headers: { Depth: '1' } });
  assert.equal(seen.credentials, 'include');
  assert.equal(seen.redirect, 'manual');
  assert.equal(seen.method, 'PROPFIND');
  assert.equal(seen.headers.Depth, '1');
});

// --- Basic 認証 --------------------------------------------------------------

/** 渡された init を記録して、指定のレスポンスを返す fetch。 */
function recordingFetch(response = { ok: true, status: 207, url: `${ORIGIN}/` }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { calls, fetchImpl };
}

test('basicCredentials: RFC 7617 の base64', () => {
  assert.equal(basicCredentials('Aladdin', 'open sesame'), 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
});

test('basicCredentials: 非 ASCII は UTF-8 で符号化する (btoa に直接渡すと落ちる)', () => {
  const encoded = basicCredentials('ユーザー', 'パスワード');
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  assert.equal(decoded, 'ユーザー:パスワード');
});

test('basicCredentials: パスワード空でも : は残る', () => {
  assert.equal(Buffer.from(basicCredentials('token', ''), 'base64').toString('utf8'), 'token:');
});

test('BasicAuth: Authorization を付け、cookie は送らない', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const auth = new BasicAuth(ORIGIN, { username: 'u', password: 'p', deps: { fetch: fetchImpl } });

  await auth.fetch(`${ORIGIN}/dir`, { method: 'PROPFIND', headers: { Depth: '1' } });

  const { init } = calls[0];
  assert.equal(init.headers.Authorization, `Basic ${basicCredentials('u', 'p')}`);
  assert.equal(init.headers.Depth, '1', '元のヘッダを消さない');
  assert.equal(init.method, 'PROPFIND');
  assert.equal(init.credentials, 'omit');
});

test('BasicAuth: 別オリジンへのリダイレクト先は弾く (資格情報の漏洩を避ける)', async () => {
  const { fetchImpl } = recordingFetch({ ok: true, status: 200, url: 'https://evil.example.net/' });
  const auth = new BasicAuth(ORIGIN, { username: 'u', password: 'p', deps: { fetch: fetchImpl } });
  await assert.rejects(() => auth.fetch(`${ORIGIN}/dir`), BasicAuthError);
});

test('BasicAuth: 同一オリジン内のリダイレクトは通す', async () => {
  const { fetchImpl } = recordingFetch({ ok: true, status: 207, url: `${ORIGIN}/dir/` });
  const auth = new BasicAuth(ORIGIN, { username: 'u', password: 'p', deps: { fetch: fetchImpl } });
  const response = await auth.fetch(`${ORIGIN}/dir`);
  assert.equal(response.status, 207);
});

test('BasicAuth: ensureAuthenticated は通信しない', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const auth = new BasicAuth(ORIGIN, { username: 'u', password: 'p', deps: { fetch: fetchImpl } });
  assert.equal(await auth.ensureAuthenticated(), true);
  assert.equal(calls.length, 0);
});

test('createAuth: authMode basic で BasicAuth を返し、資格情報を渡す', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const auth = createAuth(
    { url: ORIGIN, authMode: 'basic', username: 'u', password: 'p' },
    { deps: { fetch: fetchImpl } },
  );
  assert.ok(auth instanceof BasicAuth);
  await auth.fetch(`${ORIGIN}/`);
  assert.equal(calls[0].init.headers.Authorization, `Basic ${basicCredentials('u', 'p')}`);
});
