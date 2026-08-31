# rclone WebDAV ゲートウェイ

拡張が話す相手はただの WebDAV サーバなので、ここは一例に過ぎない。
Nextcloud、Apache `mod_dav`、nginx `dav_ext`、Synology WebDAV Server など、
**PROPFIND と Range GET さえ返せば何でも動く**。

rclone を選ぶ理由は、ローカルディレクトリを 1 コマンドで WebDAV 化でき、
`--read-only` が確実に効くこと。

## 起動

```bash
cp .env.example .env      # DAV_SHARE_PATH を自分の共有先に変更
docker compose up -d
```

## 検証

```bash
# XML でファイル一覧が返る (207)
curl -s -X PROPFIND http://127.0.0.1:8080/ -H "Depth: 1" | head -50

# Range GET が 206 を返す — これが必須要件
curl -s -o /dev/null -w "%{http_code}\n" -r 0-1023 http://127.0.0.1:8080/<実在ファイル>
```

Range GET が 200 (全量) を返す構成では、拡張は動くが
**ファイルを開くたびに全量ダウンロードが走る**。
ストリーミング再生の利点が消えるので、必ず 206 になることを確認すること。

## プロジェクト名を固定してある

`compose.yml` の先頭に `name:` を置いている。既定では **compose ファイルのある
ディレクトリ名** がプロジェクト名になるため、ここは `docker` になる。
`docker/` 配下に compose を置くリポジトリは珍しくないので、
別のリポジトリで `docker compose -f docker/docker-compose.yml up -d` を叩くと、
同一プロジェクトの同一サービスと見なされて**こちらのコンテナが巻き添えで
recreate される**。`down` なら消える。

`docker compose ls` で、意図したプロジェクト名になっているか確認できる。

固定した結果、既に 8080 を使っている WebDAV サーバがあると
`Bind for 127.0.0.1:8080 failed: port is already allocated` で**起動に失敗する**。
これは正しい挙動 (黙って相手を壊すより良い)。並べて動かしたいときはポートを変える:

```bash
DAV_BIND_PORT=8090 DAV_SHARE_PATH=... docker compose up -d
node ../test/live.mjs http://127.0.0.1:8090
```

## 設計メモ

- `--read-only` により PUT / DELETE / MKCOL は拒否される。
  拡張も読み取り専用なので二重に担保している
- ボリュームも `:ro` でマウントしている
- `user: 1000:1000` は共有ディレクトリの所有者に合わせる (`.env` で変更)
- rclone イメージには curl / wget が無いため healthcheck は `rclone lsd` で行う
