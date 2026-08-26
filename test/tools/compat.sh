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

# name port kind auth path
#   kind=dav         … 結合テストが全通過するべき
#   kind=no-propfind … WebDAV ではない構成。PROPFIND が 405 で断られることを確かめる
#   auth             … '-' か 'user:pass'。指定すると live.mjs を Basic 認証で流す
#   path             … '-' か baseurl。サブパスで配信している実装向け
SERVERS=(
  "rclone    18081 dav          -                   -"
  "apache    18082 dav          -                   -"
  "dufs      18083 dav          -                   -"
  "hacdias   18084 dav          -                   -"
  "dufs-auth 18086 dav          dav:s3cret          -"
  "nextcloud 18087 dav          dav:s3cret-compat-only /remote.php/dav/files/dav"
  "nginx     18085 no-propfind  -                   -"
)

# nextcloud は初回起動でインストールが走る。他は数秒で立つが、ここだけ待たされる。
READY_TIMEOUT="${READY_TIMEOUT:-240}"

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
  read -r name _ _ _ _ <<<"$row"
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
  read -r name port kind auth path <<<"$row"
  selected "$name" || continue

  curl_auth=()
  live_env=()
  if [[ "$auth" != "-" ]]; then
    curl_auth=(-u "$auth")
    live_env=(DAV_USER="${auth%%:*}" DAV_PASS="${auth#*:}")
  fi
  [[ "$path" == "-" ]] && path=""
  base="http://127.0.0.1:$port$path"

  # これから実際に投げるものが通るようになるまで待つ。
  # 「何か応答した」で先に進むと、nextcloud のインストール中の 503 を掴んでしまう。
  ready=""
  for _ in $(seq 1 "$READY_TIMEOUT"); do
    if [[ "$kind" == "dav" ]]; then
      code=$(status_of "${curl_auth[@]}" -X PROPFIND "$base/" -H "Depth: 0")
      [[ "$code" == "207" ]] && { ready=1; break; }
    else
      code=$(status_of "${curl_auth[@]}" "$base/")
      [[ "$code" != "000" ]] && { ready=1; break; }
    fi
    sleep 1
  done
  if [[ -z "$ready" ]]; then
    results+=("$name|起動せず (最後の応答 $code)|-|-")
    failed=1
    continue
  fi

  propfind=$(status_of "${curl_auth[@]}" -X PROPFIND "$base/" -H "Depth: 1")
  # nextcloud は自前のストレージなので共有ツリーのファイルは無い。
  # Range の単独確認は共有ツリーを配信している実装だけで行う (live.mjs が全実装で見る)。
  range="-"
  if [[ "$name" != "nextcloud" ]]; then
    range=$(status_of "${curl_auth[@]}" -r 0-1023 "$base/sample-media.bin")
  fi

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

  out=$(env "${live_env[@]}" node "$ROOT/test/live.mjs" "$base" 2>&1)
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
printf '%-11s %-9s %-10s %s\n' "server" "PROPFIND" "Range GET" "結合テスト"
printf '%-11s %-9s %-10s %s\n' "-----------" "--------" "---------" "----------"
for r in "${results[@]}"; do
  IFS='|' read -r a b c d <<<"$r"
  printf '%-11s %-9s %-10s %s\n' "$a" "$c" "$d" "$b"
done

exit $failed
