import {
  parseMoneyMinor,
  parseDateLoose,
  normalizeNumber,
  parseImportText,
  matchRows,
  type OurRow,
} from '../server/reconMatch';

let ok = 0;
let fail = 0;
const chk = (name: string, got: unknown, want: unknown) => {
  if (String(got) === String(want)) {
    console.log(`  ✓ ${name}`);
    ok++;
  } else {
    console.log(`  ✗ ${name} — ждали [${want}], получили [${got}]`);
    fail++;
  }
};

console.log('── Разбор сумм');
chk('обычное число', parseMoneyMinor('1250000.50'), 125000050);
chk('запятая как разделитель', parseMoneyMinor('1250000,50'), 125000050);
chk('пробелы-разряды', parseMoneyMinor('1 250 000,50'), 125000050);
chk('неразрывный пробел из Excel', parseMoneyMinor('1 250 000,50'), 125000050);
chk('символ тенге', parseMoneyMinor('348 000 ₸'), 34800000);
chk('целое без дробной', parseMoneyMinor('3400000'), 340000000);
chk('текст не сумма', parseMoneyMinor('Итого'), 'null');
chk('пустое не сумма', parseMoneyMinor('  '), 'null');
chk('три знака после запятой отвергнуты', parseMoneyMinor('10,123'), 'null');
// Разряды через запятую приходят из англоязычных выгрузок 1С и банков.
chk('разряды через запятую', parseMoneyMinor('3,400,000.00'), 340000000);
chk('разряды через запятую без копеек', parseMoneyMinor('3,400,000'), 340000000);
chk('разряды через точку', parseMoneyMinor('3.400.000,00'), 340000000);
chk('одна запятая — это копейки, а не разряды', parseMoneyMinor('3400,00'), 340000);
chk('неполная группа разрядов отвергнута', parseMoneyMinor('3,40,000.00'), 'null');
// Символ валюты режем только с краю: «5 т» — это тонны, а не пять тенге.
chk('«тг» после суммы срезано', parseMoneyMinor('348 000 тг'), 34800000);
chk('«тенге» после суммы срезано', parseMoneyMinor('348 000 тенге'), 34800000);
chk('тонны не сумма', parseMoneyMinor('5 т'), 'null');
chk('буква внутри числа не срезается', parseMoneyMinor('5т0'), 'null');

console.log('── Разбор дат');
chk('ISO как есть', parseDateLoose('2026-08-13'), '2026-08-13');
chk('русский формат', parseDateLoose('13.08.2026'), '2026-08-13');
chk('однозначные день и месяц', parseDateLoose('3.7.2026'), '2026-07-03');
chk('через слэш', parseDateLoose('13/08/2026'), '2026-08-13');
chk('двузначный год', parseDateLoose('13.08.26'), '2026-08-13');
chk('13-й месяц отвергнут', parseDateLoose('13.13.2026'), 'null');
chk('номер документа не дата', parseDateLoose('СЧ-4471'), 'null');

console.log('── Нормализация номера');
chk('регистр и дефис', normalizeNumber('СЧ-4471'), normalizeNumber('сч 4471'));
chk('решётка отброшена', normalizeNumber('№4471'), '4471');
chk('разные номера не сходятся', normalizeNumber('СЧ-4471') === normalizeNumber('СЧ-4472'), false);

console.log('── Разбор вставленного текста');
const tsv = [
  'Дата\tНомер\tНачислено\tОплачено',
  '01.06.2026\tСЧ-4471\t3 400 000,00\t0',
  '15.06.2026\tПП-341\t0\t3 400 000,00',
  'мусорная строка',
  '20.06.2026\tСЧ-9902\t189 500,00\t0',
].join('\n');
const parsedTsv = parseImportText(tsv);
chk('шапка пропущена, строки разобраны', parsedTsv.rows.length, 3);
chk('мусор отмечен, а не проглочен', parsedTsv.skipped.length, 1);
chk('дата разобрана', parsedTsv.rows[0].date, '2026-06-01');
chk('номер разобран', parsedTsv.rows[0].number, 'СЧ-4471');
chk('начисление в тиынах', parsedTsv.rows[0].accrued, 340000000);
chk('оплата отдельной колонкой', parsedTsv.rows[1].paid, 340000000);
chk('у оплаты начисления нет', parsedTsv.rows[1].accrued, 0);

