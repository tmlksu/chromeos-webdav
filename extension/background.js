/**
 * MV3 service worker: chrome.fileSystemProvider のハンドラ群。
 *
 * service worker はアイドルで頻繁に落ちるため、
 *  - すべてのリスナはトップレベルで同期的に登録する
 *  - open 中のファイル (fileSystemId + openRequestId → パス) は
 *    chrome.storage.session に置き、再起動後に読み直す
 * という前提で書いている。
 *
 * 共有は複数マウントできる。fileSystemId は URL から決定的に導出するので
 * (config.js の shareIdFor)、設定を消して足し直しても同じ id になる。
 */

import { DavClient, DavHttpError } from './dav.js';
import { CachedDavClient } from './cache.js';
import { createAuth, AccessAuthError } from './auth.js';
import { ShareStore } from './config.js';

const OPEN_FILES_KEY = 'openFiles';
const OPENED_FILES_LIMIT = 32;

const store = new ShareStore();

// --- chrome API ヘルパ -------------------------------------------------------

/** コールバック形式の chrome API を Promise 化する。 */
function callApi(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn(...args, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// --- 共有ごとの接続コンテキスト ----------------------------------------------

/** @type {Map<string, {share: object, client: DavClient, auth: object}>} */
const contexts = new Map();

async function getContext(fileSystemId) {
  const cached = contexts.get(fileSystemId);
  if (cached) return cached;

  const share = await store.get(fileSystemId);
  if (!share) {
    throw new DavHttpError(404, `未設定の共有です: ${fileSystemId}`);
  }
  const auth = createAuth(share);
  // CachedDavClient は DavClient と同じ形なので、ハンドラ側は何も変わらない。
  // キャッシュは context と一緒に捨てられる (設定変更・アンマウント・SW 停止)。
  const client = new CachedDavClient(new DavClient(share.url, auth.fetch));
  const context = { share, auth, client };
  contexts.set(fileSystemId, context);
  return context;
}

/** 設定が変わったら、次のリクエストで作り直させる。 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.shares) contexts.clear();
});

// --- open 中ファイルの状態 ---------------------------------------------------

/** @type {Map<string, string>} `${fileSystemId}:${openRequestId}` → ファイルパス */
const openFiles = new Map();
let restorePromise = null;

const openKey = (fileSystemId, openRequestId) => `${fileSystemId}:${openRequestId}`;

function restoreOpenFiles() {
  if (!restorePromise) {
    restorePromise = (async () => {
      const stored = await chrome.storage.session.get(OPEN_FILES_KEY);
      const saved = stored[OPEN_FILES_KEY];
      if (saved) for (const [key, path] of Object.entries(saved)) openFiles.set(key, path);
    })().catch(() => { /* session ストレージが読めなくても致命的ではない */ });
  }
  return restorePromise;
}

async function persistOpenFiles() {
  await chrome.storage.session.set({ [OPEN_FILES_KEY]: Object.fromEntries(openFiles) });
}

async function forgetShareOpenFiles(fileSystemId) {
  await restoreOpenFiles();
  for (const key of [...openFiles.keys()]) {
    if (key.startsWith(`${fileSystemId}:`)) openFiles.delete(key);
  }
  await persistOpenFiles();
}

// --- エラー写像 --------------------------------------------------------------

/** @returns {chrome.fileSystemProvider.ProviderError} */
function toProviderError(error) {
  if (error instanceof DavHttpError) {
    if (error.status === 404) return 'NOT_FOUND';
    if (error.status === 403) return 'ACCESS_DENIED';
    if (error.status === 405 || error.status === 501) return 'INVALID_OPERATION';
  }
  if (error instanceof AccessAuthError) return 'FAILED';
  return 'FAILED';
}

/** ハンドラを Promise ベースで書けるようにするラッパ。 */
function handler(name, fn) {
  return (options, onSuccess, onError) => {
    Promise.resolve()
      .then(() => fn(options, onSuccess))
      .catch((error) => {
        console.error(`[webdav-fsp] ${name} failed`, options, error);
        onError(toProviderError(error));
      });
  };
}

/**
 * 要求されたフィールドだけを持つ EntryMetadata を組み立てる。
 * thumbnail は未対応だが、FAILED にはせず単に省略する。
 */
function buildMetadata(entry, options) {
  const metadata = {};
  if (options.isDirectory) metadata.isDirectory = entry.isDirectory;
  if (options.name) metadata.name = entry.name;
  if (options.size) metadata.size = entry.size;
  if (options.modificationTime) metadata.modificationTime = entry.modificationTime || new Date(0);
  if (options.mimeType && entry.mimeType) metadata.mimeType = entry.mimeType;
  return metadata;
}

// --- FSP ハンドラ ------------------------------------------------------------

chrome.fileSystemProvider.onGetMetadataRequested.addListener(
  handler('onGetMetadataRequested', async (options, onSuccess) => {
    const { client } = await getContext(options.fileSystemId);
    onSuccess(buildMetadata(await client.getMetadata(options.entryPath), options));
  }),
);

chrome.fileSystemProvider.onReadDirectoryRequested.addListener(
  handler('onReadDirectoryRequested', async (options, onSuccess) => {
    const { client } = await getContext(options.fileSystemId);
    const entries = await client.readDirectory(options.directoryPath);
    onSuccess(entries.map((entry) => buildMetadata(entry, options)), false);
  }),
);

chrome.fileSystemProvider.onOpenFileRequested.addListener(
  handler('onOpenFileRequested', async (options, onSuccess) => {
    if (options.mode !== 'READ') {
      throw new DavHttpError(403, `書き込みモードは未対応: ${options.mode}`);
    }
    const { client } = await getContext(options.fileSystemId);
    const entry = await client.getMetadata(options.filePath);
    if (entry.isDirectory) {
      throw new DavHttpError(405, `ディレクトリは開けない: ${options.filePath}`);
    }

    await restoreOpenFiles();
    openFiles.set(openKey(options.fileSystemId, options.requestId), options.filePath);
    await persistOpenFiles();
    onSuccess();
  }),
);

chrome.fileSystemProvider.onCloseFileRequested.addListener(
  handler('onCloseFileRequested', async (options, onSuccess) => {
    await restoreOpenFiles();
    openFiles.delete(openKey(options.fileSystemId, options.openRequestId));
    await persistOpenFiles();
    onSuccess();
  }),
);

chrome.fileSystemProvider.onReadFileRequested.addListener(
  handler('onReadFileRequested', async (options, onSuccess) => {
    await restoreOpenFiles();
    const path = openFiles.get(openKey(options.fileSystemId, options.openRequestId));
    if (!path) {
      // service worker 再起動で状態を失った場合。Files アプリが開き直す。
      throw new DavHttpError(400, `openRequestId ${options.openRequestId} が未知`);
    }
    const { client } = await getContext(options.fileSystemId);
    onSuccess(await client.readRange(path, options.offset, options.length), false);
  }),
);

chrome.fileSystemProvider.onUnmountRequested.addListener(
  handler('onUnmountRequested', async (options, onSuccess) => {
    await callApi(chrome.fileSystemProvider.unmount, { fileSystemId: options.fileSystemId });
    contexts.delete(options.fileSystemId);
    await forgetShareOpenFiles(options.fileSystemId);
    onSuccess();
  }),
);

// Files アプリの「新しいサービスを追加」と歯車アイコンから呼ばれる。
// どちらも設定画面を開くのが素直な応答。
chrome.fileSystemProvider.onMountRequested.addListener(
  handler('onMountRequested', async (_options, onSuccess) => {
    await chrome.runtime.openOptionsPage();
    onSuccess();
  }),
);

chrome.fileSystemProvider.onConfigureRequested.addListener(
  handler('onConfigureRequested', async (options, onSuccess) => {
    await chrome.runtime.openOptionsPage();
    console.info(`[webdav-fsp] configure requested for ${options.fileSystemId}`);
    onSuccess();
  }),
);

// --- マウント制御 ------------------------------------------------------------

export async function mountedIds() {
  const mounts = await callApi(chrome.fileSystemProvider.getAll);
  return new Set((mounts || []).map((fs) => fs.fileSystemId));
}

/**
 * 共有をマウントする。
 * host_permissions は optional なので、ここに来る前に設定画面で
 * chrome.permissions.request() が済んでいる必要がある (ユーザー操作が要るため)。
 */
async function mountShare(share) {
  const auth = createAuth(share);
  await auth.ensureAuthenticated();

  if ((await mountedIds()).has(share.id)) return;

  await callApi(chrome.fileSystemProvider.mount, {
    fileSystemId: share.id,
    displayName: share.name,
    writable: false,
    openedFilesLimit: OPENED_FILES_LIMIT,
    supportsNotifyTag: false,
  });
  console.info(`[webdav-fsp] mounted ${share.name} (${share.url})`);
}

async function unmountShare(id) {
  if (!(await mountedIds()).has(id)) return;
  await callApi(chrome.fileSystemProvider.unmount, { fileSystemId: id });
  contexts.delete(id);
  await forgetShareOpenFiles(id);
}

/** autoMount が立っている共有をまとめてマウントする。1 つ失敗しても他は続ける。 */
async function mountAll(reason) {
  const shares = await store.list();
  const granted = await chrome.permissions.getAll();
  const origins = new Set(granted.origins || []);

  for (const share of shares) {
    if (!share.autoMount) continue;
    // 権限が無いまま mount すると最初のリクエストで必ず落ちるので、先に弾く
    const pattern = `${new URL(share.url).origin}/*`;
    if (!origins.has(pattern) && !origins.has('<all_urls>')) {
      console.warn(`[webdav-fsp] ${share.name}: ${pattern} の権限が無いのでスキップ (設定画面で付与)`);
      continue;
    }
    try {
      await mountShare(share);
    } catch (error) {
      console.warn(`[webdav-fsp] auto mount (${reason}) failed for ${share.name}`, error);
    }
  }
}

// 設定画面からの操作を受ける
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'mount': {
        const share = await store.get(message.id);
        if (!share) throw new Error(`未設定の共有です: ${message.id}`);
        await mountShare(share);
        return { ok: true };
      }
      case 'unmount':
        await unmountShare(message.id);
        return { ok: true };
      case 'mountedIds':
        return { ok: true, ids: [...(await mountedIds())] };
      default:
        return { ok: false, error: `未知のメッセージ: ${message?.type}` };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true; // 非同期応答
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onStartup.addListener(() => mountAll('onStartup'));
chrome.runtime.onInstalled.addListener(() => mountAll('onInstalled'));

// service worker が起き直した直後に open 状態を復元しておく。
mountedIds()
  .then((ids) => (ids.size ? restoreOpenFiles() : undefined))
  .catch(() => { /* 起動直後に API が使えないことがある */ });
