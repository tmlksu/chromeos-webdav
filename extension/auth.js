/**
 * 認証方式ごとの fetch ラッパ。
 *
 * - NoAuth: そのまま fetch する。Tailscale / VPN / LAN 内など、
 *   ネットワーク層で守っている構成向け。
 * - AccessAuth: Cloudflare Access (self-hosted app) に対する認証フロー。
 *
 * ---
 *
 * Cloudflare Access は未認証リクエストを IdP のログインページへ 302 で飛ばす。
 * fetch は redirect:'manual' で投げるため、その 302 は opaqueredirect
 * (status 0 / body 読み取り不可) として観測される。これを失効シグナルとして扱い、
 * ログインタブを開き、CF_Authorization cookie の設置を待って元のリクエストを再開する。
 *
 * 同時に走る複数の FSP リクエストがそれぞれログインタブを開かないよう、
 * ログイン処理は single-flight ゲートで 1 本に束ねる。
 */

export const ACCESS_COOKIE = 'CF_Authorization';
export const AUTH_TIMEOUT_MS = 90_000;
const IDENTITY_PATH = '/cdn-cgi/access/get-identity';

export class AccessAuthError extends Error {
  /** @param {'timeout'|'still_unauthenticated'|'tab_failed'} code */
  constructor(code, message) {
    super(message || code);
    this.name = 'AccessAuthError';
    this.code = code;
  }
}

/**
 * Access セッション失効とみなすレスポンスか。
 *
 * 404 や 403 まで失効扱いにすると、存在しないファイルやポリシー拒否のたびに
 * ログインタブが開いてしまう。失効と断定できるのはリダイレクトと 401 だけ。
 */
export function isAuthExpired(response) {
  if (!response) return false;
  if (response.type === 'opaqueredirect') return true;
  if (response.status === 0) return true;
  if (response.status === 401) return true;
  // redirect:'manual' でも同一オリジンのリダイレクトが素通しされる実装向け
  if (response.status >= 300 && response.status < 400) return true;
  return false;
}

