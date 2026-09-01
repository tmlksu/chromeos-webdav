# Privacy Policy

*Last updated: 2026-08-31 — applies to the "WebDAV for Files" Chrome extension.*

[日本語は下にあります。](#プライバシーポリシー日本語)

## Short version

The extension talks to the WebDAV servers you configure and to nothing else.
No analytics, no telemetry, no third-party services. Everything it stores stays
on your device.

## What is stored, and where

**`chrome.storage.local`** — the shares you configure:

- display name
- server URL
- authentication mode (none, Basic, or Cloudflare Access)
- whether to mount at browser startup
- **for Basic auth only: the username and password you entered**

These are needed to reconnect to the share without asking you again on every
browser start. They are stored **in cleartext**. Extension storage is not
readable by other extensions or by web pages, but it is not encrypted on disk.
For that reason Basic auth can only be configured on an `https://` share.
If your server can issue an app password, use one instead of your account
password.

**`chrome.storage.session`** — which files are currently open, as a map from the
file handle to its path. This is cleared when the browser closes. It exists
because a Manifest V3 service worker is shut down while files are still open,
and the mapping has to survive that.

Nothing is written anywhere else. There is no remote storage and no account.

## What is sent over the network

Requests go **only to the origins you configured and granted permission to.**
The extension uses `optional_host_permissions`, so it has no access to any host
until you add a share and approve the permission prompt for that specific
origin.

To those origins it sends:

- `PROPFIND` requests to list directories and read file metadata
- `GET` requests with a `Range` header to read the parts of a file you open
- for Basic auth, an `Authorization` header carrying your credentials
- for Cloudflare Access, the browser's `CF_Authorization` cookie for that origin,
  and a request to `/cdn-cgi/access/get-identity` to check whether the session is
  still valid

If a server redirects a Basic auth request to a different origin, the request is
rejected rather than followed, so the credentials are not handed to another host.

**Nothing is sent to the author of this extension or to any third party.**
There is no analytics, crash reporting, update ping or usage measurement of any
kind. The extension contains no remote code: every file it runs ships inside it.

## Why each permission is requested

| Permission | Why |
| --- | --- |
| `fileSystemProvider` | The entire point: it is what lets the share appear in the ChromeOS Files app. |
| `storage` | Saves your share settings and the open-file state described above. |
| `cookies` | Only to check whether a `CF_Authorization` cookie exists for a configured origin, and to notice when one appears after you log in. Cookie values are never read for any other host and are never transmitted anywhere. |
| `tabs` | Only to open a login tab for a configured origin when a Cloudflare Access session expires, and to close it once you have logged in. Browsing history and tab contents are not read. |
| Host permissions (optional) | The extension cannot know in advance which server you will use, so it requests access per origin, at the moment you add a share. |

## Your data, your control

Removing a share deletes its settings, including any stored credentials.
Removing the extension deletes everything it stored.

## Contact

Please open an issue at
<https://github.com/tmlksu/chromeos-webdav/issues>.

---

# プライバシーポリシー (日本語)

*最終更新: 2026-08-31 — Chrome 拡張「WebDAV for Files」について。*

## 要約

この拡張は、あなたが設定した WebDAV サーバとだけ通信する。解析も送信も無く、
第三者のサービスも使わない。保存するものはすべて端末内に留まる。

## 何を、どこに保存するか

**`chrome.storage.local`** — 設定した共有:

- 表示名
- サーバの URL
- 認証方式 (認証なし / Basic / Cloudflare Access)
- ブラウザ起動時に自動マウントするか
- **Basic 認証を選んだ場合のみ、入力したユーザー名とパスワード**

ブラウザを起動するたびに入力を求めずに再接続するために必要になる。
**平文で保存される。** 拡張のストレージは他の拡張やウェブページからは読めないが、
ディスク上は暗号化されない。そのため Basic 認証は `https://` の共有にのみ設定できる。
アプリパスワードを発行できるサーバなら、アカウント本体のパスワードではなく
そちらを使うこと。

**`chrome.storage.session`** — 現在開いているファイルの、ハンドルからパスへの対応。
ブラウザを閉じると消える。Manifest V3 の service worker はファイルを開いたまま
停止させられるため、この対応を跨いで保持する必要がある。

これ以外にはどこにも書かない。リモートの保存先もアカウントも無い。

## 何をネットワークに送るか

リクエストは**あなたが設定し、許可を与えたオリジンにしか行かない。**
`optional_host_permissions` を使っているので、共有を追加してそのオリジンへの
許可ダイアログを承認するまで、どのホストにもアクセスできない。

そのオリジンに対して送るもの:

- ディレクトリ一覧とファイルのメタデータを取るための `PROPFIND`
- 開いたファイルの必要な部分だけを読むための、`Range` ヘッダ付きの `GET`
- Basic 認証の場合、資格情報を載せた `Authorization` ヘッダ
- Cloudflare Access の場合、そのオリジンに対するブラウザの `CF_Authorization`
  cookie と、セッションが生きているかを確かめる `/cdn-cgi/access/get-identity`

Basic 認証のリクエストが別オリジンへリダイレクトされた場合、追わずに拒否する。
資格情報を別のホストに渡さないため。

**作者にも第三者にも、何も送らない。** 解析・クラッシュ報告・更新確認・利用計測の
たぐいは一切行わない。リモートコードも含まない。実行するファイルはすべて拡張に同梱されている。

## 各権限を要求する理由

| 権限 | 理由 |
| --- | --- |
| `fileSystemProvider` | この拡張の存在理由そのもの。共有を ChromeOS の Files アプリに出すための API。 |
| `storage` | 上に書いた共有設定と、開いているファイルの状態を保存する。 |
| `cookies` | 設定済みのオリジンに `CF_Authorization` cookie があるかを確かめること、およびログイン後に設置されたのを検知することにのみ使う。他のホストの cookie は読まないし、cookie の値をどこかへ送ることもしない。 |
| `tabs` | Cloudflare Access のセッションが切れたときに設定済みオリジンのログインタブを開き、ログイン後に閉じることにのみ使う。閲覧履歴やタブの内容は読まない。 |
| ホスト権限 (optional) | どのサーバを使うかを事前に知りようがないので、共有を追加する時点でオリジン単位に要求する。 |

## 削除

共有を削除すると、その設定 (保存された資格情報を含む) も消える。
拡張を削除すると、保存したものはすべて消える。

## 連絡先

<https://github.com/tmlksu/chromeos-webdav/issues> に issue を立ててほしい。
