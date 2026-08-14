. "$(dirname "$0")/lib.sh"

# Набор идёт последним: 02 добавил документы и оплаты, 03 закрывал и открывал
# позапрошлый месяц. Поэтому все ожидаемые суммы берутся из ответов API,
# а не пишутся константами.

A=$(login anna@company.kz); O=$(login olga@company.kz); I=$(login igor@company.kz)
M=$(login marat@company.kz); E=$(login erlan@company.kz)
AH="Authorization: Bearer $A"; OH="Authorization: Bearer $O"; IH="Authorization: Bearer $I"
MH="Authorization: Bearer $M"; EH="Authorization: Bearer $E"

TODAY=$(date +%Y-%m-%d)
CUR=$(date +%Y-%m)
NEXT_M=$(date -d '+1 month' +%Y-%m)

echo "── Доступ"
chk "инициатор не допущен" "$(curl -s -o /dev/null -w '%{http_code}' $API/reconciliations -H "$IH")" "403"
chk "бухгалтер видит" "$(curl -s -o /dev/null -w '%{http_code}' $API/reconciliations -H "$AH")" "200"
chk "руководитель читает" "$(curl -s -o /dev/null -w '%{http_code}' $API/reconciliations -H "$EH")" "200"
chk "руководитель не формирует" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations -H "$J" -H "$EH" -d "{\"counterpartyId\":1,\"from\":\"$CUR-01\",\"to\":\"$TODAY\"}")" "403"
chk "несуществующий акт → 404" "$(curl -s -o /dev/null -w '%{http_code}' $API/reconciliations/99999 -H "$AH")" "404"

echo "── Демо-акты из seed"
chk "три акта заведены" "$(curl -s $API/reconciliations -H "$AH" | J_ 'j.total')" "3"
chk "один подписан" "$(curl -s $API/reconciliations -H "$AH" | J_ 'j.signed')" "1"
chk "один с расхождениями" "$(curl -s $API/reconciliations -H "$AH" | J_ 'j.disputed')" "1"
chk "у отправленного ответа ещё нет" \
  "$(curl -s $API/reconciliations -H "$AH" | J_ 'j.acts.find(a=>a.status==="sent").theirClosing')" "null"
chk "у спорного расхождение ненулевое" \
  "$(curl -s $API/reconciliations -H "$AH" | J_ 'j.acts.find(a=>a.status==="disputed").diff !== 0')" "true"
chk "фильтр по статусу" \
  "$(curl -s "$API/reconciliations?status=signed" -H "$AH" | J_ 'j.acts.every(a=>a.status==="signed")')" "true"

echo "── Расчёт без сохранения"
PREV=$(curl -s "$API/reconciliations/preview?counterparty=2&from=2000-01-01&to=$TODAY" -H "$AH")
chk "превью считается" "$(printf '%s' "$PREV" | J_ 'typeof j.statement.closing')" "number"
chk "тождество сальдо" \
  "$(printf '%s' "$PREV" | J_ 'j.statement.closing === j.statement.opening + j.statement.accrued - j.statement.paid')" "true"
chk "перевёрнутый период → 400" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/reconciliations/preview?counterparty=2&from=2026-09-01&to=2026-08-01" -H "$AH")" "400"
chk "выдуманный контрагент → 400" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/reconciliations/preview?counterparty=999&from=2000-01-01&to=$TODAY" -H "$AH")" "400"

echo "── Акт сходится с карточкой контрагента"
# Единственная проверка, которая ловит расхождение правил отбора.
for CP in 1 2 3 4 5; do
  ACT_CLOSING=$(curl -s "$API/reconciliations/preview?counterparty=$CP&from=2000-01-01&to=2099-12-31" -H "$AH" | J_ 'j.statement.closing')
  CARD_DEBT=$(curl -s $API/counterparties/$CP -H "$AH" | J_ 'j.counterparty.debt')
  chk "контрагент $CP: акт $ACT_CLOSING = долг на карточке" "$ACT_CLOSING" "$CARD_DEBT"
done

echo "── Сцепка периодов"
# Конец одного периода обязан быть началом следующего, иначе сверка за год
# и сверка помесячно дадут разные цифры.
P1=$(curl -s "$API/reconciliations/preview?counterparty=1&from=2000-01-01&to=2026-07-31" -H "$AH")
P2=$(curl -s "$API/reconciliations/preview?counterparty=1&from=2026-08-01&to=2099-12-31" -H "$AH")
WHOLE=$(curl -s "$API/reconciliations/preview?counterparty=1&from=2000-01-01&to=2099-12-31" -H "$AH")
chk "конец первого = начало второго" \
  "$(printf '%s' "$P1" | J_ 'j.statement.closing')" "$(printf '%s' "$P2" | J_ 'j.statement.opening')"
chk "конец второго = конец целого" \
  "$(printf '%s' "$P2" | J_ 'j.statement.closing')" "$(printf '%s' "$WHOLE" | J_ 'j.statement.closing')"
chk "обороты складываются" \
  "$(printf '%s' "$WHOLE" | J_ 'j.statement.accrued')" \
  "$(node -pe "$(printf '%s' "$P1" | J_ 'j.statement.accrued') + $(printf '%s' "$P2" | J_ 'j.statement.accrued')")"

