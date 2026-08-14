. "$(dirname "$0")/lib.sh"

# Даты берём от текущего месяца: seed живёт относительно сегодня, и жёсткие
# даты в тестах протухли бы через месяц.
M=$(date +%Y-%m)
D1="$M-01"
D20="$M-20"

A=$(login anna@company.kz); O=$(login olga@company.kz); I=$(login igor@company.kz); E=$(login erlan@company.kz)
AH="Authorization: Bearer $A"; OH="Authorization: Bearer $O"; IH="Authorization: Bearer $I"; EH="Authorization: Bearer $E"

echo "── Маршрут согласования"
NEW=$(curl -s -X POST $API/documents -H "$J" -H "$IH" -d "{\"type\":\"invoice\",\"number\":\"ТЕСТ-1\",\"docDate\":\"$D1\",\"dueDate\":\"$D20\",\"counterpartyId\":4,\"expenseItemId\":3,\"amount\":50000,\"vat\":5357,\"purpose\":\"тест\",\"section\":\"suppliers\"}")
DID=$(printf '%s' "$NEW" | J_ 'j.document.id')
chk "создан черновик" "$(printf '%s' "$NEW" | J_ 'j.document.approvalStatus')" "draft"
chk "ответственный назначен по участку" "$(printf '%s' "$NEW" | J_ 'j.document.responsibleName')" "Иванова Анна"

chk "нельзя согласовать из черновика" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$DID/transition -H "$J" -H "$AH" -d '{"to":"approved"}')" "403"
chk "инициатор отправил на проверку" \
  "$(curl -s -X POST $API/documents/$DID/transition -H "$J" -H "$IH" -d '{"to":"review"}' | J_ 'j.document.approvalStatus')" "review"
chk "возврат без причины отклонён" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$DID/transition -H "$J" -H "$AH" -d '{"to":"returned","comment":"  "}')" "403"
chk "возврат с причиной" \
  "$(curl -s -X POST $API/documents/$DID/transition -H "$J" -H "$AH" -d '{"to":"returned","comment":"нет договора"}' | J_ 'j.document.approvalStatus')" "returned"
chk "причина попала в комментарии" \
  "$(curl -s $API/documents/$DID -H "$AH" | J_ 'j.document.comments.some(c=>c.kind==="return_reason"&&c.body==="нет договора")')" "true"
curl -s -o /dev/null -X POST $API/documents/$DID/transition -H "$J" -H "$IH" -d '{"to":"review"}'
chk "согласовано бухгалтером" \
  "$(curl -s -X POST $API/documents/$DID/transition -H "$J" -H "$AH" -d '{"to":"approved"}' | J_ 'j.document.approvalStatus')" "approved"
chk "руководитель не двигает маршрут" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$DID/transition -H "$J" -H "$EH" -d '{"to":"review"}')" "403"

echo "── Порог главбуха (1 млн ₸)"
BIG=$(curl -s -X POST $API/documents -H "$J" -H "$IH" -d "{\"type\":\"invoice\",\"number\":\"ТЕСТ-БОЛЬШОЙ\",\"docDate\":\"$D1\",\"counterpartyId\":4,\"amount\":250000000,\"vat\":0,\"purpose\":\"крупный\",\"section\":\"suppliers\"}" | J_ 'j.document.id')
curl -s -o /dev/null -X POST $API/documents/$BIG/transition -H "$J" -H "$IH" -d '{"to":"review"}'
chk "бухгалтер не согласует 2,5 млн" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$BIG/transition -H "$J" -H "$AH" -d '{"to":"approved"}')" "403"
chk "главбух согласует 2,5 млн" \
  "$(curl -s -X POST $API/documents/$BIG/transition -H "$J" -H "$OH" -d '{"to":"approved"}' | J_ 'j.document.approvalStatus')" "approved"
# Порог задан в тиынах: 999 999 ₸ бухгалтер обязан проходить сам.
UNDER=$(curl -s -X POST $API/documents -H "$J" -H "$IH" -d "{\"type\":\"invoice\",\"number\":\"ТЕСТ-ПОД-ПОРОГ\",\"docDate\":\"$D1\",\"counterpartyId\":4,\"amount\":99999900,\"vat\":0,\"purpose\":\"под порогом\",\"section\":\"suppliers\"}" | J_ 'j.document.id')
curl -s -o /dev/null -X POST $API/documents/$UNDER/transition -H "$J" -H "$IH" -d '{"to":"review"}'
chk "999 999 ₸ бухгалтер согласует сам" \
  "$(curl -s -X POST $API/documents/$UNDER/transition -H "$J" -H "$AH" -d '{"to":"approved"}' | J_ 'j.document.approvalStatus')" "approved"

echo "── Учёт и оригинал"
chk "нельзя провести без оригинала" \
  "$(curl -s -X POST $API/documents/$DID/posting -H "$J" -H "$AH" -d '{"status":"posted"}' | J_ 'j.error')" \
  "Нельзя провести документ без оригинала или скана"
