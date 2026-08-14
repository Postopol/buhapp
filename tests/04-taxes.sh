. "$(dirname "$0")/lib.sh"

A=$(login anna@company.kz); O=$(login olga@company.kz); I=$(login igor@company.kz); E=$(login erlan@company.kz)
AH="Authorization: Bearer $A"; OH="Authorization: Bearer $O"; IH="Authorization: Bearer $I"; EH="Authorization: Bearer $E"

echo "── Доступ"
chk "инициатор не допущен" "$(curl -s -o /dev/null -w '%{http_code}' $API/taxes -H "$IH")" "403"
chk "руководитель видит" "$(curl -s -o /dev/null -w '%{http_code}' $API/taxes -H "$EH")" "200"
chk "руководитель не отмечает" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/taxes/fno-300/2026-Q2/toggle -H "$EH")" "403"

echo "── Календарь"
chk "окно по умолчанию непустое" "$(curl -s $API/taxes -H "$AH" | J_ 'j.events.length>0')" "true"
chk "ответственные проставлены" "$(curl -s $API/taxes -H "$AH" | J_ 'j.events.every(e=>e.responsibleName)')" "true"
chk "все несданные по умолчанию" "$(curl -s $API/taxes -H "$AH" | J_ 'j.summary.done')" "0"
chk "события отсортированы" "$(curl -s $API/taxes -H "$AH" | J_ 'j.events.every((e,i,a)=>i===0||a[i-1].dueDate<=e.dueDate)')" "true"
chk "явное окно соблюдается" "$(curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.events.every(e=>e.dueDate>="2026-08-01"&&e.dueDate<="2026-08-31")')" "true"
chk "в августе 2026 пять сроков" "$(curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.events.length')" "5"
chk "перенос отмечен флагом" "$(curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.events.filter(e=>e.shifted).length')" "3"
chk "перевёрнутое окно → 400" "$(curl -s -o /dev/null -w '%{http_code}' "$API/taxes?from=2026-09-01&to=2026-08-01" -H "$AH")" "400"

echo "── Отметки"
chk "срок отмечается сданным" "$(curl -s -X POST $API/taxes/fno-300/2026-Q2/toggle -H "$AH" | J_ 'j.event.done')" "true"
chk "и виден в выборке" "$(curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.events.find(e=>e.code==="fno-300").done')" "true"
chk "кто отметил — записано" "$(curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.events.find(e=>e.code==="fno-300").doneByName')" "Иванова Анна"
chk "счётчик сданных вырос" "$(curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.summary.done')" "1"
chk "отметка снимается" "$(curl -s -X POST $API/taxes/fno-300/2026-Q2/toggle -H "$OH" | J_ 'j.event.done')" "false"
chk "выдуманный код → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/taxes/fno-999/2026-Q2/toggle -H "$AH")" "400"
chk "кривой период → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/taxes/fno-300/кв2/toggle -H "$AH")" "400"

echo "── Сумма и заметка"
chk "сумма сохраняется" "$(curl -s -X POST $API/taxes/pay-nds/2026-Q2/details -H "$J" -H "$AH" -d '{"amount":184500000,"note":"по книге покупок"}' | J_ 'j.ok')" "true"
chk "и возвращается" "$(curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.events.find(e=>e.code==="pay-nds").amount')" "184500000"
chk "заметка на месте" "$(curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.events.find(e=>e.code==="pay-nds").note')" "по книге покупок"
chk "отрицательная сумма отклонена" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/taxes/pay-nds/2026-Q2/details -H "$J" -H "$AH" -d '{"amount":-5}')" "400"
chk "сумма переживает toggle" "$(curl -s -X POST $API/taxes/pay-nds/2026-Q2/toggle -H "$AH" >/dev/null; curl -s "$API/taxes?from=2026-08-01&to=2026-08-31" -H "$AH" | J_ 'j.events.find(e=>e.code==="pay-nds").amount')" "184500000"

echo "── Рабочее место"
chk "сроки приехали на рабочее место" "$(curl -s $API/workspace -H "$AH" | J_ 'j.deadlines.length>0')" "true"
chk "сданные в сроки не попадают" "$(curl -s $API/workspace -H "$AH" | J_ 'j.deadlines.every(d=>!d.done)')" "true"
chk "инициатору сроков не показываем" "$(curl -s $API/workspace -H "$IH" | J_ 'j.deadlines.length')" "0"
chk "руководителю показываем" "$(curl -s $API/workspace -H "$EH" | J_ 'j.deadlines.length>0')" "true"

finish