echo "── Границы диапазона включительно"
DOC_DATE="$CUR-15"
BND=$(curl -s -X POST $API/documents -H "$J" -H "$AH" -d "{\"type\":\"invoice\",\"number\":\"ГРАНИЦА-1\",\"docDate\":\"$DOC_DATE\",\"counterpartyId\":3,\"amount\":777700,\"vat\":0,\"purpose\":\"проверка границ\",\"section\":\"suppliers\"}" | J_ 'j.document.id')
IN_START=$(curl -s "$API/reconciliations/preview?counterparty=3&from=$DOC_DATE&to=$CUR-28" -H "$AH" | J_ 'j.statement.lines.some(l=>l.title.includes("ГРАНИЦА-1"))')
IN_END=$(curl -s "$API/reconciliations/preview?counterparty=3&from=$CUR-01&to=$DOC_DATE" -H "$AH" | J_ 'j.statement.lines.some(l=>l.title.includes("ГРАНИЦА-1"))')
OUTSIDE=$(curl -s "$API/reconciliations/preview?counterparty=3&from=$CUR-01&to=$CUR-14" -H "$AH" | J_ 'j.statement.lines.some(l=>l.title.includes("ГРАНИЦА-1"))')
chk "документ ровно на начале периода — в оборотах" "$IN_START" "true"
chk "документ ровно на конце периода — в оборотах" "$IN_END" "true"
chk "за день до начала — не в оборотах" "$OUTSIDE" "false"
chk "но он ушёл в сальдо на начало" \
  "$(curl -s "$API/reconciliations/preview?counterparty=3&from=$CUR-16&to=$CUR-28" -H "$AH" | J_ 'j.statement.opening > 0')" "true"

echo "── Две оси времени: документ и оплата в разных месяцах"
curl -s -o /dev/null -X POST $API/documents/$BND/transition -H "$J" -H "$AH" -d '{"to":"review"}'
curl -s -o /dev/null -X POST $API/documents/$BND/transition -H "$J" -H "$AH" -d '{"to":"approved"}'
PAY_DATE="$NEXT_M-05"
curl -s -o /dev/null -X POST $API/payments -H "$J" -H "$AH" -d "{\"paymentDate\":\"$PAY_DATE\",\"amount\":777700,\"reference\":\"ПП-ГРАНИЦА\",\"allocations\":[{\"documentId\":$BND,\"amount\":777700}]}"
THIS=$(curl -s "$API/reconciliations/preview?counterparty=3&from=$CUR-01&to=$CUR-28" -H "$AH")
NEXT=$(curl -s "$API/reconciliations/preview?counterparty=3&from=$NEXT_M-01&to=$NEXT_M-28" -H "$AH")
chk "в своём месяце документ дал только начисление" \
  "$(printf '%s' "$THIS" | J_ 'j.statement.lines.filter(l=>l.title.includes("ГРАНИЦА-1")).every(l=>l.accrued>0&&l.paid===0)')" "true"
chk "оплата попала в месяц платежа" \
  "$(printf '%s' "$NEXT" | J_ 'j.statement.lines.some(l=>l.title.includes("ПП-ГРАНИЦА")&&l.paid===777700)')" "true"
chk "и не попала в месяц документа" \
  "$(printf '%s' "$THIS" | J_ 'j.statement.lines.some(l=>l.title.includes("ПП-ГРАНИЦА"))')" "false"

echo "── Чужие суммы не протекают"
# Платёж, разнесённый на двух контрагентов, даёт каждому только его часть.
D_A=$(curl -s -X POST $API/documents -H "$J" -H "$AH" -d "{\"type\":\"invoice\",\"number\":\"СПЛИТ-A\",\"docDate\":\"$CUR-10\",\"counterpartyId\":3,\"amount\":100000,\"vat\":0,\"purpose\":\"сплит\",\"section\":\"suppliers\"}" | J_ 'j.document.id')
D_B=$(curl -s -X POST $API/documents -H "$J" -H "$AH" -d "{\"type\":\"invoice\",\"number\":\"СПЛИТ-B\",\"docDate\":\"$CUR-10\",\"counterpartyId\":5,\"amount\":200000,\"vat\":0,\"purpose\":\"сплит\",\"section\":\"suppliers\"}" | J_ 'j.document.id')
for D in $D_A $D_B; do
  curl -s -o /dev/null -X POST $API/documents/$D/transition -H "$J" -H "$AH" -d '{"to":"review"}'
  curl -s -o /dev/null -X POST $API/documents/$D/transition -H "$J" -H "$AH" -d '{"to":"approved"}'
done
curl -s -o /dev/null -X POST $API/payments -H "$J" -H "$AH" -d "{\"paymentDate\":\"$CUR-11\",\"amount\":300000,\"reference\":\"ПП-СПЛИТ\",\"allocations\":[{\"documentId\":$D_A,\"amount\":100000},{\"documentId\":$D_B,\"amount\":200000}]}"
chk "контрагенту 3 досталась своя часть" \
  "$(curl -s "$API/reconciliations/preview?counterparty=3&from=$CUR-11&to=$CUR-11" -H "$AH" | J_ 'j.statement.lines.find(l=>l.title.includes("ПП-СПЛИТ")).paid')" "100000"