const semicolon = '13.08.2026;СЧ-100;50 000,00';
chk('разделитель «;»', parseImportText(semicolon).rows.length, 1);
chk('одна колонка суммы → начисление', parseImportText(semicolon).rows[0].accrued, 5000000);
chk('и её направление задаётся', parseImportText(semicolon, 'paid').rows[0].paid, 5000000);

const spaces = '13.08.2026   СЧ-200   75 000,00';
chk('разделитель — двойной пробел', parseImportText(spaces).rows.length, 1);
chk('пустой текст даёт пустой разбор', parseImportText('').rows.length, 0);
chk('строка без суммы пропущена', parseImportText('13.08.2026\tСЧ-300\tнет данных').skipped.length, 1);

console.log('── Пустые колонки не сдвигают суммы');
// Excel оставляет пустую ячейку вместо нуля: колонка и есть смысл.
const gapPaid = parseImportText('15.06.2026;ПП-341;;3 400 000,00').rows[0];
chk('пустое «начислено» → сумма ушла в оплату', gapPaid.paid, 340000000);
chk('и начисления не появилось', gapPaid.accrued, 0);
const gapAccrued = parseImportText('01.06.2026;СЧ-4471;3 400 000,00;').rows[0];
chk('пустое «оплачено» → сумма осталась начислением', gapAccrued.accrued, 340000000);
chk('и оплаты не появилось', gapAccrued.paid, 0);

console.log('── Ни одна строка не исчезает молча');
// Сумма в неразбираемом формате плюс слово из шапки: раньше такая строка
// уходила в «шапку» и пропадала без следа.
const vanishing = parseImportText('15.06.2026\tПП-341\tоплачено частично\t3,400,000.00');
chk('строка не потерялась', vanishing.rows.length + vanishing.skipped.length, 1);
chk('и попала именно в пропущенные', vanishing.skipped.length, 1);
chk('с причиной про сумму', vanishing.skipped[0].reason.includes('сумму'), true);
// Настоящая шапка по-прежнему молча пропускается: это не данные.
chk('шапка не считается пропущенной строкой', parseImportText('Дата\tНомер\tСумма').skipped.length, 0);

console.log('── Итоговые строки не документы');
const withTotals = parseImportText(
  '01.06.2026;СЧ-4471;3 400 000,00;0\nИтого;;3 400 000,00;0\nСальдо на конец;;3 400 000,00;0'
);
chk('в документы попала только одна строка', withTotals.rows.length, 1);
chk('итоговые строки отмечены, а не проглочены', withTotals.skipped.length, 2);
chk('и с внятной причиной', withTotals.skipped[0].reason.includes('итоговая'), true);

console.log('── Несуществующие даты');
chk('31 февраля отвергнуто', parseDateLoose('31.02.2026'), 'null');
chk('30 февраля отвергнуто', parseDateLoose('30.02.2026'), 'null');
chk('29 февраля 2024 (високосный) принято', parseDateLoose('29.02.2024'), '2024-02-29');
chk('29 февраля 2026 отвергнуто', parseDateLoose('29.02.2026'), 'null');
chk('31 апреля отвергнуто', parseDateLoose('31.04.2026'), 'null');

console.log('── Сопоставление');
const ours: OurRow[] = [
  { id: 1, kind: 'document', date: '2026-06-01', title: 'Счёт СЧ-4471', amount: 340000000 },
  { id: 2, kind: 'payment', date: '2026-06-15', title: 'Оплата ПП-341', amount: 340000000 },
  { id: 3, kind: 'document', date: '2026-06-20', title: 'Счёт СЧ-9902', amount: 18950000 },
];

