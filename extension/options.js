/**
 * 設定画面。共有の追加・削除・マウント切り替えを行う。
 *
 * host_permissions は optional なので、ここでユーザー操作を起点に
 * chrome.permissions.request() を呼ぶ必要がある
 * (service worker からは要求できない)。
 */

import { validateShare, ShareStore } from './config.js';
import { createAuth } from './auth.js';
import { DavClient } from './dav.js';

const store = new ShareStore();

const form = document.getElementById('share-form');
const nameInput = document.getElementById('name');
const urlInput = document.getElementById('url');
const authSelect = document.getElementById('auth-mode');
const basicFields = document.getElementById('basic-fields');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const autoMountInput = document.getElementById('auto-mount');
const authHelp = document.getElementById('auth-help');
const formStatus = document.getElementById('form-status');
const testButton = document.getElementById('test');
const saveButton = document.getElementById('save');
const list = document.getElementById('share-list');
const empty = document.getElementById('empty');

const AUTH_HELP = {
  none: 'サーバに直接つなぎます。インターネットに露出している共有には使わないでください。',
  basic: 'サーバ自身が持つユーザー名とパスワードで認証します。https の共有にのみ設定できます。',
  'cloudflare-access': '未認証を検知するとログインタブを開き、認証が済むと自動で閉じて処理を再開します。',
};

const AUTH_LABELS = {
  none: '認証なし',
  basic: 'Basic 認証',
  'cloudflare-access': 'Cloudflare Access',
};

function setStatus(message, kind = '') {
  formStatus.textContent = message;
  formStatus.className = `status ${kind}`;
}

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

/** 対象オリジンへのアクセス権を要求する。ユーザー操作の中からしか呼べない。 */
async function ensurePermission(url) {
  const origins = [originPattern(url)];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

function readForm() {
  return {
    name: nameInput.value,
    url: urlInput.value,
    authMode: authSelect.value,
    username: usernameInput.value,
    password: passwordInput.value,
    autoMount: autoMountInput.checked,
  };
}

/** Basic 認証を選んだときだけ資格情報の欄を出す。 */
function syncAuthFields() {
  basicFields.hidden = authSelect.value !== 'basic';
  authHelp.textContent = AUTH_HELP[authSelect.value] || '';
}

/** PROPFIND Depth:1 を 1 回投げて、実際に一覧が取れるか確かめる。 */
async function probe(share) {
  const auth = createAuth(share);
  const client = new DavClient(share.url, auth.fetch);
  await auth.ensureAuthenticated();
  return client.readDirectory('/');
}

function describeError(error) {
  const message = String(error?.message || error);
  if (error?.status === 401 || error?.code === 'still_unauthenticated') {
    return `${message}\n認証方式の設定を確認してください。`;
  }
  if (error?.status === 404) {
    return `${message}\nURL のパス (baseurl) が合っているか確認してください。`;
  }
  if (error?.status === 405) {
    return `${message}\nPROPFIND が拒否されています。WebDAV ではないか、プロキシがメソッドを塞いでいます。`;
  }
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return `${message}\nURL・証明書・CORS 以前の到達性を確認してください。`;
  }
  return message;
}

async function withBusy(button, fn) {
  const buttons = [saveButton, testButton];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    return await fn();
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

testButton.addEventListener('click', () => {
  const { share, errors } = validateShare(readForm());
  if (errors.length) return setStatus(errors.join('\n'), 'error');

  withBusy(testButton, async () => {
    setStatus('接続中…');
    if (!(await ensurePermission(share.url))) {
      return setStatus(`${originPattern(share.url)} へのアクセスが許可されませんでした。`, 'error');
    }
    try {
      const entries = await probe(share);
      const dirs = entries.filter((e) => e.isDirectory).length;
      setStatus(`接続できました。${entries.length} 件 (フォルダ ${dirs} / ファイル ${entries.length - dirs})`, 'ok');
    } catch (error) {
      setStatus(describeError(error), 'error');
    }
  });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const { share, errors } = validateShare(readForm());
  if (errors.length) return setStatus(errors.join('\n'), 'error');

  withBusy(saveButton, async () => {
    setStatus('保存中…');
    if (!(await ensurePermission(share.url))) {
      return setStatus(`${originPattern(share.url)} へのアクセスが許可されませんでした。`, 'error');
    }
    await store.save(share);

    const response = await chrome.runtime.sendMessage({ type: 'mount', id: share.id });
    if (response?.ok) {
      setStatus(`${share.name} をマウントしました。Files アプリで開けます。`, 'ok');
      form.reset();
      autoMountInput.checked = true;
      syncAuthFields();
    } else {
      setStatus(`保存しましたがマウントに失敗しました:\n${response?.error || '不明なエラー'}`, 'error');
    }
    await render();
  });
});

authSelect.addEventListener('change', syncAuthFields);

async function render() {
  const [shares, response] = await Promise.all([
    store.list(),
    chrome.runtime.sendMessage({ type: 'mountedIds' }),
  ]);
  const mounted = new Set(response?.ids || []);

  list.replaceChildren();
  empty.hidden = shares.length > 0;

  for (const share of shares) {
    const item = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = share.name;
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = `${share.url} · ${AUTH_LABELS[share.authMode] || share.authMode}`;
    info.append(name, url);

    const badge = document.createElement('span');
    const isMounted = mounted.has(share.id);
    badge.className = `badge${isMounted ? ' mounted' : ''}`;
    badge.textContent = isMounted ? 'マウント中' : '未マウント';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = isMounted ? 'アンマウント' : 'マウント';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      // マウント時は権限が失効している可能性があるので再確認する
      if (!isMounted && !(await ensurePermission(share.url))) {
        setStatus(`${originPattern(share.url)} へのアクセスが許可されませんでした。`, 'error');
        toggle.disabled = false;
        return;
      }
      const result = await chrome.runtime.sendMessage({
        type: isMounted ? 'unmount' : 'mount',
        id: share.id,
      });
      if (!result?.ok) setStatus(result?.error || '操作に失敗しました', 'error');
      else setStatus('');
      await render();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '削除';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      await chrome.runtime.sendMessage({ type: 'unmount', id: share.id });
      await store.remove(share.id);
      // 他の共有が同じオリジンを使っているかもしれないので権限は残す
      setStatus(`${share.name} を削除しました。`, 'ok');
      await render();
    });

    item.append(info, badge, toggle, remove);
    list.append(item);
  }
}

syncAuthFields();
render().catch((error) => setStatus(describeError(error), 'error'));