curl -s -o /dev/null -X POST $API/documents/$DID/original -H "$J" -H "$AH" -d '{"status":"received"}'
chk "после оригинала проводится" \
  "$(curl -s -X POST $API/documents/$DID/posting -H "$J" -H "$AH" -d '{"status":"posted"}' | J_ 'j.document.postingStatus')" "posted"
chk "инициатор не меняет оригинал" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/documents/$DID/original -H "$J" -H "$IH" -d '{"status":"signed"}')" "403"

echo "── Оплаты"
chk "неоплаченный попал в реестр на оплату" "$(curl -s $API/payments/payable -H "$AH" | J_ 'j.payable.some(p=>p.id==='$DID')')" "true"
chk "нельзя разнести больше остатка" \
  "$(curl -s -X POST $API/payments -H "$J" -H "$AH" -d "{\"paymentDate\":\"$D20\",\"amount\":99999999,\"allocations\":[{\"documentId\":$DID,\"amount\":99999999}]}" | J_ 'j.error.includes("остаток")')" "true"
chk "платёж без разнесения отклонён" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/payments -H "$J" -H "$AH" -d "{\"paymentDate\":\"$D20\",\"amount\":1000,\"allocations\":[]}")" "400"
PAY=$(curl -s -X POST $API/payments -H "$J" -H "$AH" -d "{\"paymentDate\":\"$D20\",\"amount\":30000,\"reference\":\"ПП-999\",\"allocations\":[{\"documentId\":$DID,\"amount\":30000}]}")
chk "частичная оплата проведена" "$(printf '%s' "$PAY" | J_ 'j.payment.amount')" "30000"
chk "документ стал «частично»" "$(curl -s $API/documents/$DID -H "$AH" | J_ 'j.document.paymentState')" "partial"
chk "остаток в реестре пересчитан" "$(curl -s $API/payments/payable -H "$AH" | J_ 'j.payable.find(p=>p.id==='$DID').outstanding')" "20000"
curl -s -o /dev/null -X POST $API/payments -H "$J" -H "$AH" -d "{\"paymentDate\":\"$D20\",\"amount\":20000,\"allocations\":[{\"documentId\":$DID,\"amount\":20000}]}"
chk "документ стал «оплачен»" "$(curl -s $API/documents/$DID -H "$AH" | J_ 'j.document.paymentState')" "paid"
chk "оплаченный ушёл из реестра" "$(curl -s $API/payments/payable -H "$AH" | J_ 'j.payable.some(p=>p.id==='$DID')')" "false"
chk "инициатор к оплатам не допущен" "$(curl -s -o /dev/null -w '%{http_code}' $API/payments/payable -H "$IH")" "403"

echo "── Массовое действие"
B1=$(curl -s -X POST $API/documents -H "$J" -H "$IH" -d "{\"type\":\"invoice\",\"number\":\"МАСС-1\",\"docDate\":\"$D1\",\"counterpartyId\":4,\"amount\":10000,\"section\":\"suppliers\"}" | J_ 'j.document.id')
B2=$(curl -s -X POST $API/documents -H "$J" -H "$IH" -d "{\"type\":\"invoice\",\"number\":\"МАСС-2\",\"docDate\":\"$D1\",\"counterpartyId\":4,\"amount\":20000,\"section\":\"suppliers\"}" | J_ 'j.document.id')
curl -s -o /dev/null -X POST $API/documents/$B1/transition -H "$J" -H "$IH" -d '{"to":"review"}'
BULK=$(curl -s -X POST $API/documents/bulk/transition -H "$J" -H "$AH" -d "{\"ids\":[$B1,$B2],\"to\":\"approved\"}")
chk "массово согласован только валидный" "$(printf '%s' "$BULK" | J_ 'j.applied.length')" "1"
chk "второй пропущен с причиной" "$(printf '%s' "$BULK" | J_ 'j.skipped[0].reason.includes("Черновик")')" "true"

echo "── Аудит"
chk "история документа пишется" "$(curl -s $API/documents/$DID -H "$AH" | J_ 'j.document.history.length>=6')" "true"
chk "в истории есть возврат с причиной" \
  "$(curl -s $API/documents/$DID -H "$AH" | J_ 'j.document.history.some(h=>h.action==="approval"&&h.details&&h.details.to==="returned")')" "true"

echo "── Контрагенты"
chk "сальдо считается" \
  "$(curl -s $API/counterparties/2 -H "$AH" | J_ 'j.counterparty.accrued-j.counterparty.paid===j.counterparty.debt')" "true"
chk "БИН из 11 цифр отклонён" \
  "$(curl -s -X POST $API/counterparties -H "$J" -H "$AH" -d '{"bin":"12345678901","name":"Тест"}' | J_ 'j.error.includes("12 цифр")')" "true"
chk "дубль БИН отклонён" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/counterparties -H "$J" -H "$AH" -d '{"bin":"050740004321","name":"Дубль"}')" "409"

finish
