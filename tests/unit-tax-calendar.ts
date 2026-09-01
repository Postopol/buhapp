import { occurrencesBetween, nextWorkingDay } from '../server/taxCalendar';
import { KZ_HOLIDAYS, vatRateOn, vatFromGross } from '../shared/domain';

let ok = 0, fail = 0;
const chk = (name: string, got: unknown, want: unknown) => {
  if (String(got) === String(want)) { console.log(`  ✓ ${name}`); ok++; }
  else { console.log(`  ✗ ${name} — ждали [${want}], получили [${got}]`); fail++; }
};

const all = occurrencesBetween('2024-01-01', '2027-12-31');
const find = (code: string, period: string) => all.find(o => o.code === code && o.period === period);
const dow = (iso: string) => ['вс','пн','вт','ср','чт','пт','сб'][new Date(iso + 'T00:00:00').getDay()];
const holidays = new Set(KZ_HOLIDAYS);

console.log('── Сроки по правилам НК РК');
chk('ИПН/соцплатежи за июль 2026 → 25 августа', find('pay-ipn-soc','2026-07')?.dueDate, '2026-08-25');
chk('ФНО 200.00 за I кв. 2026 → 15 мая', find('fno-200','2026-Q1')?.dueDate, '2026-05-15');
chk('ФНО 300.00 за II кв. 2026 → 2-й месяц после квартала', find('fno-300','2026-Q2')?.dueDate.slice(0,7), '2026-08');
chk('Уплата НДС за II кв. 2026 → 25 августа', find('pay-nds','2026-Q2')?.dueDate, '2026-08-25');
chk('ФНО 100.00 за 2025 → 31 марта 2026', find('fno-100','2025')?.dueDate, '2026-03-31');
chk('Уплата КПН за 2025 → 10 апреля 2026', find('pay-kpn','2025')?.dueDate, '2026-04-10');
chk('ФНО 100.00 за 2026 → 31 марта 2027', find('fno-100','2026')?.dueDate, '2027-03-31');

console.log('── Налоги на объекты: 700.00, авансы, транспорт');
chk('ФНО 700.00 за 2025 → 31 марта 2026', find('fno-700','2025')?.dueDate, '2026-03-31');
chk('уплата по 700.00 за 2025 → 10 апреля 2026', find('pay-700','2025')?.dueDate, '2026-04-10');
chk('аванс по имуществу I кв. 2026 → 25 февраля', find('pay-property-advance','2026-Q1')?.dueDate, '2026-02-25');
chk('аванс по имуществу II кв. 2026 → 25 мая', find('pay-property-advance','2026-Q2')?.dueDate, '2026-05-25');
chk('аванс по имуществу III кв. 2026 → 25 августа', find('pay-property-advance','2026-Q3')?.dueDate, '2026-08-25');
chk('аванс по имуществу IV кв. 2026 → 25 ноября', find('pay-property-advance','2026-Q4')?.dueDate, '2026-11-25');
chk('4 аванса по имуществу в 2026', all.filter(o => o.code==='pay-property-advance' && o.dueDate.startsWith('2026')).length, 4);
// Отрицательное смещение: аванс платится внутри своего же года, а не в следующем.
chk('аванс за 2026 не уезжает в 2027', all.filter(o => o.code==='pay-property-advance' && o.period.startsWith('2026')).every(o => o.dueDate.startsWith('2026')), true);
// 5 июля 2026 — воскресенье, а 6 июля — День столицы, поэтому срок уезжает на вторник.
chk('транспорт за 2026 → 7 июля (5-е вс, 6-е праздник)', find('pay-transport','2026')?.dueDate, '2026-07-07');
chk('транспорт за 2027 → 5 июля, будний понедельник', find('pay-transport','2027')?.dueDate, '2027-07-05');
chk('транспорт за 2027 не переносился', find('pay-transport','2027')?.shifted, false);

console.log('── Полугодовая периодичность (ФНО 910.00)');
const half2026 = all.filter(o => o.code==='fno-910' && o.period.startsWith('2026'));
chk('два полугодия в 2026 году', half2026.length, 2);
chk('период I полугодия', half2026[0]?.period, '2026-H1');
chk('период II полугодия', half2026[1]?.period, '2026-H2');
chk('метка I полугодия', half2026[0]?.periodLabel, 'I полугодие 2026');
chk('метка II полугодия', half2026[1]?.periodLabel, 'II полугодие 2026');
// 15 августа 2026 — суббота, отсюда перенос на понедельник.
chk('910.00 за I полугодие 2026 → 17 августа', find('fno-910','2026-H1')?.dueDate, '2026-08-17');
chk('910.00 за II полугодие 2026 → 15 февраля 2027', find('fno-910','2026-H2')?.dueDate, '2027-02-15');
chk('частота проброшена в срок', find('fno-910','2026-H1')?.frequency, 'semiannual');

