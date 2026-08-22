/**
 * 依存ゼロの WebDAV クライアント。
 *
 * service worker では DOMParser が使えないため、PROPFIND のレスポンスは
 * 専用の小さな XML スキャナで読む。正規表現ではなくタグ単位で走査するので、
 * 属性内の '>' や自己閉じタグ、複数 propstat といった実際に出てくる形を取り違えない。
 *
 * chrome.* に一切触れないので Node からそのままユニットテストできる。
 */

const XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** XML の文字参照・定義済み実体を戻す。 */
export function decodeXmlText(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = XML_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/** タグの終端 '>' を、引用符で囲まれた属性値を跨がずに探す。 */
function findTagEnd(xml, start) {
  let quote = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/** 名前空間プレフィックスを落とした要素名。WebDAV サーバごとに D:/d:/lp1: と揺れるため。 */
function localName(qname) {
  const colon = qname.indexOf(':');
  return (colon === -1 ? qname : qname.slice(colon + 1)).toLowerCase();
}

/**
 * XML を open/close/text イベント列にする最小スキャナ。
 * 宣言・コメント・DOCTYPE は読み飛ばし、CDATA は実体復元せずそのまま text にする。
 */
function* scanXml(xml) {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i) {
      const raw = xml.slice(i, lt);
      if (raw.trim() !== '') yield { type: 'text', value: decodeXmlText(raw) };
    }

    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      if (end === -1) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end === -1) return;
      yield { type: 'text', value: xml.slice(lt + 9, end) };
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = findTagEnd(xml, lt);
      if (end === -1) return;
      i = end + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt);
    if (gt === -1) return;
    let body = xml.slice(lt + 1, gt);
    const isClose = body[0] === '/';
    if (isClose) body = body.slice(1);
    const isSelfClose = body.endsWith('/');
    if (isSelfClose) body = body.slice(0, -1);

    const qname = body.split(/[\s/]/, 1)[0];
    if (qname) {
      const name = localName(qname);
      if (isClose) {
        yield { type: 'close', name };
      } else {
        yield { type: 'open', name };
        if (isSelfClose) yield { type: 'close', name };
      }
    }
    i = gt + 1;
  }

  if (i < xml.length) {
    const raw = xml.slice(i);
    if (raw.trim() !== '') yield { type: 'text', value: decodeXmlText(raw) };
  }
}

function statusIsOk(statusLine) {
  // "HTTP/1.1 200 OK" → 200
  const match = /\s(\d{3})\s?/.exec(statusLine || '');
  if (!match) return true; // status 省略は 200 扱い (RFC 4918 上は必須だが寛容に)
  const code = Number(match[1]);
  return code >= 200 && code < 300;
}

/** href の path 部分だけを取り出す。絶対 URL 形式の href を返すサーバもあるため。 */
function hrefToRawPath(href) {
  const trimmed = href.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const schemeEnd = trimmed.indexOf('://') + 3;
    const slash = trimmed.indexOf('/', schemeEnd);
    return slash === -1 ? '/' : trimmed.slice(slash);
  }
  return trimmed;
}

/** パーセントエンコードされたパスをセグメント単位でデコードする。 */
export function decodePath(rawPath) {
  const query = rawPath.indexOf('?');
  const path = query === -1 ? rawPath : rawPath.slice(0, query);
  return path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // 不正な % シーケンスは生のまま通す
      }
    })
    .join('/');
}

/** デコード済みパスを URL パスへ戻す。セグメント内の '/' は %2F になる。 */
export function encodePath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** 末尾スラッシュを落とす (ルート '/' は保つ)。 */
export function normalizePath(path) {
  if (!path || path === '/') return '/';
  const withLeading = path[0] === '/' ? path : `/${path}`;
  return withLeading.length > 1 && withLeading.endsWith('/')
    ? withLeading.slice(0, -1)
    : withLeading;
}

