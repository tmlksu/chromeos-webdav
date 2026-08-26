# WebDAV for Files (ChromeOS)

[![CI](https://github.com/tmlksu/chromeos-webdav/actions/workflows/ci.yml/badge.svg)](https://github.com/tmlksu/chromeos-webdav/actions/workflows/ci.yml)

日本語 | [English](README.md)

WebDAV 共有を ChromeOS の Files アプリにマウントする Chrome 拡張。
`chrome.fileSystemProvider` を使い、**開いた分だけ Range GET で取りに行く**ので、
大きな動画も全量ダウンロードを待たずに再生が始まる。

**読み取り専用。** 依存パッケージゼロ、ビルド不要。

```
ChromeOS Files アプリ
 └ この拡張 (chrome.fileSystemProvider, MV3)
     └ HTTPS fetch
         └ [認証なし | Cloudflare Access]
             └ WebDAV サーバ (rclone / Nextcloud / Apache mod_dav / …)
```

## 既存の実装との関係

ChromeOS で WebDAV をマウントする拡張としては
[`yoichiro/chromeos-filesystem-webdav`](https://github.com/yoichiro/chromeos-filesystem-webdav)
が長く使われてきたが、あちらは **Manifest V2 の Chrome App** として作られている。
Chrome App と MV2 はどちらもサポートが終了しているため、現在の ChromeOS では動かない。

このプロジェクトは MV3 の拡張として書き直したもので、加えて

- 開いた分だけ取りに行く Range GET (大きな動画がすぐ再生できる)
- Cloudflare Access の背後にある共有への対応
- 依存パッケージゼロ・ビルド不要

を持つ。移植ではなくゼロから書いているので、コードの共通部分は無い。

## 必要なもの

- ChromeOS (Chrome 120 以降)
- PROPFIND と **Range GET (206)** を返す WebDAV サーバ

サーバ側の用意が無ければ `docker/` に rclone の一例がある。

## インストール

Chrome ウェブストアには出していないので、展開して読み込む。

1. [最新リリース](../../releases) の zip を取得して展開するか、このリポジトリを clone する
2. Chrome で `chrome://extensions` を開く
3. **デベロッパーモード** をオンにする
4. **「パッケージ化されていない拡張機能を読み込む」** → 読み込むディレクトリを選ぶ
   - zip を展開した場合は **展開先のディレクトリそのもの** (`manifest.json` が直下にある)
   - clone した場合は `extension/`

## 設定

拡張のアイコンをクリックすると設定画面が開く (Files アプリの
「新しいサービスを追加」からも開く)。

| 項目 | 説明 |
| --- | --- |
| 表示名 | Files アプリのサイドバーに出る名前 |
| URL | `https://dav.example.com` / サブパス配信なら `https://example.com/dav` |
| 認証方式 | 下記参照 |
| 自動マウント | ブラウザ起動時にマウントする |

**「接続テスト」** で保存前に PROPFIND が通るか確認できる。
URL を入力して保存すると、そのオリジンへのアクセス許可を求めるダイアログが出る
(`optional_host_permissions` を使っているため、必要なホストにだけ権限を渡せる)。

共有は複数登録でき、それぞれ独立したドライブとして Files アプリに現れる。

### 認証方式

**認証なし** — サーバに直接つなぐ。Tailscale / WireGuard / LAN 内など、
**ネットワーク層で守られている場合にだけ**使うこと。

**Cloudflare Access** — [self-hosted アプリケーション](docs/cloudflare-access.md)で
守られたサーバ向け。セッションが切れると自動でログインタブを開き、
`CF_Authorization` cookie が設置されたのを検知してタブを閉じ、
中断していたリクエストを再開する。同時に何本リクエストが走っていても、
ログインタブは 1 枚しか開かない。

## 動作確認済みのサーバ

確認は 2 段階に分かれる。

- **プロトコル層** — PROPFIND の解釈、href の往復一致、Range GET。
  `test/live.mjs` が実サーバに対して確かめる。ChromeOS も chrome API も要らないので
  Docker で複数実装を立てて自動で回している
- **Files アプリ** — 実際にマウントして開けるか。Chromebook が要る

| サーバ | プロトコル層 | Files アプリ |
| --- | --- | --- |
| `rclone serve webdav` | 66/66 | 確認済み (直接 / Cloudflare Access 経由の両方) |
| Apache `mod_dav` | 66/66 | 未確認 |
| [dufs](https://github.com/sigoden/dufs) | 66/66 | 未確認 |
| [hacdias/webdav](https://github.com/hacdias/webdav) | 66/66 | 未確認 |
| nginx (組み込み `dav` モジュール) | **対象外** | — |

nginx の組み込み `ngx_http_dav_module` には PROPFIND が無く、書き込み系メソッドしか持たない。
`nginx-dav-ext-module` を足さないと WebDAV にはならない (PROPFIND が 405 になる)。

Nextcloud や Synology WebDAV Server は Basic 認証を要求するので、
拡張が対応するまで表に入れられない ([未対応](#未対応))。

手元で全部流せる:

```bash
npm run test:compat            # docker で上の実装を立てて結合テストを流す
npm run test:compat -- dufs    # 1 つだけ
```

他の WebDAV 実装で試したら、ぜひ結果を issue で教えてほしい。表に足す。
`node test/live.mjs <URL>` を自分のサーバに向けるだけで確認できる。

## 開発

```bash
npm test        # ユニットテスト (chrome API 不要)
npm run check   # 構文チェック + manifest.json の妥当性
npm run package # dist/webdav-for-files-<version>.zip を作る

npm run fixtures            # fixture を rclone の実出力から再生成する
npm run test:compat         # 複数の WebDAV 実装に対する互換テスト (docker)
node test/live.mjs <URL>    # 稼働中のサーバに対する結合テスト
```

依存パッケージは無い (`npm install` 不要)。Node 20 以降。

CI が流しているものは手元でもそのまま再現できる。ChromeOS も chrome API も要らない:

```bash
bash test/tools/make-tree.sh /tmp/davtree     # 意地悪な名前を並べた検証用ツリー
DAV_SHARE_PATH=/tmp/davtree docker compose -f docker/docker-compose.yml up -d
node test/live.mjs http://127.0.0.1:8080
```

`test/live.mjs` はサーバ固有の前提を置かない。ツリーを歩いて、
一覧で得たパスをそのまま引き直せるか、Range GET が全量 GET と一致するかを確かめる。
自分の WebDAV サーバにそのまま向けられる:

```bash
node test/live.mjs https://dav.example.com                    # 認証なし
DAV_USER=u DAV_PASS=p node test/live.mjs https://dav.example.com   # Basic 認証のサーバ
CF_ACCESS_TOKEN=$(cloudflared access token -app=https://dav.example.com) \
  node test/live.mjs https://dav.example.com                  # Cloudflare Access 経由
```

## 設計上の判断メモ

実装しようとする人が同じ罠を踏まないように、理由の要る箇所を残しておく。

- **XML パースは自前**。service worker では `DOMParser` が使えない。
  タグ単位で走査する小さなスキャナを `dav.js` に書いた (依存ゼロ)。
  正規表現ではなく状態機械なので、属性内の `>`、自己閉じタグ、
  名前空間プレフィックスの違い (`D:` / `d:` / `lp1:`) を取り違えない。
- **複数 propstat を扱う**。rclone は prop 限定 PROPFIND に対し、
  存在するプロパティを 200 の propstat に、存在しないものを 404 の propstat に
  分けて返す。2xx の propstat だけを採用しないと、ディレクトリの
  `getcontentlength` が空文字で上書きされる。
- **エントリ名は `displayname` ではなく `href` から導出**する。
  FSP に返した name はそのまま次のリクエストのパスとして戻ってくるため、
  href と往復一致していないと「一覧には出るが開けない」状態になる。
  サーバによって `+` `=` `'` `(` `~` をエンコードするかどうかが違うので、
  ここは実サーバで往復を確かめる価値がある (`test/live.mjs` がやっている)。
- **末尾を跨ぐ Range を 416 で断るサーバがある**。RFC 7233 はサーバ側に
  末尾での切り詰めを求めていて rclone と Apache はそうするが、dufs は断る。
  FSP は固定長で読むので**最後のチャンクは必ず末尾を跨ぐ** —
  つまり全ファイルで踏み、1 チャンクより小さいファイルは丸ごと空になる。
  断られたときだけ開放レンジ `bytes=N-` で引き直している。常に開放レンジで
  投げないのは、それだと残り全部 (動画なら数 GB) が飛んできて
  ストリーミングにならないため。
- **Access の失効判定はリダイレクトと 401 のみ**。非 2xx すべてを失効とみなすと、
  404 (存在しないファイル) や 403 (ポリシー拒否) のたびにログインタブが暴発する。
  404 → `NOT_FOUND`、403 → `ACCESS_DENIED` に写像し、
  `opaqueredirect` / status 0 / 401 だけを失効として扱う。
- **ログインは single-flight**。Files アプリはディレクトリを開くと複数リクエストを
  同時に投げるため、ゲートを入れないとログインタブが何枚も開く。
- **タイムアウト時にログインタブを閉じない**。90 秒は MFA 入力には短いことがある。
  タブは残し、次のログイン要求で同じタブを使い回す。
- **service worker は落ちる前提**。open 中ファイルの
  `fileSystemId + openRequestId → パス` は `chrome.storage.session` に保存し、
  ハンドラ内で遅延復元する。
- **`fileSystemId` は URL から決定的に導出**する。設定を消して足し直しても
  同じ id になるので、ChromeOS 側に残ったマウント状態と食い違わない。
- **`host_permissions` は optional**。MV3 では静的な `host_permissions` を
  実行時に変えられないため、`optional_host_permissions` + 設定画面からの
  `chrome.permissions.request()` にしている。ユーザー操作が要るので、
  権限要求は必ず設定画面側で行う。

## 未対応

- 書き込み (`onCreateFile` / `onWriteFile` / `onDeleteEntry` / `onMoveEntry`)
- メタデータキャッシュ (ディレクトリ表示の高速化)
- サムネイル (`onGetMetadataRequested` の `thumbnail`)
- Basic 認証 / Bearer トークン
- ファイル監視 (`watchable`)

## ライセンス

MIT
