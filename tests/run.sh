#!/usr/bin/env bash
# Прогон всех проверок. Поднимает сервер на отдельном порту с чистой базой,
# по очереди гоняет наборы и суммирует итог.
#
#   tests/run.sh              — всё
#   tests/run.sh 03 05        — только наборы, чьё имя начинается с 03 и 05
#
# Наборы идут по порядку и меняют состояние базы: 02 заводит документы,
# 03 закрывает период. Порядок менять нельзя.

set -u
cd "$(dirname "$0")/.."

NODE=${NODE_BIN:-node}
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "Не найден node. Установите Node 24 (см. README) или задайте NODE_BIN=/путь/к/node."
  exit 1
fi
# Наборы дёргают node напрямую — пусть видят тот же бинарник.
PATH="$(dirname "$(command -v "$NODE")"):$PATH"
export PATH

PORT=${PORT:-3101}
export API="http://localhost:$PORT/api"

WORK=$(mktemp -d)
SRV=""
cleanup() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

export SCORE_FILE="$WORK/score"
: > "$SCORE_FILE"

# Порт обязан быть свободен. Иначе наш сервер не займёт его, health-check
# ответит ЧУЖОЙ процесс, и весь прогон уйдёт в чужую базу — проверки
# посыплются так, будто сломан код.
if curl -sf --max-time 2 "$API/health" >/dev/null 2>&1; then
  echo "Порт $PORT уже занят — на нём кто-то отвечает."
  echo "Это осиротевший сервер от прошлого прогона. Найдите и остановите его:"
  echo "  ss -lptnH 'sport = :$PORT'"
  echo "Или задайте другой порт: PORT=3102 tests/run.sh"
  exit 1
fi

echo "Поднимаю сервер на порту $PORT с чистой базой…"
DB_PATH="$WORK/test.db" UPLOAD_DIR="$WORK/uploads" PORT="$PORT" \
  "$NODE" node_modules/tsx/dist/cli.mjs server/index.ts > "$WORK/server.log" 2>&1 &
SRV=$!

for _ in $(seq 1 50); do
  curl -sf "$API/health" >/dev/null 2>&1 && break
  kill -0 "$SRV" 2>/dev/null || break
  sleep 0.2
done
if ! kill -0 "$SRV" 2>/dev/null || ! curl -sf "$API/health" >/dev/null 2>&1; then
  echo "Сервер не поднялся:"
  cat "$WORK/server.log"
  exit 1
fi

# Модульные проверки чистых функций — без API и без базы.
UNIT=0
for u in tests/unit-*.ts; do
  echo
  echo "══ $(basename "$u")"
  "$NODE" node_modules/tsx/dist/cli.mjs "$u" || UNIT=1
done

suites=()
for f in tests/[0-9][0-9]-*.sh; do
  if [ $# -eq 0 ]; then
    suites+=("$f")
  else
    for want in "$@"; do
      case "$(basename "$f")" in "$want"*) suites+=("$f") ;; esac
    done
  fi
done

for f in "${suites[@]}"; do
  echo
  echo "══ $(basename "$f")"
  bash "$f"
done

TOTAL_OK=0
TOTAL_FAIL=0
while read -r a b; do
  TOTAL_OK=$((TOTAL_OK + a))
  TOTAL_FAIL=$((TOTAL_FAIL + b))
done < "$SCORE_FILE"

echo
echo "═════════════════════════════════════════"
echo "ВСЕГО через API: успешно $TOTAL_OK, провалено $TOTAL_FAIL"
[ "$UNIT" -ne 0 ] && echo "Модульные проверки: провалены"
echo "═════════════════════════════════════════"

[ "$TOTAL_FAIL" -eq 0 ] && [ "$UNIT" -eq 0 ]
