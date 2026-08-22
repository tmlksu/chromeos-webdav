#!/usr/bin/env bash
# テスト用 fixture を再生成する。
# パーセントエンコードで問題になりやすい名前を並べた合成ディレクトリを作り、
# 実際の rclone serve webdav の PROPFIND 出力を保存する。
#
#   bash test/tools/make-fixtures.sh
#
# 別の WebDAV 実装の出力も突き合わせたい場合は、同じツリーを配信して
# PORT を変えて実行する。
set -euo pipefail

PORT="${PORT:-18080}"
SHARE="$(mktemp -d)"
OUT="$(cd "$(dirname "$0")/../fixtures" && pwd)"

cleanup() { [[ -n "${RCLONE_PID:-}" ]] && kill "$RCLONE_PID" 2>/dev/null || true; rm -rf "$SHARE"; }
trap cleanup EXIT

mkdir -p "$SHARE"/{"画像","ドキュメント & メモ","My Documents","nested/deep dir","100% done"}
cd "$SHARE"
printf 'hello\n'  > "readme.txt"
printf 'plus\n'   > "a+b=c.txt"
printf 'pct\n'    > "100% progress.md"
printf 'quote\n'  > "it's here.txt"
printf 'brk\n'    > "[draft] notes.txt"
printf 'tilde\n'  > "~backup~.txt"
printf 'hash\n'   > "report #3 (final).md"
printf 'amp\n'    > "rock & roll.txt"
printf 'jp\n'     > "画像/写真 001.jpg"
printf 'jp2\n'    > "ドキュメント & メモ/議事録 2026-01.txt"
printf 'emoji\n'  > "émoji 🎵 track.mp3"
printf 'deep\n'   > "nested/deep dir/leaf.txt"
python3 -c "open('sample-media.bin','wb').write(bytes((i*7 + (i//251)*13) % 256 for i in range(2*1024*1024)))"

rclone serve webdav "$SHARE" --addr "127.0.0.1:$PORT" --read-only >/dev/null 2>&1 &
RCLONE_PID=$!
for _ in $(seq 1 20); do curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" && break; sleep 0.5; done

BODY='<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:displayname/><D:getcontenttype/></D:prop></D:propfind>'
enc() { node -e 'process.stdout.write(process.argv[1].split("/").map(encodeURIComponent).join("/"))' "$1"; }

curl -s -X PROPFIND "http://127.0.0.1:$PORT/" -H "Depth: 1" > "$OUT/propfind-root-depth1.xml"
curl -s -X PROPFIND "http://127.0.0.1:$PORT/" -H "Depth: 1" -H "Content-Type: application/xml" --data "$BODY" > "$OUT/propfind-root-depth1-proplimited.xml"
curl -s -X PROPFIND "http://127.0.0.1:$PORT$(enc '/画像/')" -H "Depth: 1" > "$OUT/propfind-japanese-depth1.xml"
curl -s -X PROPFIND "http://127.0.0.1:$PORT$(enc '/ドキュメント & メモ/')" -H "Depth: 1" > "$OUT/propfind-specialchars-depth1.xml"
curl -s -X PROPFIND "http://127.0.0.1:$PORT/sample-media.bin" -H "Depth: 0" > "$OUT/propfind-file-depth0.xml"
curl -s -X PROPFIND "http://127.0.0.1:$PORT$(enc '/画像/')" -H "Depth: 0" > "$OUT/propfind-dir-depth0.xml"

echo "fixtures written to $OUT"
ls -la "$OUT"
