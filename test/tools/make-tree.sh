#!/usr/bin/env bash
# 検証用のディレクトリツリーを作る。
#
#   bash test/tools/make-tree.sh /tmp/davtree
#
# fixture 再生成 (make-fixtures.sh) と結合テスト (live.mjs / CI) が
# 同じツリーを見るように、名前の定義はここ 1 箇所に置く。
#
# 並んでいる名前は思いつきではない。README の設計メモが名指ししている
# 「サーバによってエンコードするかどうかが違う」文字 (+ = ' ( ~) と、
# パーセント記号そのもの・空白・非 ASCII を必ず含める。
# ここが往復しないと「一覧には出るが開けない」状態になる。
set -euo pipefail

DEST="${1:?usage: make-tree.sh <dir>}"
mkdir -p "$DEST"
cd "$DEST"

mkdir -p "画像" "ドキュメント & メモ" "My Documents" "nested/deep dir" "100% done"

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

# Range GET を試すための、内容が位置で決まる 2MiB のファイル。
# 途中を切り出しても正しさを判定できるように、バイト値を index から作る。
python3 -c "open('sample-media.bin','wb').write(bytes((i*7 + (i//251)*13) % 256 for i in range(2*1024*1024)))"

echo "tree written to $DEST"
