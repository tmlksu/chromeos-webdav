# ウェブストア提出用の下書き

Chrome ウェブストアのデベロッパーダッシュボードに貼る文面と、提出前に要るものの一覧。
**貼り付ける文面は英語で用意してある** (審査は英語で行われるため)。

方針は **Unlisted (限定公開) で出し、落ち着いてから Public に切り替える**。
どちらも審査は同じものを通るので、通してから可視性を変えればよい。

登録料は 5 ドル、初回のみ (アカウント単位)。

## 提出前に要るもの

- [x] 128x128 のアイコン (`npm run icons` で生成、manifest に登録済み)
- [x] プライバシーポリシーの URL → <https://github.com/tmlksu/chromeos-webdav/blob/main/PRIVACY.md>
- [ ] **スクリーンショット 1 枚以上** (1280x800 または 640x400)
      → Files アプリにマウントされた図が最も効く。**Chromebook が要る**
- [ ] 小さいプロモタイル 440x280 (任意だが、あると掲載時の見栄えが変わる)
- [x] 配布用 zip (`npm run package`)

`npm run check` が manifest の整合性 (version の一致、参照ファイルの実在、128 アイコンの有無)
を見ているので、提出前に必ず通すこと。

## ストア掲載情報

**Name**

```
WebDAV for Files
```

**Summary** (132 文字以内)

```
Mount a WebDAV share in the ChromeOS Files app. Streams on demand, so large files open without downloading them first. Read-only.
```

**Description**

```
Mounts a WebDAV share as a drive in the ChromeOS Files app, using the
chrome.fileSystemProvider API.

Files are fetched with Range GET as you actually read them, rather than being
downloaded in full first. A large video starts playing straight away.

Read-only. It will not create, modify or delete anything on your server.

FEATURES

- Mount any WebDAV server that answers PROPFIND and Range GET
- Several shares at once, each as its own drive
- No auth, Basic auth, or Cloudflare Access
- Behind Cloudflare Access, a login tab opens when the session expires and
  closes itself once you are through, resuming what you were doing
- Directory metadata is cached briefly, so opening a folder is one request
  rather than one per file
- No dependencies, no build step, no analytics, no remote code

VERIFIED AGAINST

rclone, Apache mod_dav, dufs, hacdias/webdav and Nextcloud. The integration
test that checks these runs in CI on every push; results are in the README.

REQUIREMENTS

ChromeOS with Chrome 120 or later, and a WebDAV server that answers PROPFIND
and Range GET (206). This extension only works on ChromeOS — the
fileSystemProvider API does not exist on other platforms.

Source, documentation and issue tracker:
https://github.com/tmlksu/chromeos-webdav
```

**Category**: Workflow & Planning
**Language**: English

## 単一目的の説明 (Single purpose)

```
This extension has one purpose: to mount a WebDAV share as a drive in the
ChromeOS Files app, so the user can browse and read files on their own server
through the standard file manager. Every permission it requests exists to serve
that one function.
```

## 権限の正当化 (Permission justification)

ダッシュボードは権限ごとに 1 つずつ理由を聞いてくる。

**`fileSystemProvider`**

```
This is the API that provides the extension's entire function. It is what
registers the WebDAV share as a file system so it appears in the ChromeOS Files
app. Without it the extension does nothing.
```

**`storage`**

```
Stores the shares the user configures — display name, server URL, chosen
authentication mode, and whether to mount at startup — so they do not have to
be re-entered on every browser start. For Basic auth it also holds the
credentials the user entered, which are needed to reconnect without prompting.
chrome.storage.session additionally holds which files are currently open,
because a Manifest V3 service worker is terminated while files are still open
and that mapping has to survive the restart. Nothing is stored remotely.
```

**`cookies`**

```
Used only for shares configured to use Cloudflare Access, and only for the
origin the user configured. The extension checks whether a CF_Authorization
cookie exists for that origin, and listens for one appearing so it can tell
when the user has finished logging in and resume the interrupted request.
Cookie values are never read for any other host and are never transmitted
anywhere.
```

**`tabs`**

```
Used only for shares configured to use Cloudflare Access. When the session
expires, the extension opens one tab at the configured origin so the user can
log in, and closes that tab once the login completes. It does not read browsing
history, tab contents, or the URLs of tabs it did not open.
```

**ホスト権限 (`optional_host_permissions`: `https://*/*`, `http://*/*`)**

```
The extension cannot know in advance which server a user will mount — it is
whatever WebDAV server they run, at whatever hostname. The pattern is broad for
that reason alone.

Crucially these are OPTIONAL host permissions, not granted at install time. The
extension has access to no host until the user adds a share and approves
Chrome's permission prompt for that one specific origin. A user with one share
grants exactly one origin. Requests are only ever made to origins the user
configured.
```

## リモートコード (Remote code)

```
No, I am not using remote code.
```

すべてのコードは拡張に同梱されている。`eval` も外部スクリプトの読み込みも無い。

## データ利用 (Data usage)

**申告するカテゴリ: Authentication information のみ。**

理由: Basic 認証を選んだ場合に、ユーザーが入力したユーザー名とパスワードを
`chrome.storage.local` に保存するため。他のカテゴリ (個人情報・所在地・閲覧履歴・
ウェブサイトの内容・ユーザーの操作など) は扱わないので申告しない。

補足欄に書く内容:

```
Authentication information is handled only when the user chooses Basic
authentication for a share. The username and password they enter are stored
locally in chrome.storage.local and sent, as a standard Authorization header,
only to the WebDAV server that same user configured. They are never sent to the
developer or to any third party, and the extension contacts no server other than
the ones the user has configured and granted permission for. Removing the share,
or the extension, deletes them.
```

3 つの証明はいずれもチェックできる:

- ユーザーデータを承認された用途以外で第三者に販売・譲渡しない → **該当しない (そもそも譲渡しない)**
- 単一目的と無関係な用途に使用・譲渡しない → **該当しない**
- 信用力の判断や融資目的に使用・譲渡しない → **該当しない**

プライバシーポリシー URL: <https://github.com/tmlksu/chromeos-webdav/blob/main/PRIVACY.md>

## 審査で突かれるとしたらどこか

- **ホスト権限の広さ。** `https://*/*` は最も説明を求められるパターン。
  optional であること、共有の追加時にオリジン単位で要求していることを前面に出す
  (上の文面はそう書いてある)。
- **`cookies` と `tabs`。** どちらも用途が限定的なので、
  「設定済みオリジンに限る」「ログインタブ以外は触らない」を明記する。
- **ChromeOS 専用であること。** 審査者が他のプラットフォームで動かすと何も起きない。
  説明文に明記してある。

## 提出後

- 通ったら Unlisted の URL を README のインストール手順に足す
  (unpacked の手順は開発者向けとして残す)
- 自動更新に乗るので、以後は version を上げて `npm run package` → 新しい zip を
  アップロードするだけ。**Chromebook 側の操作は不要になる**
- Public に切り替えるのはダッシュボードの可視性の変更のみ (再審査は走る)
