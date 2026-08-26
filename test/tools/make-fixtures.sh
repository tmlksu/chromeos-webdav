#!/usr/bin/env bash
# テスト用 fixture を再生成する。
# make-tree.sh の検証用ツリーを rclone serve webdav で配信し、
# その実際の PROPFIND 出力を保存する (ツリーの定義は make-tree.sh 側)。
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

bash "$(dirname "$0")/make-tree.sh" "$SHARE" >/dev/null

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
