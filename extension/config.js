/**
 * 共有設定の保存・検証。chrome.storage.local に置く。
 * chrome.* をトップレベルで参照しないので Node からユニットテストできる
 * (storage は依存注入で差し替える)。
 */

export const AUTH_MODES = /** @type {const} */ (['none', 'cloudflare-access']);
export const STORAGE_KEY = 'shares';

/** @typedef {{id: string, name: string, url: string, authMode: 'none'|'cloudflare-access', autoMount: boolean}} Share */

/**
 * 入力 URL を正規化する。末尾スラッシュを落とし、既定ポートを畳む。
 * baseurl 付き (https://host/dav) もそのまま保持する。
 */
export function normalizeUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('URL が空です');

  // スキームを省いた入力には https を補う。ただし
  //   'nas.local:8080' (host:port) と 'ftp://host' (別スキーム) を取り違えないよう、
  //   '://' が付いている場合だけスキームとして判定する。
  //   これをやらないと 'ftp://example.com' が 'https://ftp//example.com' に化ける。
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    throw new Error(`http/https 以外は使えません: ${scheme}://`);
  }

  let url;
  try {
    url = new URL(scheme ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`URL として解釈できません: ${trimmed}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`http/https 以外は使えません: ${url.protocol}`);
  }
  if (url.search || url.hash) {
    throw new Error('URL にクエリやフラグメントは付けられません');
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** FNV-1a。id をぶつけないための短いハッシュ。暗号用途ではない。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 正規化済み URL から決定的な fileSystemId を作る。
 * 同じ URL を消して足し直しても同じ id になるので、
 * ChromeOS 側に残ったマウント状態と食い違わない。
 */
export function shareIdFor(normalizedUrl) {
  const slug = normalizedUrl
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 48);
  return `webdav-${slug}-${fnv1a(normalizedUrl)}`;
}

/** @returns {{share: Share|null, errors: string[]}} */
export function validateShare(input) {
  const errors = [];

  const name = String(input?.name || '').trim();
  if (!name) errors.push('表示名を入力してください');
  if (name.length > 64) errors.push('表示名は 64 文字以内にしてください');

  const authMode = input?.authMode || 'none';
  if (!AUTH_MODES.includes(authMode)) errors.push(`未知の認証方式: ${authMode}`);

  let url = null;
  try {
    url = normalizeUrl(input?.url);
  } catch (error) {
    errors.push(error.message);
  }

  if (url && authMode === 'cloudflare-access' && url.startsWith('http://')) {
    errors.push('Cloudflare Access は https でのみ使えます');
  }

  if (errors.length) return { share: null, errors };

  return {
    share: {
      id: shareIdFor(url),
      name,
      url,
      authMode,
      autoMount: input?.autoMount !== false,
    },
    errors: [],
  };
}

/** chrome.storage.local を薄く包む。テストではメモリ実装を渡す。 */
export class ShareStore {
  constructor(storage) {
    this.storage = storage || (typeof chrome !== 'undefined' ? chrome.storage.local : null);
  }

  /** @returns {Promise<Share[]>} */
  async list() {
    const stored = await this.storage.get(STORAGE_KEY);
    const shares = stored?.[STORAGE_KEY];
    return Array.isArray(shares) ? shares : [];
  }

  /** @returns {Promise<Share|undefined>} */
  async get(id) {
    return (await this.list()).find((share) => share.id === id);
  }

  /** 同じ id があれば置き換える (URL が同じなら同じ id になる)。 */
  async save(share) {
    const shares = await this.list();
    const index = shares.findIndex((existing) => existing.id === share.id);
    if (index === -1) shares.push(share);
    else shares[index] = share;
    await this.storage.set({ [STORAGE_KEY]: shares });
    return share;
  }

  async remove(id) {
    const shares = await this.list();
    await this.storage.set({ [STORAGE_KEY]: shares.filter((share) => share.id !== id) });
  }
}