export function basename(path) {
  const normalized = normalizePath(path);
  if (normalized === '/') return '';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function joinPath(dir, name) {
  const base = normalizePath(dir);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/**
 * multistatus を解析してエントリ配列にする。
 *
 * - 名前空間プレフィックスに依存しない
 * - propstat が複数ある場合、2xx のものだけを採用する
 *   (rclone は prop 限定 PROPFIND に対し 200 と 404 の propstat を分けて返す)
 * - name は displayname ではなく href から導出する。FSP に返した name は
 *   そのまま次のリクエストのパスとして戻ってくるため、href と往復一致する必要がある。
 *
 * @param {string} xml
 * @param {{baseUrlPath?: string}} [options] サーバの baseurl。付いていれば path から剥がす。
 * @returns {Array<{path: string, name: string, isDirectory: boolean, size: number,
 *                  modificationTime: Date|null, mimeType: string|null, displayName: string|null}>}
 */
export function parseMultiStatus(xml, options = {}) {
  const baseUrlPath = normalizePath(options.baseUrlPath || '/');
  const entries = [];

  const stack = [];
  let response = null;
  let propstat = null;
  let propDepth = -1;
  let currentProp = null;
  let text = '';
  let inResourceType = false;

  for (const event of scanXml(xml)) {
    if (event.type === 'text') {
      text += event.value;
      continue;
    }

    if (event.type === 'open') {
      stack.push(event.name);

      if (event.name === 'response') {
        response = { href: null, props: {}, isCollection: false };
      } else if (event.name === 'propstat' && response) {
        propstat = { props: {}, isCollection: false, status: null };
      } else if (event.name === 'prop' && propstat) {
        propDepth = stack.length;
      } else if (propstat && propDepth !== -1 && stack.length === propDepth + 1) {
        currentProp = event.name;
        inResourceType = event.name === 'resourcetype';
      } else if (inResourceType && event.name === 'collection') {
        propstat.isCollection = true;
      }
      text = '';
      continue;
    }

    // close
    const name = event.name;
    const value = text;
    text = '';

    if (name === 'href' && response && propDepth === -1) {
      response.href = value;
    } else if (propstat && propDepth !== -1 && stack.length === propDepth + 1) {
      if (currentProp) propstat.props[currentProp] = value;
      if (name === 'resourcetype') inResourceType = false;
      currentProp = null;
    } else if (name === 'prop' && propstat) {
      propDepth = -1;
    } else if (name === 'status' && propstat && propDepth === -1) {
      propstat.status = value;
    } else if (name === 'propstat' && response && propstat) {
      if (statusIsOk(propstat.status)) {
        Object.assign(response.props, propstat.props);
        if (propstat.isCollection) response.isCollection = true;
      }
      propstat = null;
    } else if (name === 'response' && response) {
      const entry = buildEntry(response, baseUrlPath);
      if (entry) entries.push(entry);
      response = null;
    }

    stack.pop();
  }

  return entries;
}

function buildEntry(response, baseUrlPath) {
  if (response.href === null) return null;

  const rawPath = hrefToRawPath(response.href);
  const hadTrailingSlash = rawPath.length > 1 && rawPath.endsWith('/');
  let path = normalizePath(decodePath(rawPath));

  if (baseUrlPath !== '/') {
    if (path === baseUrlPath) {
      path = '/';
    } else if (path.startsWith(`${baseUrlPath}/`)) {
      path = path.slice(baseUrlPath.length);
    }
  }

  const isDirectory = response.isCollection || hadTrailingSlash;
  const rawSize = response.props.getcontentlength;
  const size = isDirectory || !rawSize ? 0 : Number.parseInt(rawSize, 10) || 0;

  const rawModified = response.props.getlastmodified;
  let modificationTime = null;
  if (rawModified) {
    const parsed = new Date(rawModified);
    if (!Number.isNaN(parsed.getTime())) modificationTime = parsed;
  }

  const displayName = response.props.displayname || null;

  return {
    path,
    name: basename(path),
    isDirectory,
    size,
    modificationTime,
    mimeType: response.props.getcontenttype || null,
    displayName,
  };
}

/** HTTP ステータスを保持するエラー。呼び出し側が FSP のエラーコードに写像する。 */
export class DavHttpError extends Error {
  constructor(status, message) {
    super(message || `WebDAV request failed with status ${status}`);
    this.name = 'DavHttpError';
    this.status = status;
  }
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  '<D:resourcetype/><D:getcontentlength/><D:getlastmodified/>' +
  '<D:displayname/><D:getcontenttype/>' +
  '</D:prop></D:propfind>';

export class DavClient {
  /**
   * @param {string} baseUrl 例: 'https://dav.example.com' または 'https://host/dav'
   * @param {(url: string, init: RequestInit) => Promise<Response>} fetchImpl
   *        認証を挟んだ fetch。auth.js の AccessAuth#fetch を渡す想定。
   */
  constructor(baseUrl, fetchImpl) {
    const trimmed = baseUrl.replace(/\/+$/, '');
    const url = new URL(trimmed || baseUrl);
    this.origin = url.origin;
    this.baseUrlPath = normalizePath(url.pathname || '/');
    this.baseUrl = trimmed;
    this.fetchImpl = fetchImpl;
  }

  urlFor(path) {
    const normalized = normalizePath(path);
    const base = this.baseUrlPath === '/' ? '' : this.baseUrlPath;
    return `${this.origin}${base}${encodePath(normalized === '/' ? '' : normalized)}`;
  }

  async propfind(path, depth) {
    const response = await this.fetchImpl(this.urlFor(path), {
      method: 'PROPFIND',
      headers: {
        Depth: String(depth),
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
    });
    if (!response.ok) {
      throw new DavHttpError(response.status, `PROPFIND ${path} → ${response.status}`);
    }
    return parseMultiStatus(await response.text(), { baseUrlPath: this.baseUrlPath });
  }

  /** Depth:0。単一エントリを返す。 */
  async getMetadata(path) {
    const entries = await this.propfind(path, 0);
    if (entries.length === 0) {
      throw new DavHttpError(404, `no multistatus response for ${path}`);
    }
    return entries[0];
  }

  /** Depth:1。自分自身 (要求パスと同一) を除いた子だけを返す。 */
  async readDirectory(path) {
    const self = normalizePath(path);
    const entries = await this.propfind(path, 1);
    return entries.filter((entry) => entry.path !== self);
  }

  /**
   * Range GET。常に offset から length バイトちょうど (またはファイル末尾まで) を返す。
   * @returns {Promise<ArrayBuffer>}
   */
  async readRange(path, offset, length) {
    if (length <= 0) return new ArrayBuffer(0);

    const end = offset + length - 1;
    const response = await this.fetchImpl(this.urlFor(path), {
      method: 'GET',
      headers: { Range: `bytes=${offset}-${end}` },
    });

    if (response.status === 416) return new ArrayBuffer(0); // offset がファイル末尾を越えた
    if (!response.ok && response.status !== 206) {
      throw new DavHttpError(response.status, `GET ${path} → ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    if (response.status === 206) return buffer;

    // Range を無視して 200 で全量返すサーバ向けのフォールバック。
    return buffer.slice(Math.min(offset, buffer.byteLength), Math.min(offset + length, buffer.byteLength));
  }
}
