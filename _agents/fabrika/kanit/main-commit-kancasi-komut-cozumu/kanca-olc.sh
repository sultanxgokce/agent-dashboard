#!/usr/bin/env bash
# block-main-commit kancasının KARARINI ölçer: kanca node ile sahte PreToolUse girdisiyle çağrılır, HİÇBİR komut çalıştırılmaz.
# $1 = kanca dosyası · $2 = çalışma ağacı (dal ≠ main) · oturum cwd'si = /config/projects/Nexus (main)
# Beklenen: "ENGELLE" yalnız main'de gerçekten commit koşan biçimlerde.
H="$1"; WT="$2"; G="git"; C="commit"
k() {  # $1 beklenen · $2 komut metni
  local j; j="$(python3 -c 'import json,sys; print(json.dumps({"tool_input":{"command":sys.argv[1]},"cwd":"/config/projects/Nexus"}))' "$2")"
  printf '%s' "$j" | node "$H" >/dev/null 2>&1; local rc=$?
  local gercek=GECIR; [ $rc -eq 2 ] && gercek=ENGELLE
  local sonuc=DOGRU; [ "$gercek" = "$1" ] || sonuc=YANLIS
  printf '%-6s beklenen=%-7s kanca=%-7s :: %s\n' "$sonuc" "$1" "$gercek" "$2"
}
k GECIR   "cd $WT && $G $C -m x"
k GECIR   "$G -C $WT $C -m x"
k GECIR   "W=$WT; cd \$W && $G $C -m x"
k GECIR   "cd ~/projects/${WT#/config/projects/} && $G $C -m x"
k GECIR   "bash scripts/append-note.sh f \"not; $G $C yapıldı\""
k GECIR   "echo 'ders: main üstünde $G $C yasak'"
k ENGELLE "$G $C -m x"
k ENGELLE "cd /config/projects/Nexus && $G $C -m x"
k ENGELLE "$G -C /config/projects/Nexus $C -m x"
k ENGELLE "cd $WT && cd /config/projects/Nexus && $G $C -m x"