console.log('── Перенос с выходных и праздников');
const shifted = all.filter(o => o.shifted);
chk('ни один срок не падает на выходной', all.every(o => !['сб','вс'].includes(dow(o.dueDate))), true);
chk('ни один срок не падает на праздник', all.every(o => !holidays.has(o.dueDate)), true);
chk('перенос вообще срабатывает', shifted.length > 0, true);
const s = shifted[0];
console.log(`     пример: ${s.title} за ${s.periodLabel} → ${s.dueDate} (${dow(s.dueDate)})`);
chk('перенос всегда на рабочий день', shifted.every(o => !['сб','вс'].includes(dow(o.dueDate)) && !holidays.has(o.dueDate)), true);
// 25 октября 2026 — воскресенье И День Республики; понедельник 26-го уже рабочий.
chk('ИПН за сентябрь 2026: 25 октября (вс, праздник) → 26 октября', find('pay-ipn-soc','2026-09')?.dueDate, '2026-10-26');
// А в 2027 году День Республики сам выпал на понедельник — тут праздник и двигает срок.
chk('ИПН за сентябрь 2027: 25 октября (пн, праздник) → 26 октября', find('pay-ipn-soc','2027-09')?.dueDate, '2027-10-26');
chk('срок 2027-10-26 — вторник', dow(find('pay-ipn-soc','2027-09')!.dueDate), 'вт');

console.log('── nextWorkingDay напрямую');
chk('будний день не двигается', nextWorkingDay('2026-08-25'), '2026-08-25');
chk('Наурыз: 21 марта 2026 (сб) → вторник 24-го', nextWorkingDay('2026-03-21'), '2026-03-24');
chk('Наурыз: 22 марта 2026 (вс) → вторник 24-го', nextWorkingDay('2026-03-22'), '2026-03-24');
chk('Наурыз: 23 марта 2026 (пн, праздник) → 24-е', nextWorkingDay('2026-03-23'), '2026-03-24');
chk('Наурыз 2027: 21 марта (вс) → среда 24-го', nextWorkingDay('2027-03-21'), '2027-03-24');
chk('Наурыз 2025: 21 марта (пт, праздник) → понедельник 24-го', nextWorkingDay('2025-03-21'), '2025-03-24');
chk('новогодний блок: 1 января 2026 → 5 января', nextWorkingDay('2026-01-01'), '2026-01-05');
chk('День Независимости 2026 (ср) → 17 декабря', nextWorkingDay('2026-12-16'), '2026-12-17');
chk('День Республики 2027 (пн) → 26 октября', nextWorkingDay('2027-10-25'), '2027-10-26');

console.log('── Переход через год');
chk('ИПН за декабрь 2026 → январь 2027', find('pay-ipn-soc','2026-12')?.dueDate.slice(0,7), '2027-01');
chk('ФНО 200.00 за IV кв. 2026 → февраль 2027', find('fno-200','2026-Q4')?.dueDate.slice(0,7), '2027-02');

console.log('── Полнота и границы окна');
chk('12 ежемесячных сроков в 2026', all.filter(o => o.code==='pay-ipn-soc' && o.dueDate.startsWith('2026')).length, 12);
chk('4 квартальных ФНО 300.00 в 2026', all.filter(o => o.code==='fno-300' && o.dueDate.startsWith('2026')).length, 4);
const narrow = occurrencesBetween('2026-08-01','2026-08-31');
chk('узкое окно не выходит за границы', narrow.every(o => o.dueDate >= '2026-08-01' && o.dueDate <= '2026-08-31'), true);
chk('окно отсортировано по дате', narrow.every((o,i,a) => i===0 || a[i-1].dueDate <= o.dueDate), true);

console.log('── Ставка НДС по дате документа');
chk('до реформы — 12 %', vatRateOn('2025-12-31'), 0.12);
chk('с 1 января 2026 — 16 %', vatRateOn('2026-01-01'), 0.16);
chk('середина 2026 года — 16 %', vatRateOn('2026-06-30'), 0.16);
chk('давняя дата — самая старая ставка, не ноль', vatRateOn('1999-01-01'), 0.12);
chk('НДС из 1 120,00 ₸ по 12 % = 120,00 ₸', vatFromGross(112_000, '2025-12-31'), 12_000);
chk('НДС из 1 160,00 ₸ по 16 % = 160,00 ₸', vatFromGross(116_000, '2026-01-01'), 16_000);
chk('НДС из 1 000,00 ₸ по 12 %', vatFromGross(100_000, '2025-06-01'), 10_714);
chk('НДС из 1 000,00 ₸ по 16 %', vatFromGross(100_000, '2026-01-01'), 13_793);
chk('нулевая сумма даёт нулевой НДС', vatFromGross(0, '2026-05-05'), 0);
// Тот же счёт, выписанный по разные стороны 1 января, обязан дать разный НДС.
chk('ставка не «залипает» на дате документа', vatFromGross(100_000, '2025-12-31') !== vatFromGross(100_000, '2026-01-01'), true);

console.log(`\nИТОГО: успешно ${ok}, провалено ${fail}`);
console.log('\nСроки августа 2026:');
for (const o of narrow) console.log(`  ${o.dueDate} (${dow(o.dueDate)})  ${o.title} — за ${o.periodLabel}${o.shifted ? '  [перенесён]' : ''}`);

// Без этого провалившиеся проверки не влияли на код возврата и весь набор был декоративным.
process.exit(fail === 0 ? 0 : 1);