chk "контрагенту 5 — своя" \
  "$(curl -s "$API/reconciliations/preview?counterparty=5&from=$CUR-11&to=$CUR-11" -H "$AH" | J_ 'j.statement.lines.find(l=>l.title.includes("ПП-СПЛИТ")).paid')" "200000"
chk "один платёж — одна строка, а не по разнесению" \
  "$(curl -s "$API/reconciliations/preview?counterparty=3&from=$CUR-11&to=$CUR-11" -H "$AH" | J_ 'j.statement.lines.filter(l=>l.title.includes("ПП-СПЛИТ")).length')" "1"

echo "── Формирование акта"
NEW=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":3,\"from\":\"$CUR-01\",\"to\":\"$CUR-28\"}")
ACT=$(printf '%s' "$NEW" | J_ 'j.act.id')
chk "акт создан черновиком" "$(printf '%s' "$NEW" | J_ 'j.act.status')" "draft"
chk "номер выдан" "$(printf '%s' "$NEW" | J_ '/^АС-\d{4}-\d{3}$/.test(j.act.number)')" "true"
chk "тождество сальдо в снимке" \
  "$(printf '%s' "$NEW" | J_ 'j.act.closing === j.act.opening + j.act.accrued - j.act.paid')" "true"
chk "строки снимка записаны" "$(printf '%s' "$NEW" | J_ 'j.act.lines.length > 0')" "true"
chk "правило отбора названо в акте" "$(printf '%s' "$NEW" | J_ 'j.act.basis.length > 0')" "true"
chk "дрейфа сразу после сборки нет" "$(printf '%s' "$NEW" | J_ 'j.act.drift.changed')" "false"
chk "ответственный подставлен от контрагента" "$(printf '%s' "$NEW" | J_ 'j.act.responsibleName')" "Иванова Анна"
chk "дубль периода → 409" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":3,\"from\":\"$CUR-01\",\"to\":\"$CUR-28\"}")" "409"
chk "в ошибке дубля есть id существующего" \
  "$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":3,\"from\":\"$CUR-01\",\"to\":\"$CUR-28\"}" | J_ 'j.id')" "$ACT"

echo "── Права по участку"
chk "право на правку приходит с сервера" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.permissions.edit')" "true"
chk "у чужого участка права нет" \
  "$(curl -s $API/reconciliations/$ACT -H "$MH" | J_ 'j.act.permissions.edit')" "false"
chk "и сказано почему" \
  "$(curl -s $API/reconciliations/$ACT -H "$MH" | J_ 'j.act.permissions.editDenied.includes("Иванова Анна")')" "true"
chk "руководителю правка закрыта" \
  "$(curl -s $API/reconciliations/$ACT -H "$EH" | J_ 'j.act.permissions.edit')" "false"
chk "чужой участок не ведёт акт" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/rebuild -H "$MH")" "403"
chk "в отказе назван ответственный" \
  "$(curl -s -X POST $API/reconciliations/$ACT/rebuild -H "$MH" | J_ 'j.error.includes("Иванова Анна")')" "true"
chk "главбух проходит везде" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/rebuild -H "$OH")" "200"

echo "── Пересборка не теряет работу бухгалтера"
RB_LINE=$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.kind==="document").id')
RB_SUM=$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.id==='$RB_LINE').ourAmount')
curl -s -o /dev/null -X PATCH $API/reconciliations/$ACT/lines/$RB_LINE -H "$J" -H "$AH" -d "{\"theirAmount\":$RB_SUM,\"comment\":\"сверено с их выпиской\"}"
curl -s -o /dev/null -X POST $API/reconciliations/$ACT/rebuild -H "$AH"
chk "сумма контрагента пережила пересборку" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.filter(l=>l.theirAmount==='$RB_SUM'&&l.comment==="сверено с их выпиской").length')" "1"
chk "и диагноз остался «сходится»" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.comment==="сверено с их выпиской").match')" "match"
# Возвращаем строку в несверенное состояние — следующий блок начинает с чистого.
RB_LINE=$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.comment==="сверено с их выпиской").id')
curl -s -o /dev/null -X PATCH $API/reconciliations/$ACT/lines/$RB_LINE -H "$J" -H "$AH" -d '{"theirAmount":null,"comment":""}'

echo "── Данные контрагента и диагноз строк"
OUR=$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.closing')
LINE=$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.kind==="document").id')
LINE_SUM=$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.kind==="document").ourAmount')
chk "строка сначала не сверена" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.id==='$LINE').match')" "unknown"
chk "равная сумма → сходится" \
  "$(curl -s -X PATCH $API/reconciliations/$ACT/lines/$LINE -H "$J" -H "$AH" -d "{\"theirAmount\":$LINE_SUM}" | J_ 'j.act.lines.find(l=>l.id==='$LINE').match')" "match"
