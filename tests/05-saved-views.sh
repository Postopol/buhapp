. "$(dirname "$0")/lib.sh"

A=$(login anna@company.kz); O=$(login olga@company.kz); I=$(login igor@company.kz); M=$(login marat@company.kz)
AH="Authorization: Bearer $A"; OH="Authorization: Bearer $O"; IH="Authorization: Bearer $I"; MH="Authorization: Bearer $M"

echo "── Общие пресеты из seed"
chk "пять общих пресетов" "$(curl -s $API/views -H "$AH" | J_ 'j.views.filter(v=>v.shared).length')" "5"
chk "все помечены общими" "$(curl -s $API/views -H "$AH" | J_ 'j.views.every(v=>v.shared)')" "true"
chk "владелец — главбух" "$(curl -s $API/views -H "$AH" | J_ 'j.views[0].ownerName')" "Ким Ольга"
chk "у бухгалтера они не «свои»" "$(curl -s $API/views -H "$AH" | J_ 'j.views.every(v=>!v.mine)')" "true"
chk "у главбуха они «свои»" "$(curl -s $API/views -H "$OH" | J_ 'j.views.every(v=>v.mine)')" "true"

echo "── Счётчики совпадают с реестром"
for NAME in "Ждут проверки:approval=review" "Просроченные:overdue=true" "Нет оригинала:original=none"; do
  T="${NAME%%:*}"; Q="${NAME##*:}"
  VC=$(curl -s $API/views -H "$AH" | node -pe "JSON.parse(require('fs').readFileSync(0)).views.find(v=>v.name==='$T').count")
  DC=$(curl -s "$API/documents?$Q" -H "$AH" | J_ 'j.total')
  chk "«$T»: пресет $VC = реестр $DC" "$VC" "$DC"
done
chk "сумма пресета совпадает" "$(curl -s $API/views -H "$AH" | J_ 'j.views.find(v=>v.name==="Просроченные").amount')" "$(curl -s "$API/documents?overdue=true" -H "$AH" | J_ 'j.totals.amount')"

echo "── Область видимости счётчика"
IV=$(curl -s $API/views -H "$IH" | J_ 'j.views.find(v=>v.name==="Ждут проверки").count')
ID=$(curl -s "$API/documents?approval=review" -H "$IH" | J_ 'j.total')
chk "у инициатора счётчик сужен до своих ($IV)" "$IV" "$ID"
chk "и он меньше, чем у бухгалтера" "$(curl -s $API/views -H "$AH" | J_ "j.views.find(v=>v.name==='Ждут проверки').count > $IV")" "true"

echo "── Создание"
NEW=$(curl -s -X POST $API/views -H "$J" -H "$AH" -d '{"name":"Мои по аренде","query":{"search":"аренда","payment":"unpaid"}}')
VID=$(printf '%s' "$NEW" | J_ 'j.view.id')
chk "личный пресет создан" "$(printf '%s' "$NEW" | J_ 'j.view.mine')" "true"
chk "и не общий" "$(printf '%s' "$NEW" | J_ 'j.view.shared')" "false"
chk "виден владельцу" "$(curl -s $API/views -H "$AH" | J_ 'j.views.some(v=>v.name==="Мои по аренде")')" "true"
chk "не виден коллеге" "$(curl -s $API/views -H "$MH" | J_ 'j.views.some(v=>v.name==="Мои по аренде")')" "false"
chk "пустой фильтр отклонён" "$(curl -s -X POST $API/views -H "$J" -H "$AH" -d '{"name":"Пусто","query":{}}' | J_ 'j.error')" "Пустой фильтр сохранять незачем"
chk "без имени отклонён" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/views -H "$J" -H "$AH" -d '{"name":"  ","query":{"approval":"draft"}}')" "400"
chk "дубль имени → 409" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/views -H "$J" -H "$AH" -d '{"name":"Мои по аренде","query":{"approval":"draft"}}')" "409"
chk "мусорные ключи отброшены" "$(curl -s -X POST $API/views -H "$J" -H "$AH" -d '{"name":"Чистка","query":{"approval":"draft","DROP":"x","limit":"9999"}}' | J_ 'Object.keys(j.view.query).join()')" "approval"

echo "── Общий пресет заводит только главбух"
chk "бухгалтер не может сделать общий" "$(curl -s -X POST $API/views -H "$J" -H "$AH" -d '{"name":"Попытка общего","query":{"posting":"posted"},"shared":true}' | J_ 'j.view.shared')" "false"
chk "главбух может" "$(curl -s -X POST $API/views -H "$J" -H "$OH" -d '{"name":"Крупные счета","query":{"type":"invoice"},"shared":true}' | J_ 'j.view.shared')" "true"
chk "и он появился у бухгалтера" "$(curl -s $API/views -H "$AH" | J_ 'j.views.some(v=>v.name==="Крупные счета")')" "true"

echo "── Переименование и удаление"
chk "переименован" "$(curl -s -X PATCH $API/views/$VID -H "$J" -H "$AH" -d '{"name":"Аренда: не оплачено"}' | J_ 'j.view.name')" "Аренда: не оплачено"
chk "чужой не переименовать" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/views/$VID -H "$J" -H "$MH" -d '{"name":"Захват"}')" "403"
chk "чужой не удалить" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/views/$VID -H "$MH")" "403"
SHARED_ID=$(curl -s $API/views -H "$AH" | J_ 'j.views.find(v=>v.name==="Просроченные").id')
chk "общий не удалить бухгалтеру" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/views/$SHARED_ID -H "$AH")" "403"
chk "общий удаляет главбух" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/views/$SHARED_ID -H "$OH")" "200"
chk "свой удаляется" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/views/$VID -H "$AH")" "200"
chk "и пропал из списка" "$(curl -s $API/views -H "$AH" | J_ 'j.views.some(v=>v.id==='$VID')')" "false"
chk "несуществующий → 404" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/views/99999 -H "$AH")" "404"

echo "── Лимит"
for N in $(seq 1 25); do curl -s -o /dev/null -X POST $API/views -H "$J" -H "$MH" -d "{\"name\":\"Ф$N\",\"query\":{\"approval\":\"draft\",\"search\":\"$N\"}}"; done
chk "лимит 20 соблюдён" "$(curl -s $API/views -H "$MH" | J_ 'j.views.filter(v=>v.mine).length')" "20"
chk "21-й отклонён с внятной ошибкой" "$(curl -s -X POST $API/views -H "$J" -H "$MH" -d '{"name":"Лишний","query":{"posting":"posted"}}' | J_ 'j.error.includes("не больше 20")')" "true"

finish
