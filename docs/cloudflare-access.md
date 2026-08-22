# Cloudflare Access の背後に置く

WebDAV サーバをインターネットに晒しつつ、認証を Cloudflare に任せる構成。
拡張は `CF_Authorization` cookie でこれを通り抜ける。

```
Chrome 拡張 → Cloudflare Access → cloudflared tunnel → WebDAV サーバ (loopback)
```

サーバは loopback にだけバインドしておけばよく、ポート開放も証明書管理も要らない。

## 1. トンネルを作る

```bash
cloudflared tunnel login
cloudflared tunnel create webdav
cloudflared tunnel route dns webdav dav.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: dav.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

```bash
cloudflared tunnel run webdav
```

> **ダッシュボード管理のトンネルを使っている場合**、ローカルに `config.yml` は無く、
> `cloudflared --token-file ...` で起動している。この場合 ingress の変更は
> Zero Trust ダッシュボード (Networks → Tunnels → Public Hostnames) から行う。
> どちらの方式かは `systemctl cat cloudflared` で起動コマンドを見れば分かる。

## 2. Access アプリケーションを作る

Zero Trust ダッシュボード → Access → Applications → Add an application →
**Self-hosted**:

| 項目 | 値 |
| --- | --- |
| Application domain | `dav.example.com` |
| Session Duration | **24 時間** を推奨 |
| App Launcher に表示 | 不要 |

セッション長は、拡張がログインタブを出す頻度に直結する。短くすると
ファイルを開くたびに認証を求められることになる。

ポリシーは通常どおり (メールアドレス指定、IdP グループなど) 設定する。

## 3. 確認

```bash
# 未認証は Access ログインへ 302 になる
curl -s -o /dev/null -w "%{http_code}\n" https://dav.example.com/         # → 302

# 認証を通して確認する
cloudflared access login https://dav.example.com
TOKEN=$(cloudflared access token -app=https://dav.example.com)

curl -s -X PROPFIND https://dav.example.com/ -H "Depth: 1" \
  -H "cf-access-token: $TOKEN" -o /dev/null -w "%{http_code}\n"           # → 207

# Range GET が Cloudflare を経由しても 206 のままであること (最重要)
curl -s -o /dev/null -w "%{http_code}\n" -r 0-1023 \
  https://dav.example.com/<実在ファイル> -H "cf-access-token: $TOKEN"      # → 206
```

3 つ目が **206** であることが最重要。ここが 200 になると、
FSP の部分読み込みが成立せずファイルを開くたびに全量転送が走る。
その場合は Speed → Optimization の圧縮/変換設定を疑う
(`content-encoding` が付いていないことも併せて確認する)。

結合テストをトンネル越しに流すこともできる:

```bash
CF_ACCESS_TOKEN=$(cloudflared access token -app=https://dav.example.com) \
  node test/live.mjs https://dav.example.com
```

> なお `cf-access-token` ヘッダは CLI 検証用の経路。
> 拡張本体はブラウザの `CF_Authorization` cookie を使うので、
> 認証の載せ方は違う。確認できるのは「Cloudflare を挟んだときの HTTP の振る舞い」。

## 拡張側の挙動

- マウント時に `/cdn-cgi/access/get-identity` を叩いて認証状態を先に確かめる
- 失効を検知すると `https://dav.example.com/` をタブで開く
- `CF_Authorization` cookie の設置を `chrome.cookies.onChanged` で検知したら、
  タブを閉じて待機中のリクエストを再開する
- 同時リクエストが何本あってもログインタブは 1 枚 (single-flight)
- 90 秒待って認証されなければ `FAILED` を返す。
  MFA 入力中の可能性があるのでタブは閉じず、次の要求で使い回す
