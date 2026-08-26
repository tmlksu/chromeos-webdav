/**
 * ディレクトリ一覧で得たメタデータを短命にキャッシュする DavClient のラッパ。
 *
 * Files アプリはディレクトリを開くと onReadDirectoryRequested を 1 回投げたあと、
 * 表示のために子エントリ 1 件ずつに onGetMetadataRequested を投げてくる。
 * 素直に実装すると 1 + N 回の PROPFIND になり、トンネル越しだと
 * 1 往復の RTT がそのまま N 倍に積み上がる。
 *
 * Depth:1 の応答には既に全子エントリのメタデータが入っているので、
 * それを短い TTL で持っておけば直後の問い合わせは無通信で返せる。
 *
 * 拡張は読み取り専用なので、キャッシュが古くても壊れるものが無い。
 * それでも TTL を短くしてあるのは、サーバ側で変わったものが
 * いつまでも古いまま見えるのを避けるため。
 *
 * chrome.* に触れないので Node からそのままユニットテストできる。
 * service worker が落ちればキャッシュも消えるが、それは安全側の挙動。
 */

export const DEFAULT_TTL_MS = 5_000;

/** 保持するエントリ数の上限。巨大なディレクトリでメモリを持っていかれないように。 */
export const DEFAULT_MAX_ENTRIES = 4_096;

export class MetadataCache {
  /**
   * @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, {entry: object, expiresAt: number}>} */
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  get(path) {
    const hit = this.map.get(path);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.map.delete(path);
      return undefined;
    }
    return hit.entry;
  }

  set(path, entry) {
    // 入れ直しは最後尾に移す。Map は挿入順を保つので、これで古いものから落とせる。
    this.map.delete(path);
    this.map.set(path, { entry, expiresAt: this.now() + this.ttlMs });
    this._evict();
  }

  setMany(entries) {
    for (const entry of entries) {
      if (entry && entry.path) this.set(entry.path, entry);
    }
  }

  clear() {
    this.map.clear();
  }

  _evict() {
    if (this.map.size <= this.maxEntries) return;
    for (const key of this.map.keys()) {
      this.map.delete(key);
      if (this.map.size <= this.maxEntries) return;
    }
  }
}

/**
 * DavClient と同じ形をしていて、メタデータだけキャッシュから返す。
 * readRange は素通し (中身はキャッシュしない — Range GET で必要分だけ取るのが前提)。
 */
export class CachedDavClient {
  /**
   * @param {import('./dav.js').DavClient} client
   * @param {ConstructorParameters<typeof MetadataCache>[0]} [options]
   */
  constructor(client, options = {}) {
    this.client = client;
    this.cache = new MetadataCache(options);
  }

  async getMetadata(path) {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const entry = await this.client.getMetadata(path);
    this.cache.set(path, entry);
    return entry;
  }

  async readDirectory(path) {
    const entries = await this.client.readDirectory(path);
    // ここで入れたぶんが、直後に来る 1 件ずつの getMetadata を無通信にする
    this.cache.setMany(entries);
    return entries;
  }

  readRange(path, offset, length) {
    return this.client.readRange(path, offset, length);
  }
}
