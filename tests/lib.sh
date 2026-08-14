# Общие помощники для проверок API. Подключается каждым набором.
# Наборы гоняются через tests/run.sh — он поднимает сервер на отдельном порту
# с чистой базой, поэтому проверки могут рассчитывать на состояние seed.

API="${API:-http://localhost:3101/api}"
J='Content-Type: application/json'
ok=0
fail=0

chk() {
  if [ "$2" = "$3" ]; then
    echo "  ✓ $1"
    ok=$((ok + 1))
  else
    echo "  ✗ $1 — ждали [$3], получили [$2]"
    fail=$((fail + 1))
  fi
}

login() {
  curl -s -X POST "$API/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"pass123\"}" \
    | node -pe "JSON.parse(require('fs').readFileSync(0)).token"
}

# Выражение над разобранным JSON из stdin: … | J_ 'j.documents.length'
J_() { node -pe "const j=JSON.parse(require('fs').readFileSync(0)); $1"; }

# Итог набора. Счёт уходит в $SCORE_FILE, откуда его забирает run.sh.
finish() {
  echo
  echo "  итого: успешно $ok, провалено $fail"
  [ -n "${SCORE_FILE:-}" ] && echo "$ok $fail" >> "$SCORE_FILE"
  [ "$fail" -eq 0 ]
}
