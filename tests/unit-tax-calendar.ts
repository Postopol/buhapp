import { occurrencesBetween } from '../server/taxCalendar';

let ok = 0, fail = 0;
const chk = (name: string, got: unknown, want: unknown) => {
  if (String(got) === String(want)) { console.log(`  ✓ ${name}`); ok++; }
  else { console.log(`  ✗ ${name} — ждали [${want}], получили [${got}]`); fail++; }
};

const all = occurrencesBetween('2024-01-01', '2027-12-31');
const find = (code: string, period: string) => all.find(o => o.code === code && o.period === period);
const dow = (iso: string) => ['вс','пн','вт','ср','чт','пт','сб'][new Date(iso + 'T00:00:00').getDay()];

console.log('── Сроки по правилам НК РК');
chk('ИПН/соцплатежи за июль 2026 → 25 августа', find('pay-ipn-soc','2026-07')?.dueDate, '2026-08-25');
chk('ФНО 200.00 за I кв. 2026 → 15 мая', find('fno-200','2026-Q1')?.dueDate, '2026-05-15');
chk('ФНО 300.00 за II кв. 2026 → 2-й месяц после квартала', find('fno-300','2026-Q2')?.dueDate.slice(0,7), '2026-08');
chk('Уплата НДС за II кв. 2026 → 25 августа', find('pay-nds','2026-Q2')?.dueDate, '2026-08-25');
chk('ФНО 100.00 за 2025 → 31 марта 2026', find('fno-100','2025')?.dueDate, '2026-03-31');
chk('Уплата КПН за 2025 → 10 апреля 2026', find('pay-kpn','2025')?.dueDate, '2026-04-10');
chk('ФНО 100.00 за 2026 → 31 марта 2027', find('fno-100','2026')?.dueDate, '2027-03-31');

console.log('── Перенос с выходных');
const shifted = all.filter(o => o.shifted);
chk('ни один срок не падает на выходной', all.every(o => !['сб','вс'].includes(dow(o.dueDate))), true);
chk('перенос вообще срабатывает', shifted.length > 0, true);
const s = shifted[0];
console.log(`     пример: ${s.title} за ${s.periodLabel} → ${s.dueDate} (${dow(s.dueDate)})`);
chk('перенос всегда на понедельник', shifted.every(o => dow(o.dueDate) === 'пн'), true);

console.log('── Переход через год');
chk('ИПН за декабрь 2026 → январь 2027', find('pay-ipn-soc','2026-12')?.dueDate.slice(0,7), '2027-01');
chk('ФНО 200.00 за IV кв. 2026 → февраль 2027', find('fno-200','2026-Q4')?.dueDate.slice(0,7), '2027-02');

console.log('── Полнота и границы окна');
chk('12 ежемесячных сроков в 2026', all.filter(o => o.code==='pay-ipn-soc' && o.dueDate.startsWith('2026')).length, 12);
chk('4 квартальных ФНО 300.00 в 2026', all.filter(o => o.code==='fno-300' && o.dueDate.startsWith('2026')).length, 4);
const narrow = occurrencesBetween('2026-08-01','2026-08-31');
chk('узкое окно не выходит за границы', narrow.every(o => o.dueDate >= '2026-08-01' && o.dueDate <= '2026-08-31'), true);
chk('окно отсортировано по дате', narrow.every((o,i,a) => i===0 || a[i-1].dueDate <= o.dueDate), true);

console.log(`\nИТОГО: успешно ${ok}, провалено ${fail}`);
console.log('\nСроки августа 2026:');
for (const o of narrow) console.log(`  ${o.dueDate} (${dow(o.dueDate)})  ${o.title} — за ${o.periodLabel}${o.shifted ? '  [перенесён]' : ''}`);
