#!/usr/bin/env bash
# 複数の WebDAV 実装に対して結合テストを流し、対応状況の表を出す。
#
#   bash test/tools/compat.sh          # 全部
#   bash test/tools/compat.sh dufs     # 指定したものだけ
#   KEEP=1 bash test/tools/compat.sh   # 後で curl で突きたいのでサーバを残す
#
# ここで検証しているのは拡張の HTTP 層 (href の往復一致・Range GET・複数 propstat)。
# ChromeOS も chrome API も要らないので、実機を出さずに互換性を広げられる。
# Files アプリ側の確認は別途 Chromebook が要る。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="$ROOT/docker/compat/compose.yml"
export DAV_SHARE_PATH="${DAV_SHARE_PATH:-$(mktemp -d)}"

# name port kind
#   kind=dav         … 結合テストが全通過するべき
#   kind=no-propfind … WebDAV ではない構成。PROPFIND が 405 で断られることを確かめる
SERVERS=(
  "rclone   18081 dav"
  "apache   18082 dav"
  "dufs     18083 dav"
  "hacdias  18084 dav"
  "nginx    18085 no-propfind"
)

WANT=("$@")
selected() {
  [[ ${#WANT[@]} -eq 0 ]] && return 0
  local name=$1 w
  for w in "${WANT[@]}"; do [[ "$w" == "$name" ]] && return 0; done
  return 1
}

cleanup() {
  [[ -n "${KEEP:-}" ]] && { echo; echo "サーバは残してある。止めるには:"; echo "  DAV_SHARE_PATH=$DAV_SHARE_PATH docker compose -f $COMPOSE down"; return; }
  docker compose -f "$COMPOSE" down --remove-orphans >/dev/null 2>&1
}
trap cleanup EXIT

if [[ ! -e "$DAV_SHARE_PATH/sample-media.bin" ]]; then
  bash "$ROOT/test/tools/make-tree.sh" "$DAV_SHARE_PATH" >/dev/null
fi
echo "共有ツリー: $DAV_SHARE_PATH"

services=()
for row in "${SERVERS[@]}"; do
  read -r name _ _ <<<"$row"
  selected "$name" && services+=("$name")
done
[[ ${#services[@]} -eq 0 ]] && { echo "対象がない"; exit 1; }

echo "起動: ${services[*]}"
docker compose -f "$COMPOSE" up -d "${services[@]}" >/dev/null 2>&1 || {
  echo "docker compose up に失敗"; docker compose -f "$COMPOSE" up -d "${services[@]}"; exit 1;
}

status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }

results=()
failed=0
for row in "${SERVERS[@]}"; do
  read -r name port kind <<<"$row"
  selected "$name" || continue

  # 何かしら応答するようになるまで待つ (PROPFIND を持たない構成もあるので GET で見る)
  ready=""
  for _ in $(seq 1 40); do
    code=$(status_of "http://127.0.0.1:$port/")
    [[ "$code" != "000" ]] && { ready=1; break; }
    sleep 1
  done
  if [[ -z "$ready" ]]; then
    results+=("$name|起動せず|-|-")
    failed=1
    continue
  fi

  propfind=$(status_of -X PROPFIND "http://127.0.0.1:$port/" -H "Depth: 1")
  range=$(status_of -r 0-1023 "http://127.0.0.1:$port/sample-media.bin")

  if [[ "$kind" == "no-propfind" ]]; then
    # 動かないことを確かめる方の行。405 以外が返るなら前提が変わっている
    if [[ "$propfind" == "405" || "$propfind" == "501" ]]; then
      results+=("$name|対象外 (想定どおり)|$propfind|$range")
    else
      results+=("$name|想定外: PROPFIND が $propfind|$propfind|$range")
      failed=1
    fi
    continue
  fi

  out=$(node "$ROOT/test/live.mjs" "http://127.0.0.1:$port" 2>&1)
  checks=$(grep -oP 'チェック数: \K\d+' <<<"$out" | tail -1)
  if grep -q "すべて合格" <<<"$out"; then
    results+=("$name|合格 (${checks:-?} 件)|$propfind|$range")
  else
    results+=("$name|不合格|$propfind|$range")
    failed=1
    echo
    echo "--- $name の失敗内容 ---"
    sed -n '/失敗/,$p' <<<"$out" | head -30
  fi
done

# 日本語を含む列は printf の桁数がバイト数で数えられて揃わないので、最後に置く
echo
printf '%-10s %-9s %-10s %s\n' "server" "PROPFIND" "Range GET" "結合テスト"
printf '%-10s %-9s %-10s %s\n' "----------" "--------" "---------" "----------"
for r in "${results[@]}"; do
  IFS='|' read -r a b c d <<<"$r"
  printf '%-10s %-9s %-10s %s\n' "$a" "$c" "$d" "$b"
done

exit $failed
