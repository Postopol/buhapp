. "$(dirname "$0")/lib.sh"

# Столько документов заводит seed в server/db.ts. Меняется вместе с ним.
SEED_DOCS=16

echo "── Авторизация"
chk "неверный пароль → 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/auth/login -H "$J" -d '{"email":"anna@company.kz","password":"wrong"}')" "401"
A=$(login anna@company.kz); O=$(login olga@company.kz); I=$(login igor@company.kz)
AH="Authorization: Bearer $A"; OH="Authorization: Bearer $O"; IH="Authorization: Bearer $I"
chk "вход бухгалтера выдал токен" "$([ -n "$A" ] && echo yes || echo no)" "yes"
chk "роль главбуха" "$(curl -s $API/auth/me -H "$OH" | J_ 'j.user.role')" "chief_accountant"
chk "без токена → 401" "$(curl -s -o /dev/null -w '%{http_code}' $API/documents)" "401"

echo "── Реестр документов"
chk "всего документов из seed" "$(curl -s $API/documents -H "$AH" | J_ 'j.total')" "$SEED_DOCS"
chk "инициатор видит только свои" \
  "$(curl -s $API/documents -H "$IH" | J_ 'j.documents.every(d=>d.createdByName==="Петров Игорь")')" "true"
chk "инициатор видит меньше бухгалтера" \
  "$(curl -s $API/documents -H "$IH" | J_ "j.total < $SEED_DOCS")" "true"
chk "фильтр «нет оригинала»" \
  "$(curl -s "$API/documents?original=none" -H "$AH" | J_ 'j.documents.every(d=>d.originalStatus==="none")')" "true"
chk "фильтр «частично оплачен»" \
  "$(curl -s "$API/documents?payment=partial" -H "$AH" | J_ 'j.documents.every(d=>d.paid>0&&d.paid<d.amount)')" "true"
chk "фильтр «просрочено» непустой" "$(curl -s "$API/documents?overdue=true" -H "$AH" | J_ 'j.total>0')" "true"
chk "просроченные не оплачены полностью" \
  "$(curl -s "$API/documents?overdue=true" -H "$AH" | J_ 'j.documents.every(d=>d.paid<d.amount&&d.approvalStatus!=="rejected")')" "true"
chk "поиск по БИН" \
  "$(curl -s "$API/documents?search=991140000876" -H "$AH" | J_ 'j.documents.every(d=>d.counterpartyBin==="991140000876")')" "true"

echo "── Поиск по кириллице (LOWER в SQLite её не знает — считаем своей функцией)"
chk "номер документа как есть" \
  "$(curl -s --get --data-urlencode "search=СЧ-4471" $API/documents -H "$AH" | J_ 'j.documents[0]&&j.documents[0].number')" "СЧ-4471"
chk "тот же номер строчными" \
  "$(curl -s --get --data-urlencode "search=сч-4471" $API/documents -H "$AH" | J_ 'j.documents[0]&&j.documents[0].number')" "СЧ-4471"
chk "по названию контрагента" \
  "$(curl -s --get --data-urlencode "search=астана" $API/documents -H "$AH" | J_ 'j.documents.length>0&&j.documents.some(d=>/Астана/.test(d.counterpartyName||""))')" "true"
chk "по назначению платежа" \
  "$(curl -s --get --data-urlencode "search=АРЕНДА" $API/documents -H "$AH" | J_ 'j.documents.length>0&&j.documents.every(d=>/аренд/i.test(d.purpose))')" "true"
chk "поиск по контрагентам тоже кириллический" \
  "$(curl -s --get --data-urlencode "search=глобал" $API/counterparties -H "$AH" | J_ 'j.counterparties.length')" "1"
chk "итоги = сумме по выборке" \
  "$(curl -s "$API/documents?limit=200" -H "$AH" | J_ 'j.totals.amount===j.documents.reduce((s,d)=>s+d.amount,0)')" "true"
chk "неоплаченный остаток = начислено − оплачено" \
  "$(curl -s "$API/documents?limit=200" -H "$AH" | J_ 'j.totals.unpaid===j.totals.amount-j.totals.paid')" "true"
chk "пагинация limit" "$(curl -s "$API/documents?limit=5" -H "$AH" | J_ 'j.documents.length')" "5"
chk "смещение сдвигает выборку" \
  "$(curl -s "$API/documents?limit=5&offset=5" -H "$AH" | J_ 'j.offset')" "5"
chk "порядок детерминирован" \
  "$(curl -s "$API/documents?limit=200" -H "$AH" | J_ 'JSON.stringify(j.documents.map(d=>d.id))')" \
  "$(curl -s "$API/documents?limit=200" -H "$AH" | J_ 'JSON.stringify(j.documents.map(d=>d.id))')"
chk "НДС 12/112 на 3,4 млн ₸" \
  "$(curl -s --get --data-urlencode "search=СЧ-4471" $API/documents -H "$AH" | J_ 'j.documents[0].vat')" "36428571"

echo "── Выгрузка CSV"
CSV=$(curl -s "$API/documents/export.csv" -H "$AH")
chk "CSV: строк = документы + шапка" "$(printf '%s' "$CSV" | wc -l | tr -d ' ')" "$SEED_DOCS"
chk "CSV: BOM для Excel" "$(printf '%s' "$CSV" | head -c 3 | od -An -tx1 | tr -d ' \n')" "efbbbf"
chk "CSV: разделитель «;»" "$(printf '%s' "$CSV" | head -1 | tr -cd ';' | wc -c | tr -d ' ')" "15"
chk "CSV инициатора сужен" \
  "$(curl -s "$API/documents/export.csv" -H "$IH" | wc -l | tr -d ' ')" \
  "$(curl -s $API/documents -H "$IH" | J_ 'j.total')"

finish