chk "другая сумма → расхождение" \
  "$(curl -s -X PATCH $API/reconciliations/$ACT/lines/$LINE -H "$J" -H "$AH" -d "{\"theirAmount\":1}" | J_ 'j.act.lines.find(l=>l.id==='$LINE').match')" "amount_diff"
chk "и посчитана разница" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.id==='$LINE').delta')" "$(node -pe "$LINE_SUM - 1")"
chk "ноль → у контрагента строки нет" \
  "$(curl -s -X PATCH $API/reconciliations/$ACT/lines/$LINE -H "$J" -H "$AH" -d '{"theirAmount":0}' | J_ 'j.act.lines.find(l=>l.id==='$LINE').match')" "only_ours"
chk "дробная сумма отклонена" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/reconciliations/$ACT/lines/$LINE -H "$J" -H "$AH" -d '{"theirAmount":10.5}')" "400"

echo "── Подсказка «расхождение равно НДС»"
VATDOC=$(curl -s -X POST $API/documents -H "$J" -H "$AH" -d "{\"type\":\"invoice\",\"number\":\"НДС-ТЕСТ\",\"docDate\":\"$CUR-20\",\"counterpartyId\":4,\"amount\":1120000,\"vat\":120000,\"purpose\":\"с НДС\",\"section\":\"suppliers\"}" | J_ 'j.document.id')
VACT=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":4,\"from\":\"$CUR-20\",\"to\":\"$CUR-20\"}" | J_ 'j.act.id')
VLINE=$(curl -s $API/reconciliations/$VACT -H "$AH" | J_ 'j.act.lines.find(l=>l.title.includes("НДС-ТЕСТ")).id')
chk "контрагент показал сумму без НДС" \
  "$(curl -s -X PATCH $API/reconciliations/$VACT/lines/$VLINE -H "$J" -H "$AH" -d '{"theirAmount":1000000}' | J_ 'j.act.lines.find(l=>l.id==='$VLINE').hint.includes("равно НДС")')" "true"

echo "── Строки контрагента"
ADD=$(curl -s -X POST $API/reconciliations/$ACT/lines -H "$J" -H "$AH" -d "{\"date\":\"$CUR-12\",\"title\":\"НК-7781\",\"theirAmount\":500000}")
NEWLINE=$(printf '%s' "$ADD" | J_ 'j.lineId')
chk "строка добавлена" "$(printf '%s' "$ADD" | J_ 'j.act.lines.find(l=>l.id==='$NEWLINE').match')" "only_theirs"
chk "без суммы не добавить" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/lines -H "$J" -H "$AH" -d "{\"date\":\"$CUR-12\",\"title\":\"Пусто\"}")" "400"
chk "без названия не добавить" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/lines -H "$J" -H "$AH" -d "{\"date\":\"$CUR-12\",\"title\":\"  \",\"theirAmount\":100}")" "400"
chk "строка контрагента удаляется" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/reconciliations/$ACT/lines/$NEWLINE -H "$AH")" "200"
chk "строку снимка удалить нельзя" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/reconciliations/$ACT/lines/$LINE -H "$AH")" "409"

echo "── Импорт выписки контрагента"
# Выписку «контрагента» строим из собственных строк акта плюс одна лишняя:
# так проверяется и сопоставление, и то, что чужое заводится отдельной строкой.
TMP=$(mktemp -d)
OUR_COUNT=$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.filter(l=>l.kind!=="their").length')
# Колонки «начислено» и «оплачено» — иначе оплата приедет как начисление
# и не сойдётся с нашей платёжной строкой.
curl -s $API/reconciliations/$ACT -H "$AH" \
  | J_ 'j.act.lines.filter(l=>l.kind!=="their").map(l=>l.date+";"+l.title.replace(/[;\n]/g,"")+";"+(l.accrued/100).toFixed(2)+";"+(l.paid/100).toFixed(2)).join("\n") + "\n01.01.2020;НК-9999;1500.00;0.00"' \
  > "$TMP/import.txt"
node -pe "JSON.stringify({text: require('fs').readFileSync(process.argv[1], 'utf8')})" -- "$TMP/import.txt" > "$TMP/body.json"
IMPORTED=$(curl -s -X POST $API/reconciliations/$ACT/import -H "$J" -H "$AH" --data-binary @"$TMP/body.json")
chk "разобрано столько же строк, сколько своих плюс одна чужая" \
  "$(printf '%s' "$IMPORTED" | J_ 'j.parsed.rows')" "$(node -pe "$OUR_COUNT + 1")"
chk "наши строки сошлись" \
  "$(printf '%s' "$IMPORTED" | J_ 'j.act.lines.filter(l=>l.kind!=="their").every(l=>l.match==="match")')" "true"
chk "чужая строка заведена" \
  "$(printf '%s' "$IMPORTED" | J_ 'j.act.lines.some(l=>l.kind==="their"&&l.title.includes("НК-9999"))')" "true"
chk "пустой импорт → 400" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/import -H "$J" -H "$AH" -d '{"text":"   "}')" "400"
chk "неразбираемый импорт → 400 с причинами" \
  "$(curl -s -X POST $API/reconciliations/$ACT/import -H "$J" -H "$AH" -d '{"text":"всякая чепуха\nи ещё"}' | J_ 'j.skipped.length > 0')" "true"