/** cookie の domain 属性がこのホストに効くか。'.example.com' のような形も許す。 */
export function cookieDomainMatches(cookieDomain, hostname) {
  if (!cookieDomain) return false;
  const domain = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export class AccessAuth {
  /**
   * @param {string} origin 例: 'https://dav.example.com'
   * @param {{timeoutMs?: number, deps?: object}} [options]
   *        deps はテスト用の chrome API / fetch 差し替え口。
   */
  constructor(origin, options = {}) {
    this.origin = new URL(origin).origin;
    this.hostname = new URL(origin).hostname;
    this.timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;

    const deps = options.deps || {};
    this.fetchImpl = deps.fetch || ((...args) => fetch(...args));
    this.tabs = deps.tabs || (typeof chrome !== 'undefined' ? chrome.tabs : null);
    this.cookies = deps.cookies || (typeof chrome !== 'undefined' ? chrome.cookies : null);

    /** @type {Promise<void>|null} 進行中のログイン。single-flight ゲート。 */
    this._loginInFlight = null;
    /** @type {number|null} タイムアウト後も開いたままのログインタブ。 */
    this._loginTabId = null;

    // 外に渡して使うため this を固定する
    this.fetch = this.fetch.bind(this);
  }

  _raw(url, init = {}) {
    return this.fetchImpl(url, {
      ...init,
      credentials: 'include',
      redirect: 'manual',
    });
  }

  /**
   * 認証を面倒みる fetch。失効を検知したらログインを挟んで 1 度だけ再試行する。
   * @returns {Promise<Response>}
   */
  async fetch(url, init = {}) {
    const first = await this._raw(url, init);
    if (!isAuthExpired(first)) return first;

    await this.login();

    const second = await this._raw(url, init);
    if (isAuthExpired(second)) {
      throw new AccessAuthError('still_unauthenticated', `認証後も Access に弾かれた: ${url}`);
    }
    return second;
  }

  /** マウント時のプリフライト。未認証なら先にログインタブを出す。 */
  async ensureAuthenticated() {
    let response;
    try {
      response = await this._raw(`${this.origin}${IDENTITY_PATH}`, { method: 'GET' });
    } catch {
      // ネットワーク断はログインでは解決しない。呼び出し側で扱う。
      return false;
    }
    if (response.ok) return true;
    if (!isAuthExpired(response)) return true; // Access 以外の理由 (5xx 等) は失効ではない
    await this.login();
    return true;
  }

  /** 同時呼び出しを 1 本のログイン処理に束ねる。 */
  login() {
    if (this._loginInFlight) return this._loginInFlight;
    this._loginInFlight = this._doLogin().finally(() => {
      this._loginInFlight = null;
    });
    return this._loginInFlight;
  }

  async hasCookie() {
    if (!this.cookies) return false;
    try {
      const cookie = await this.cookies.get({ url: `${this.origin}/`, name: ACCESS_COOKIE });
      return Boolean(cookie);
    } catch {
      return false;
    }
  }

  async _openLoginTab() {
    // タイムアウトで開いたままのタブが残っていれば使い回す
    if (this._loginTabId != null && this.tabs.get) {
      try {
        await this.tabs.get(this._loginTabId);
        await this.tabs.update(this._loginTabId, { active: true });
        return this._loginTabId;
      } catch {
        this._loginTabId = null;
      }
    }
    const tab = await this.tabs.create({ url: `${this.origin}/`, active: true });
    this._loginTabId = tab?.id ?? null;
    return this._loginTabId;
  }

  async _closeLoginTab() {
    const tabId = this._loginTabId;
    this._loginTabId = null;
    if (tabId == null) return;
    try {
      await this.tabs.remove(tabId);
    } catch {
      /* 既にユーザーが閉じている */
    }
  }

  async _doLogin() {
    if (await this.hasCookie()) return; // 別の待ち手が済ませていた

    if (!this.tabs || !this.cookies) {
      throw new AccessAuthError('tab_failed', 'chrome.tabs / chrome.cookies が使えない');
    }

    await this._openLoginTab();

    let onChanged = null;
    let timer = null;
    try {
      await new Promise((resolve, reject) => {
        onChanged = (changeInfo) => {
          if (changeInfo.removed) return;
          const cookie = changeInfo.cookie;
          if (!cookie || cookie.name !== ACCESS_COOKIE) return;
          if (!cookieDomainMatches(cookie.domain, this.hostname)) return;
          resolve();
        };
        this.cookies.onChanged.addListener(onChanged);

        timer = setTimeout(
          () => reject(new AccessAuthError('timeout', `Access ログインが ${this.timeoutMs}ms 以内に完了しなかった`)),
          this.timeoutMs,
        );

        // リスナ登録前に cookie が設置されていた場合の取りこぼしを防ぐ
        this.hasCookie().then((has) => { if (has) resolve(); }).catch(() => {});
      });
    } catch (error) {
      // タイムアウト時はタブを閉じない。ユーザーがまだ MFA 入力中の可能性がある。
      // 次のログイン要求では _openLoginTab がこのタブを再利用する。
      throw error;
    } finally {
      if (onChanged) this.cookies.onChanged.removeListener(onChanged);
      if (timer !== null) clearTimeout(timer);
    }

    await this._closeLoginTab();
  }
}

/**
 * 認証なし。ネットワーク層で守られている前提の構成向け。
 *
 * credentials は 'omit'。リバースプロキシが無関係な cookie を見て
 * 挙動を変えることがあるため、送らないほうが事故が少ない。
 * リダイレクトは追う (baseurl の正規化などで 301 を返すサーバがある)。
 */
export class NoAuth {
  constructor(origin, options = {}) {
    this.origin = new URL(origin).origin;
    const deps = options.deps || {};
    this.fetchImpl = deps.fetch || ((...args) => fetch(...args));
    this.fetch = this.fetch.bind(this);
  }

  fetch(url, init = {}) {
    return this.fetchImpl(url, { ...init, credentials: 'omit', redirect: 'follow' });
  }

  async ensureAuthenticated() {
    return true;
  }
}

/**
 * 共有設定から認証実装を選ぶ。
 * @param {{url: string, authMode: 'none'|'cloudflare-access'}} share
 */
export function createAuth(share, options = {}) {
  switch (share.authMode) {
    case 'cloudflare-access':
      return new AccessAuth(share.url, options);
    case 'none':
      return new NoAuth(share.url, options);
    default:
      throw new Error(`未知の認証方式: ${share.authMode}`);
  }
}
