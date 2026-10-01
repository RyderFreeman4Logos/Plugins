#!/usr/bin/env bash
# Linux-only local Codex gate: no network, host HOME, services or model calls.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NODE=${1:-$(node -p 'process.execPath')}
RUNTIME=$(dirname "$(dirname "$(readlink -f "$NODE")")")
LEFHOOK=${LEFHOOK_BIN:-$(mise where lefthook)/lefthook}
[[ -x $LEFHOOK ]] || LEFHOOK=${LEFHOOK_BIN:-$(mise where lefthook)/bin/lefthook}
[[ -x $LEFHOOK ]]
TMPROOT=$(realpath "$HOME/tmp")
[[ $(stat -c %d "$TMPROOT") == "$(stat -c %d /mnt/ssd)" ]]
ancestor=$TMPROOT
while :; do
  mode=$(stat -c %a "$ancestor")
  [[ $((8#$mode & 0022)) == 0 || $((8#$mode & 01000)) != 0 ]]
  [[ $ancestor == / ]] && break
  ancestor=$(dirname "$ancestor")
done
export TMPDIR=$TMPROOT TMP=$TMPROOT TEMP=$TMPROOT
WORK=$(mktemp -d "$TMPROOT/codex-offline.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/ssd"
bwrap --unshare-all --die-with-parent --new-session \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --proc /proc --dev /dev --dir /home --dir /mnt --dir /tools --dir /bin \
  --ro-bind /usr/bin/dash /bin/sh \
  --bind "$WORK" /work --bind "$WORK/ssd" /mnt/ssd \
  --ro-bind "$ROOT/codex" /repo/codex --ro-bind "$ROOT/lefthook.yml" /repo/lefthook.yml \
  --ro-bind "$ROOT/.agents/plugins/marketplace.json" /repo/.agents/plugins/marketplace.json \
  --ro-bind "$RUNTIME" /runtime --ro-bind "$LEFHOOK" /tools/lefthook --clearenv \
  --setenv HOME /work/home --setenv TMPDIR /work --setenv TMP /work --setenv TEMP /work \
  --setenv LEFTHOOK_BIN /tools/lefthook --setenv PATH /tools:/runtime/bin:/usr/bin:/bin --chdir /repo/codex \
  /usr/bin/bash -eu -c '
    mkdir -p /work/home
    node --version
    node /runtime/lib/node_modules/npm/bin/npm-cli.js test
    node /runtime/lib/node_modules/npm/bin/npm-cli.js run check
    cd /repo
    node -e '\''const fs=require("fs"), assert=require("node:assert/strict"); const m=JSON.parse(fs.readFileSync(".agents/plugins/marketplace.json")); const p=m.plugins.find(p=>p.name==="everos"); assert.ok(p && fs.existsSync(p.source.path)); console.log("PASS marketplace");'\''
  '