chk "исходная строка сохранена для контроля" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.some(l=>l.theirRaw.includes("НК-9999"))')" "true"
# Повторный импорт заменяет прошлую выписку, но не трогает ручную работу.
MANUAL=$(curl -s -X POST $API/reconciliations/$ACT/lines -H "$J" -H "$AH" -d "{\"date\":\"$CUR-14\",\"title\":\"РУЧНАЯ-СТРОКА\",\"theirAmount\":123400}" | J_ 'j.lineId')
REIMPORTED=$(curl -s -X POST $API/reconciliations/$ACT/import -H "$J" -H "$AH" --data-binary @"$TMP/body.json")
chk "повторный импорт даёт тот же счёт строк" \
  "$(printf '%s' "$REIMPORTED" | J_ 'j.parsed.rows')" "$(node -pe "$OUR_COUNT + 1")"
chk "строка из прошлой выписки не задвоилась" \
  "$(printf '%s' "$REIMPORTED" | J_ 'j.act.lines.filter(l=>l.title.includes("НК-9999")).length')" "1"
chk "ручная строка пережила импорт" \
  "$(printf '%s' "$REIMPORTED" | J_ 'j.act.lines.some(l=>l.id==='$MANUAL')')" "true"
curl -s -o /dev/null -X DELETE $API/reconciliations/$ACT/lines/$MANUAL -H "$AH"

echo "── Разбор расхождений"
THEIRLINE=$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.kind==="their").id')
chk "чужая строка требует разбора" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.id==='$THEIRLINE').needsWork')" "true"
chk "у неё есть подсказка" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.lines.find(l=>l.id==='$THEIRLINE').hint.length > 0')" "true"
chk "разбор без объяснения отклонён" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/lines/$THEIRLINE/resolve -H "$J" -H "$AH" -d '{"comment":"  "}')" "400"
chk "мелкое расхождение закрывает бухгалтер" \
  "$(curl -s -X POST $API/reconciliations/$ACT/lines/$THEIRLINE/resolve -H "$J" -H "$AH" -d '{"comment":"накладная относится к другому договору"}' | J_ 'j.act.lines.find(l=>l.id==='$THEIRLINE').resolved')" "true"
chk "и она больше не требует работы" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.warnings.unresolved')" "0"

# Порог: расхождение крупнее 50 000 ₸ закрывает только главбух.
BIGLINE=$(curl -s -X POST $API/reconciliations/$ACT/lines -H "$J" -H "$AH" -d "{\"date\":\"$CUR-13\",\"title\":\"КРУПНОЕ-РАСХОЖДЕНИЕ\",\"theirAmount\":9000000}" | J_ 'j.lineId')
chk "крупное бухгалтеру не закрыть" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/lines/$BIGLINE/resolve -H "$J" -H "$AH" -d '{"comment":"разберёмся"}')" "403"
chk "в отказе сказано, кто может" \
  "$(curl -s -X POST $API/reconciliations/$ACT/lines/$BIGLINE/resolve -H "$J" -H "$AH" -d '{"comment":"разберёмся"}' | J_ 'j.error.includes("только главный бухгалтер")')" "true"
chk "главбух закрывает крупное" \
  "$(curl -s -X POST $API/reconciliations/$ACT/lines/$BIGLINE/resolve -H "$J" -H "$OH" -d '{"comment":"это наш неучтённый акт, заведём отдельно"}' | J_ 'j.act.lines.find(l=>l.id==='$BIGLINE').resolved')" "true"
curl -s -o /dev/null -X DELETE $API/reconciliations/$ACT/lines/$BIGLINE -H "$AH"

echo "── Жизненный цикл"
chk "из черновика сразу в disputed нельзя" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"disputed","comment":"есть расхождения"}')" "403"
curl -s -o /dev/null -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"sent"}'
chk "акт отправлен" "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.status')" "sent"
chk "без сальдо контрагента расхождение не зафиксировать" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"disputed","comment":"есть расхождения"}')" "400"
chk "дата отправки проставлена" "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.sentAt !== null')" "true"
chk "отправленный не пересобрать" \
  "$(curl -s -X POST $API/reconciliations/$ACT/rebuild -H "$OH" | J_ 'j.error.includes("уже отправлен")')" "true"
chk "бухгалтер не подписывает" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"signed"}')" "403"

curl -s -o /dev/null -X PATCH $API/reconciliations/$ACT -H "$J" -H "$AH" -d "{\"theirClosing\":$(node -pe "$OUR + 5000")}"
chk "при расхождении подпись отклонена" \
  "$(curl -s -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$OH" -d '{"to":"signed"}' | J_ 'j.error.includes("отличается")')" "true"
chk "расхождение фиксируется протоколом" \
  "$(curl -s -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"disputed","comment":"контрагент не увидел оплату"}' | J_ 'j.act.status')" "disputed"
chk "без причины расхождение не зафиксировать" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"sent"}' >/dev/null; curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"disputed","comment":" "}')" "403"

