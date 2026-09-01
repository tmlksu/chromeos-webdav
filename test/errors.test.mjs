/**
 * FSP エラー写像のテスト。
 *
 * ここが雑だと「トンネルが落ちている」「設定が違う」「拡張のバグ」が
 * すべて FAILED に潰れ、ユーザから区別できなくなる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toProviderError } from '../extension/errors.js';
import { DavHttpError, DavTimeoutError } from '../extension/dav.js';
import { AccessAuthError, BasicAuthError } from '../extension/auth.js';

test('404 は NOT_FOUND', () => {
  assert.equal(toProviderError(new DavHttpError(404)), 'NOT_FOUND');
});

test('401 と 403 は ACCESS_DENIED', () => {
  assert.equal(toProviderError(new DavHttpError(401)), 'ACCESS_DENIED');
  assert.equal(toProviderError(new DavHttpError(403)), 'ACCESS_DENIED');
});

test('405 と 501 は INVALID_OPERATION (WebDAV ではない / 未実装メソッド)', () => {
  assert.equal(toProviderError(new DavHttpError(405)), 'INVALID_OPERATION');
  assert.equal(toProviderError(new DavHttpError(501)), 'INVALID_OPERATION');
});

test('5xx は IO — 経路が落ちている。設定ミスやバグと同じ FAILED に潰さない', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(toProviderError(new DavHttpError(status)), 'IO', `status ${status}`);
  }
});

test('501 は 5xx の分岐に食われない', () => {
  // 501 は「そのメソッドを実装していない」であって経路の障害ではない
  assert.equal(toProviderError(new DavHttpError(501)), 'INVALID_OPERATION');
});

test('タイムアウトは IO', () => {
  assert.equal(toProviderError(new DavTimeoutError('刺さった')), 'IO');
});

test('Basic 認証のオリジン違反は ACCESS_DENIED', () => {
  assert.equal(toProviderError(new BasicAuthError('別オリジン')), 'ACCESS_DENIED');
});

test('Access の認証失敗は FAILED', () => {
  assert.equal(toProviderError(new AccessAuthError('timeout')), 'FAILED');
});

test('知らない例外は FAILED', () => {
  assert.equal(toProviderError(new Error('なにか')), 'FAILED');
  assert.equal(toProviderError(undefined), 'FAILED');
});

test('経路の障害と設定の誤りが別のコードになる', () => {
  // dav-fsm の運用メモが挙げていた「トンネル断 / バグ / 認証不良が区別できない」への回帰テスト
  const tunnelDown = toProviderError(new DavHttpError(502));
  const stalled = toProviderError(new DavTimeoutError('刺さった'));
  const badAuth = toProviderError(new DavHttpError(401));
  const bug = toProviderError(new Error('undefined is not a function'));

  assert.equal(tunnelDown, stalled, '経路側の 2 つは同じ扱いでよい');
  assert.notEqual(tunnelDown, badAuth);
  assert.notEqual(tunnelDown, bug);
  assert.notEqual(badAuth, bug);
});
