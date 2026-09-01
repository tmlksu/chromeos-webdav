/**
 * 例外を FSP のエラーコードに写像する。
 *
 * background.js から切り出してある。chrome.* に触れないので Node からテストできる。
 * ここが雑だと「トンネルが落ちている」「設定が違う」「拡張のバグ」が
 * すべて FAILED に潰れ、ユーザは何を直せばいいのか分からなくなる。
 */

import { DavHttpError, DavTimeoutError } from './dav.js';
import { AccessAuthError, BasicAuthError } from './auth.js';

/**
 * @param {unknown} error
 * @returns {chrome.fileSystemProvider.ProviderError}
 */
export function toProviderError(error) {
  if (error instanceof DavHttpError) {
    if (error.status === 404) return 'NOT_FOUND';
    // 401 は資格情報が違う。Access の場合はここに来る前に auth.js が処理している。
    if (error.status === 401 || error.status === 403) return 'ACCESS_DENIED';
    if (error.status === 405 || error.status === 501) return 'INVALID_OPERATION';
    // 5xx はサーバか前段 (トンネル・プロキシ) が落ちている。設定でもバグでもないので
    // FAILED に潰さない。501 は上で INVALID_OPERATION に取られている (実装されていない
    // メソッドの意味であって、経路の障害ではないため)。
    if (error.status >= 500) return 'IO';
  }
  // 応答が返ってこない。5xx と同じく経路側の問題として扱う。
  if (error instanceof DavTimeoutError) return 'IO';
  if (error instanceof BasicAuthError) return 'ACCESS_DENIED';
  if (error instanceof AccessAuthError) return 'FAILED';
  return 'FAILED';
}