echo "── Подпись с протоколом расхождений"
# Из «расхождений» подписывают именно при несовпадающем сальдо — иначе переход
# был бы недостижим. Требование другое: все строки разобраны.
curl -s -o /dev/null -X PATCH $API/reconciliations/$ACT -H "$J" -H "$AH" -d "{\"theirClosing\":$(node -pe "$OUR + 7000")}"
curl -s -o /dev/null -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"disputed","comment":"фиксируем протокол"}'
chk "акт в расхождениях при несовпадающем сальдо" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.status + ":" + (j.act.diff !== 0)')" "disputed:true"
chk "бухгалтер протокол не подписывает" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"signed","comment":"подписываем"}')" "403"
chk "главбух подписывает с протоколом, сальдо не выравнивая" \
  "$(curl -s -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$OH" -d '{"to":"signed","comment":"подписали с протоколом расхождений"}' | J_ 'j.act.status')" "signed"
chk "расхождение в подписанном акте сохранено" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.diff !== 0')" "true"

# Возвращаемся к обычному пути: сальдо выровнено — подпись без протокола.
curl -s -o /dev/null -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$OH" -d '{"to":"sent","comment":"выравниваем сальдо"}'
curl -s -o /dev/null -X PATCH $API/reconciliations/$ACT -H "$J" -H "$AH" -d "{\"theirClosing\":$OUR}"
chk "после выравнивания сальдо подпись проходит" \
  "$(curl -s -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$OH" -d '{"to":"signed"}' | J_ 'j.act.status')" "signed"
chk "подписант зафиксирован" "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.signedByName')" "Ким Ольга"
chk "подписанный не правится" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/reconciliations/$ACT -H "$J" -H "$AH" -d '{"note":"поздно"}')" "409"
chk "подписанный не удаляется" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/reconciliations/$ACT -H "$OH")" "409"
chk "бухгалтер не отзывает подпись" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$AH" -d '{"to":"sent","comment":"назад"}')" "403"
chk "главбух отзывает подпись с причиной" \
  "$(curl -s -X POST $API/reconciliations/$ACT/transition -H "$J" -H "$OH" -d '{"to":"sent","comment":"нашли ошибку в сумме"}' | J_ 'j.act.status')" "sent"
chk "отметка о подписи снята" "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.signedAt')" "null"

echo "── Снимок не плывёт под удалённым платежом"
SNAP_ACT=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":3,\"from\":\"$NEXT_M-01\",\"to\":\"$NEXT_M-28\"}" | J_ 'j.act.id')
SNAP_CLOSING=$(curl -s $API/reconciliations/$SNAP_ACT -H "$AH" | J_ 'j.act.closing')
SNAP_LINES=$(curl -s $API/reconciliations/$SNAP_ACT -H "$AH" | J_ 'j.act.lines.length')
PAY_ID=$(curl -s --get --data-urlencode "search=ПП-ГРАНИЦА" $API/payments -H "$AH" | J_ 'j.payments[0].id')
curl -s -o /dev/null -X POST $API/reconciliations/$SNAP_ACT/transition -H "$J" -H "$AH" -d '{"to":"sent"}'
curl -s -o /dev/null -X DELETE $API/payments/$PAY_ID -H "$OH"
chk "цифры акта не изменились" "$(curl -s $API/reconciliations/$SNAP_ACT -H "$AH" | J_ 'j.act.closing')" "$SNAP_CLOSING"
chk "строка осталась на месте" "$(curl -s $API/reconciliations/$SNAP_ACT -H "$AH" | J_ 'j.act.lines.length')" "$SNAP_LINES"
chk "ссылка на удалённый платёж погасла" \
  "$(curl -s $API/reconciliations/$SNAP_ACT -H "$AH" | J_ 'j.act.lines.filter(l=>l.kind==="payment").every(l=>l.paymentId===null)')" "true"
chk "дрейф замечен" "$(curl -s $API/reconciliations/$SNAP_ACT -H "$AH" | J_ 'j.act.drift.changed')" "true"
chk "и посчитан" "$(curl -s $API/reconciliations/$SNAP_ACT -H "$AH" | J_ 'j.act.drift.delta !== 0')" "true"

echo "── Справочные предупреждения"
curl -s -o /dev/null -X POST $API/documents -H "$J" -H "$AH" -d "{\"type\":\"invoice\",\"number\":\"ЧЕРНОВИК-СВ\",\"docDate\":\"$CUR-22\",\"counterpartyId\":5,\"amount\":333300,\"vat\":0,\"purpose\":\"черновик\",\"section\":\"suppliers\"}"
WACT=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":5,\"from\":\"$CUR-22\",\"to\":\"$CUR-22\"}" | J_ 'j.act.id')
chk "несогласованное посчитано отдельно" \
  "$(curl -s $API/reconciliations/$WACT -H "$AH" | J_ 'j.act.warnings.unapprovedCount')" "1"
chk "и его сумма названа" \
  "$(curl -s $API/reconciliations/$WACT -H "$AH" | J_ 'j.act.warnings.unapproved')" "333300"
