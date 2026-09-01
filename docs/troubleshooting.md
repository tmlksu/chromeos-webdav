# トラブルシューティング

ログは `chrome://extensions` → 対象拡張の **「service worker」** を
クリックして開く DevTools の Console に出る。
設定画面の不具合は設定画面自体を右クリック → 検証。

## マウントできない

**設定画面で「接続テスト」を実行する。** ほとんどの原因はここで切り分けられる。

| 症状 | 原因 |
| --- | --- |
| `Failed to fetch` | URL の綴り、DNS、証明書、サーバが落ちている |
| 401 / ログインタブが出続ける | 認証方式の設定違い。Cloudflare Access なのに「認証なし」になっていないか。Basic 認証ならユーザー名・パスワード違い (アプリパスワードが要るサーバもある) |
| 404 | URL のパス (baseurl) 違い。`https://host/dav` のようにサブパスで配信していないか |
| 405 | PROPFIND が拒否されている。WebDAV ではないか、プロキシがメソッドを塞いでいる |

`… の権限が無いのでスキップ` が Console に出る場合は、設定画面で共有の
「マウント」を押し直して権限ダイアログを承認する。ChromeOS の更新や
拡張の再読み込みで optional permission が落ちることがある。

## しばらく待たされたあと失敗する

サーバか経路 (トンネル・プロキシ) が応答を返していない。
拡張はリクエストごとに期限を張っていて、メタデータ取得は 30 秒、
本体の読み出しは 120 秒で打ち切る。Console には
`... が 30000ms 以内に応答しなかった` と出る。

期限が無いと Files アプリが無限に待つため、失敗として返す設計にしている。
オリジンが生きているかを直接確かめる:

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" -X PROPFIND https://dav.example.com/ -H "Depth: 0"
```

cloudflared を挟んでいる場合は `systemctl status cloudflared` も見る。

## 一覧は出るがファイルが開けない

サーバの href エンコードと拡張の再エンコードが食い違っている可能性が高い。
自分のサーバに結合テストを向けると、どのファイルで壊れているか分かる:

```bash
node test/live.mjs https://dav.example.com
```

`… を引き直せない (エンコードの不一致?)` と出たパスが原因。
issue にそのパスと、サーバの PROPFIND 生出力を添えてほしい:

```bash
curl -s -X PROPFIND https://dav.example.com/ -H "Depth: 1" | head -50
```

## 動画の再生が始まるまでに全量ダウンロードされる

サーバまたは前段のプロキシが Range GET を無視している。確認:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -r 0-1023 https://dav.example.com/<ファイル>
```

**206** でなければならない。200 が返る場合:

- Cloudflare 経由なら Speed → Optimization の圧縮/変換設定を疑う
- nginx を挟んでいるなら `proxy_set_header Range $http_range;` と
  `gzip off;` を確認する
- レスポンスに `content-encoding` が付いていると Range は壊れる

## ログインタブが閉じない / 何枚も開く

`cookies` 権限と、対象オリジンへの host permission の両方が必要。
`chrome://extensions` の詳細で「サイトへのアクセス」を確認する。

Cloudflare Access のセッション長が短いと、ログインタブが頻繁に出る。
Zero Trust ダッシュボードで 24 時間程度に伸ばす。

## しばらく放置したあと最初の操作が失敗する

MV3 の service worker はアイドルで終了する。open 中のファイル状態は
`chrome.storage.session` から復元するが、復元できなかった場合は
`FAILED` を返して Files アプリに開き直させる設計になっている。
2 回目の操作で回復するなら想定内。毎回失敗する場合は issue に。