const exact = matchRows(ours, parseImportText(tsv).rows);
chk('все три строки нашли пару', exact.pairs.every((p) => p.ourId !== null), true);
chk('наших несопоставленных нет', exact.unmatchedOurs.length, 0);
chk('счёт лёг на счёт', exact.pairs.find((p) => p.their.number === 'СЧ-4471')?.ourId, 1);
chk('оплата легла на оплату', exact.pairs.find((p) => p.their.number === 'ПП-341')?.ourId, 2);

const different = matchRows(
  ours,
  parseImportText('01.06.2026\tСЧ-4471\t3 000 000,00').rows
);
chk('номер совпал при разной сумме', different.pairs[0].ourId, 1);
chk('сумма контрагента сохранена', different.pairs[0].theirAmount, 300000000);
chk('остальные наши остались без пары', different.unmatchedOurs.length, 2);

const tail = matchRows(ours, parseImportText('01.06.2026\t№4471\t3 400 000,00').rows);
chk('нашли по хвосту цифр номера', tail.pairs[0].ourId, 1);

const theirsOnly = matchRows(ours, parseImportText('05.06.2026\tНК-7781\t120 000,00').rows);
chk('чужая строка осталась без нашей пары', theirsOnly.pairs[0].ourId, 'null');
chk('и все наши не сопоставлены', theirsOnly.unmatchedOurs.length, 3);

// Платёж не должен «сойтись» со счётом на ту же сумму — это ложное совпадение.
const crossKind = matchRows(
  [{ id: 9, kind: 'payment', date: '2026-06-01', title: 'Оплата ПП-999', amount: 5000000 }],
  parseImportText('01.06.2026\tСЧ-777\t50 000,00').rows
);
chk('начисление не легло на оплату', crossKind.pairs[0].ourId, 'null');

// Одна наша строка не может закрыть две строки контрагента.
const doubled = matchRows(
  [{ id: 7, kind: 'document', date: '2026-06-01', title: 'Счёт СЧ-500', amount: 10000000 }],
  parseImportText('01.06.2026\tСЧ-500\t100 000,00\n02.06.2026\tСЧ-500\t100 000,00').rows
);
chk('вторая копия осталась без пары', doubled.pairs.filter((p) => p.ourId === null).length, 1);
chk('первая копия сопоставлена', doubled.pairs.filter((p) => p.ourId === 7).length, 1);

// Пустой или односимвольный номер не должен «подходить» ко всему подряд.
const emptyNumber = matchRows(ours, [
  { date: '2026-06-01', number: '—', accrued: 99, paid: 0, raw: '—' },
]);
chk('строка без внятного номера ни к чему не приклеилась', emptyNumber.pairs[0].ourId, 'null');

// Две одинаковые суммы в одну неделю: «сходится» по сумме и дате назначать нельзя.
const ambiguous = matchRows(
  [
    { id: 11, kind: 'document', date: '2026-06-01', title: 'Счёт АР-1', amount: 340000000 },
    { id: 12, kind: 'document', date: '2026-06-03', title: 'Счёт АР-2', amount: 340000000 },
  ],
  [{ date: '2026-06-02', number: 'Ф-777', accrued: 340000000, paid: 0, raw: 'Ф-777' }]
);
chk('неоднозначная пара по сумме и дате не назначается', ambiguous.pairs[0].ourId, 'null');
chk('обе наши строки остались несопоставленными', ambiguous.unmatchedOurs.length, 2);

// А когда кандидат ровно один — третий проход обязан сработать.
const single = matchRows(
  [{ id: 13, kind: 'document', date: '2026-06-01', title: 'Счёт АР-1', amount: 340000000 }],
  [{ date: '2026-06-02', number: 'Ф-777', accrued: 340000000, paid: 0, raw: 'Ф-777' }]
);
chk('единственный кандидат по сумме и дате сопоставлен', single.pairs[0].ourId, 13);

console.log(`\nИТОГО: успешно ${ok}, провалено ${fail}`);
process.exit(fail === 0 ? 0 : 1);