chk "но в сальдо оно вошло" \
  "$(curl -s $API/reconciliations/$WACT -H "$AH" | J_ 'j.act.closing >= 333300')" "true"

# Оплата по документу, который потом отклонили: деньги ушли, а из оборотов
# выпали. Объяснение обязано считаться по дате ПЛАТЕЖА, иначе в периоде
# оплаты сумма исчезает молча.
REJ_M=$(date -d '+2 month' +%Y-%m)
REJ_DOC=$(curl -s -X POST $API/documents -H "$J" -H "$AH" -d "{\"type\":\"invoice\",\"number\":\"ОТКЛОНЁННЫЙ-ОПЛАЧЕННЫЙ\",\"docDate\":\"$REJ_M-05\",\"counterpartyId\":2,\"amount\":555500,\"vat\":0,\"purpose\":\"оплатили и отклонили\",\"section\":\"suppliers\"}" | J_ 'j.document.id')
curl -s -o /dev/null -X POST $API/documents/$REJ_DOC/transition -H "$J" -H "$AH" -d '{"to":"review"}'
curl -s -o /dev/null -X POST $API/documents/$REJ_DOC/transition -H "$J" -H "$AH" -d '{"to":"approved"}'
curl -s -o /dev/null -X POST $API/payments -H "$J" -H "$AH" -d "{\"paymentDate\":\"$REJ_M-20\",\"amount\":555500,\"reference\":\"ПП-ОТКЛОН\",\"allocations\":[{\"documentId\":$REJ_DOC,\"amount\":555500}]}"
curl -s -o /dev/null -X POST $API/documents/$REJ_DOC/transition -H "$J" -H "$OH" -d '{"to":"review","comment":"отзываем"}'
curl -s -o /dev/null -X POST $API/documents/$REJ_DOC/transition -H "$J" -H "$OH" -d '{"to":"rejected","comment":"счёт оказался чужим"}'
PAYPERIOD=$(curl -s "$API/reconciliations/preview?counterparty=2&from=$REJ_M-15&to=$REJ_M-25" -H "$AH")
chk "оплата по отклонённому в обороты не попала" "$(printf '%s' "$PAYPERIOD" | J_ 'j.statement.paid')" "0"
chk "но она названа в периоде платежа" "$(printf '%s' "$PAYPERIOD" | J_ 'j.statement.excludedPaid')" "555500"
chk "и посчитана штука" "$(printf '%s' "$PAYPERIOD" | J_ 'j.statement.excludedPaidCount')" "1"
chk "в периоде документа этой оплаты нет" \
  "$(curl -s "$API/reconciliations/preview?counterparty=2&from=$REJ_M-01&to=$REJ_M-10" -H "$AH" | J_ 'j.statement.excludedPaid')" "0"
chk "зато там назван сам документ" \
  "$(curl -s "$API/reconciliations/preview?counterparty=2&from=$REJ_M-01&to=$REJ_M-10" -H "$AH" | J_ 'j.statement.excludedCount')" "1"

echo "── Удаление и аннулирование"
DEL=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":1,\"from\":\"$CUR-05\",\"to\":\"$CUR-06\"}" | J_ 'j.act.id')
chk "черновик бухгалтеру не удалить" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/reconciliations/$DEL -H "$AH")" "403"
chk "главбух удаляет черновик" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/reconciliations/$DEL -H "$OH")" "200"
chk "и его больше нет" "$(curl -s -o /dev/null -w '%{http_code}' $API/reconciliations/$DEL -H "$AH")" "404"
# Номер выдаётся от максимума, а не от количества: удалили акт из середины —
# следующий номер всё равно свободен, иначе UNIQUE упал бы в 500.
MID=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":2,\"from\":\"$CUR-07\",\"to\":\"$CUR-08\"}" | J_ 'j.act.id')
LAST_NUM=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":3,\"from\":\"$CUR-07\",\"to\":\"$CUR-08\"}" | J_ 'j.act.number')
curl -s -o /dev/null -X DELETE $API/reconciliations/$MID -H "$OH"
chk "после удаления из середины номер не переиспользуется" \
  "$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":4,\"from\":\"$CUR-07\",\"to\":\"$CUR-08\"}" | J_ 'j.act.number > "'$LAST_NUM'"')" "true"

CAN=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":1,\"from\":\"$CUR-05\",\"to\":\"$CUR-06\"}" | J_ 'j.act.id')
chk "аннулирование требует причины" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$CAN/transition -H "$J" -H "$OH" -d '{"to":"cancelled"}')" "403"
chk "главбух аннулирует с причиной" \
  "$(curl -s -X POST $API/reconciliations/$CAN/transition -H "$J" -H "$OH" -d '{"to":"cancelled","comment":"ошиблись периодом"}' | J_ 'j.act.status')" "cancelled"
chk "из аннулированного выходов нет" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$CAN/transition -H "$J" -H "$OH" -d '{"to":"sent"}')" "403"
chk "после аннулирования период снова свободен" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":1,\"from\":\"$CUR-05\",\"to\":\"$CUR-06\"}")" "201"

