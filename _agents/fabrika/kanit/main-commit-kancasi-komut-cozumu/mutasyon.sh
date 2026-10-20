#!/usr/bin/env bash
# block-main-commit.js bozmaları — her biri TAM ayrık kopyada (git worktree --detach HEAD), iş alanına dokunmaz.
# Önce bozmasız kopya (pozitif kontrol: fail 0). Düşen kapılar ADIYLA; sonuç satırı yoksa ÖLÇÜLEMEDİ.
set -u
DEPO="$(git rev-parse --show-toplevel)"; K="$(mktemp -d)"
trap 'for w in "$K"/w-*; do git -C "$DEPO" worktree remove --force "$w" >/dev/null 2>&1; done; rm -r -f -- "$K"' EXIT
H=adapters/claude-code/scripts/hooks
kos() {  # $1 ad · sonra (eski yeni) çiftleri
  local ad="$1"; shift; local w="$K/w-$ad"
  git -C "$DEPO" worktree add -q --detach "$w" HEAD || { echo "$ad: ÖLÇÜLEMEDİ (kopya)"; return; }
  while [ $# -ge 2 ]; do
    python3 -c 'import sys; p=sys.argv[1]; s=open(p).read(); assert sys.argv[2] in s, "desen yok: "+sys.argv[2][:40]; open(p,"w").write(s.replace(sys.argv[2],sys.argv[3],1))' "$w/$H/block-main-commit.js" "$1" "$2" \
      || { echo "$ad: DESEN YOK"; return; }
    shift 2
  done
  local o; o="$(cd "$w/$H" && timeout 200 node --test block-main-commit.test.js 2>&1)"
  if ! printf '%s' "$o" | grep -q '^# fail'; then echo "$ad: ÖLÇÜLEMEDİ (sonuç satırı yok)"; return; fi
  echo "$ad: $(printf '%s\n' "$o" | grep -E '^# (pass|fail)' | paste -sd' ') · düşen: $(printf '%s\n' "$o" | grep -E '^    not ok' | sed -E 's/^    not ok [0-9]+ - //' | paste -sd'|')"
}
kos pozitif-kontrol
kos tirnak-komut-sayilir   "if (c === \"'\") {" "if (false) {"
kos cd-izlenmez            "if (ad === 'cd' || ad === 'pushd') {" "if (false) {"
kos git-C-yok-sayilir      "if (s === '-C' && a + 1 < words.length) {" "if (false) {"
kos bash-c-acilmaz         "if (KABUK.has(ad)) {" "if (false) {"
kos alt-kabuk-sizar        "if (paren === ')') { if (yigin.length) {" "if (paren === ')') { if (false) {"
kos altkomut-taranmaz      "for (const b of subs) sonuc.push(" "for (const b of []) sonuc.push("
kos bilinmez-gecirir       "branch = dalOku(hedef === BILINMEZ ? oturum : hedef);" "if (hedef === BILINMEZ) continue; branch = dalOku(hedef);"
kos degisken-yok           "const v = Object.prototype.hasOwnProperty.call(vars, ad) ? vars[ad] : env[ad];" "const v = undefined;"
kos ilk-surum-takilma      "    if (j === i) { t = src[i]; j = i + 1; }" "" \
                           "if (c === '(' || c === ')') { komut();" "if ((c === '(' || c === ')') && !parts) { komut();"
