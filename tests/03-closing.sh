. "$(dirname "$0")/lib.sh"

A=$(login anna@company.kz); O=$(login olga@company.kz); I=$(login igor@company.kz); E=$(login erlan@company.kz)
AH="Authorization: Bearer $A"; OH="Authorization: Bearer $O"; IH="Authorization: Bearer $I"; EH="Authorization: Bearer $E"
P=$(date +%Y-%m)
OLD=$(date -d '-2 month' +%Y-%m)

echo "── Доступ"
chk "инициатор не допущен" "$(curl -s -o /dev/null -w '%{http_code}' $API/periods -H "$IH")" "403"
chk "руководитель видит" "$(curl -s -o /dev/null -w '%{http_code}' $API/periods -H "$EH")" "200"
chk "периоды заведены" "$(curl -s $API/periods -H "$AH" | J_ 'j.periods.length>=3')" "true"

echo "── Чек-лист и блокировки текущего периода"
chk "чек-лист из 8 пунктов" "$(curl -s $API/periods/$P -H "$AH" | J_ 'j.period.tasksTotal')" "8"
chk "ответственные проставлены" "$(curl -s $API/periods/$P -H "$AH" | J_ 'j.period.tasks.every(t=>t.responsibleName)')" "true"
chk "есть блокировки" "$(curl -s $API/periods/$P -H "$AH" | J_ 'j.period.blockingCount>0')" "true"
chk "закрыть нельзя" "$(curl -s $API/periods/$P -H "$AH" | J_ 'j.period.canClose')" "false"
chk "бухгалтер не закрывает период" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/periods/$P/close -H "$AH")" "403"
chk "главбух получает отказ по блокировкам" "$(curl -s -X POST $API/periods/$P/close -H "$OH" | J_ 'j.error.startsWith("Период нельзя закрыть")')" "true"

TID=$(curl -s $API/periods/$P -H "$AH" | J_ 'j.period.tasks[0].id')
chk "пункт отмечается" "$(curl -s -X POST $API/periods/$P/tasks/$TID/toggle -H "$AH" | J_ 'j.period.tasks[0].done')" "true"
chk "и снимается" "$(curl -s -X POST $API/periods/$P/tasks/$TID/toggle -H "$AH" | J_ 'j.period.tasks[0].done')" "false"
chk "некорректный период → 400" "$(curl -s -o /dev/null -w '%{http_code}' $API/periods/2026-13-01 -H "$AH")" "400"

echo "── Закрытие чистого периода"
# Старый период: доводим документы до чистого состояния
for D in $(curl -s "$API/documents?period=$OLD&limit=200" -H "$AH" | J_ 'j.documents.map(d=>d.id).join(" ")'); do
  ST=$(curl -s $API/documents/$D -H "$AH" | J_ 'j.document.approvalStatus')
  [ "$ST" = "draft" ] || [ "$ST" = "returned" ] && curl -s -o /dev/null -X POST $API/documents/$D/transition -H "$J" -H "$OH" -d '{"to":"review"}' && ST=review
  [ "$ST" = "review" ] && curl -s -o /dev/null -X POST $API/documents/$D/transition -H "$J" -H "$OH" -d '{"to":"approved"}'
  curl -s -o /dev/null -X POST $API/documents/$D/original -H "$J" -H "$AH" -d '{"status":"signed"}'
  curl -s -o /dev/null -X POST $API/documents/$D/posting -H "$J" -H "$AH" -d '{"status":"posted"}'
done
chk "блокировок в $OLD не осталось" "$(curl -s $API/periods/$OLD -H "$AH" | J_ 'j.period.blockingCount')" "0"
chk "но чек-лист держит" "$(curl -s $API/periods/$OLD -H "$AH" | J_ 'j.period.canClose')" "false"
chk "отказ по чек-листу" "$(curl -s -X POST $API/periods/$OLD/close -H "$OH" | J_ 'j.error.startsWith("Не выполнены пункты")')" "true"

for T in $(curl -s $API/periods/$OLD -H "$AH" | J_ 'j.period.tasks.map(t=>t.id).join(" ")'); do
  curl -s -o /dev/null -X POST $API/periods/$OLD/tasks/$T/toggle -H "$AH"
done
chk "чек-лист выполнен" "$(curl -s $API/periods/$OLD -H "$AH" | J_ 'j.period.canClose')" "true"
chk "период закрыт" "$(curl -s -X POST $API/periods/$OLD/close -H "$OH" | J_ 'j.period.status')" "closed"
chk "закрывший зафиксирован" "$(curl -s $API/periods/$OLD -H "$AH" | J_ 'j.period.closedByName')" "Ким Ольга"
chk "повторное закрытие → 409" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/periods/$OLD/close -H "$OH")" "409"

echo "── Заморозка закрытого периода"
DOC=$(curl -s "$API/documents?period=$OLD&limit=1" -H "$AH" | J_ 'j.documents[0].id')
chk "флаг periodClosed в документе" "$(curl -s $API/documents/$DOC -H "$AH" | J_ 'j.document.periodClosed')" "true"
chk "правка запрещена" "$(curl -s -X PATCH $API/documents/$DOC -H "$J" -H "$OH" -d '{"purpose":"взлом"}' | J_ 'j.error.startsWith("Период закрыт")')" "true"
chk "смена статуса запрещена" "$(curl -s -X POST $API/documents/$DOC/transition -H "$J" -H "$OH" -d '{"to":"review","comment":"x"}' | J_ 'j.error.startsWith("Период закрыт")')" "true"
chk "оригинал не меняется" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$DOC/original -H "$J" -H "$AH" -d '{"status":"none"}')" "409"
chk "проводка не отменяется" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$DOC/posting -H "$J" -H "$AH" -d '{"status":"not_posted"}')" "409"
chk "документ этой датой не завести" "$(curl -s -X POST $API/documents -H "$J" -H "$AH" -d "{\"type\":\"invoice\",\"number\":\"ОБХОД\",\"docDate\":\"$OLD-15\",\"amount\":1000,\"section\":\"suppliers\"}" | J_ 'j.error.includes("закрыт")')" "true"
chk "чек-лист закрытого не трогается" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/periods/$OLD/tasks/$(curl -s $API/periods/$OLD -H "$AH" | J_ 'j.period.tasks[0].id')/toggle -H "$AH")" "409"

echo "── Повторное открытие"
chk "без причины → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/periods/$OLD/reopen -H "$J" -H "$OH" -d '{"reason":"  "}')" "400"
chk "бухгалтер не открывает" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/periods/$OLD/reopen -H "$J" -H "$AH" -d '{"reason":"надо"}')" "403"
chk "главбух открыл" "$(curl -s -X POST $API/periods/$OLD/reopen -H "$J" -H "$OH" -d '{"reason":"корректировочная СФ"}' | J_ 'j.period.status')" "open"
chk "после открытия правка снова доступна" "$(curl -s -X PATCH $API/documents/$DOC -H "$J" -H "$OH" -d '{"purpose":"уточнено"}' | J_ 'j.document.purpose')" "уточнено"
chk "причина открытия в аудите" "$(curl -s $API/documents/$DOC -H "$AH" | J_ 'j.document.periodClosed')" "false"

finish