echo "── Закрытый период сверке не мешает"
# Осознанное отступление от сквозной заморозки: акт не меняет ни одной учётной
# цифры, а сверяются как раз после закрытия месяца.
OLD=$(date -d '-2 month' +%Y-%m)
# Диапазон нарочно не совпадает с демо-актом из seed по этому же контрагенту.
CREATED=$(curl -s -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":1,\"from\":\"$OLD-02\",\"to\":\"$OLD-27\"}")
FROZEN=$(printf '%s' "$CREATED" | J_ 'j.act.id')
chk "до закрытия акт не финальный" "$(printf '%s' "$CREATED" | J_ 'j.act.final')" "false"
for T in $(curl -s $API/periods/$OLD -H "$AH" | J_ 'j.period.tasks.filter(t=>!t.done).map(t=>t.id).join(" ")'); do
  curl -s -o /dev/null -X POST $API/periods/$OLD/tasks/$T/toggle -H "$AH"
done
curl -s -o /dev/null -X POST $API/periods/$OLD/close -H "$OH"
chk "период закрыт" "$(curl -s $API/periods/$OLD -H "$AH" | J_ 'j.period.status')" "closed"
chk "акт за закрытый месяц формируется" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations -H "$J" -H "$AH" -d "{\"counterpartyId\":2,\"from\":\"$OLD-01\",\"to\":\"$OLD-28\"}")" "201"
chk "и пересобирается" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reconciliations/$FROZEN/rebuild -H "$AH")" "200"
chk "и сальдо контрагента вносится" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/reconciliations/$FROZEN -H "$J" -H "$AH" -d '{"theirClosing":null}')" "200"
chk "и подписывается" \
  "$(curl -s -o /dev/null -X POST $API/reconciliations/$FROZEN/transition -H "$J" -H "$AH" -d '{"to":"sent"}' >/dev/null; curl -s -X POST $API/reconciliations/$FROZEN/transition -H "$J" -H "$OH" -d '{"to":"signed"}' | J_ 'j.act.status')" "signed"
chk "после закрытия акт помечен финальным" \
  "$(curl -s $API/reconciliations/$FROZEN -H "$AH" | J_ 'j.act.final')" "true"
chk "флаг закрытого периода виден" \
  "$(curl -s $API/reconciliations/$FROZEN -H "$AH" | J_ 'j.act.periodClosed')" "true"
# Но сверка не становится обходным путём заморозки: правка первички упирается
# в собственные 409 документов и платежей.
chk "документ закрытым месяцем всё так же не завести" \
  "$(curl -s -X POST $API/documents -H "$J" -H "$AH" -d "{\"type\":\"invoice\",\"number\":\"ОБХОД-СВЕРКА\",\"docDate\":\"$OLD-15\",\"counterpartyId\":1,\"amount\":1000,\"section\":\"suppliers\"}" | J_ 'j.error.includes("закрыт")')" "true"

echo "── Сводка для закрытия месяца"
chk "сводка считается" "$(curl -s "$API/reconciliations/summary?period=$CUR" -H "$AH" | J_ 'typeof j.summary.total')" "number"
chk "кривой период → 400" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/reconciliations/summary?period=2026-13-01" -H "$AH")" "400"
chk "должники без акта посчитаны" \
  "$(curl -s "$API/reconciliations/summary?period=$CUR" -H "$AH" | J_ 'typeof j.summary.debtorsWithoutAct')" "number"

echo "── Аудит"
chk "история акта пишется" "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.history.length >= 3')" "true"
chk "история отдаётся в клиентском виде, а не сырой" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.history.every(h=>typeof h.userName==="string"&&typeof h.createdAt==="string"&&h.user_name===undefined)')" "true"
chk "переход с причиной попал в историю" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.history.some(h=>h.action==="transition"&&h.details&&h.details.comment)')" "true"
chk "импорт отмечен в истории" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.history.some(h=>h.action==="imported")')" "true"
chk "удаление строки тоже пишется в аудит" \
  "$(curl -s $API/reconciliations/$ACT -H "$AH" | J_ 'j.act.history.some(h=>h.action==="line_deleted")')" "true"

echo "── Печатная форма"
CSV=$(curl -s "$API/reconciliations/$ACT/export.csv?token=$A")
chk "выгрузка отдаётся по токену в ссылке" "$(printf '%s' "$CSV" | head -c 3 | od -An -tx1 | tr -d ' \n')" "efbbbf"
chk "имя файла в заголовке — ASCII" \
  "$(curl -s -D- -o /dev/null "$API/reconciliations/$ACT/export.csv?token=$A" | grep -c 'filename=')" "1"
chk "обе стороны названы" "$(printf '%s' "$CSV" | grep -c 'Сторона 2')" "1"
chk "сальдо на начало есть" "$(printf '%s' "$CSV" | grep -c 'Сальдо на начало периода')" "1"
chk "сальдо на конец есть" "$(printf '%s' "$CSV" | grep -c 'Сальдо на конец периода')" "1"
chk "правило отбора напечатано" "$(printf '%s' "$CSV" | grep -c 'кроме отклонённых')" "1"
chk "место для подписей есть" "$(printf '%s' "$CSV" | grep -c 'От Стороны 1')" "1"

finish
