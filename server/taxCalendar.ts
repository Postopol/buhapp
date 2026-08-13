import { TAX_RULES, type TaxRule } from '../shared/domain';

/**
 * Разворачивание правил налогового календаря в конкретные сроки.
 * Чистые функции без БД — состояние «сдано» живёт отдельно, в `tax_events`.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Срок, выпавший на выходной, переносится на ближайший рабочий день.
 * Праздники не учитываем — их календарь меняется каждый год и требует справочника.
 */
function shiftOffWeekend(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day);
  const weekday = d.getDay();
  if (weekday === 6) d.setDate(d.getDate() + 2); // суббота → понедельник
  else if (weekday === 0) d.setDate(d.getDate() + 1); // воскресенье → понедельник
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export interface TaxOccurrence {
  code: string;
  title: string;
  kind: TaxRule['kind'];
  frequency: TaxRule['frequency'];
  section: TaxRule['section'];
  hint: string;
  /** Отчётный период: `2026-07`, `2026-Q2` или `2026`. */
  period: string;
  periodLabel: string;
  dueDate: string;
  /** Срок сдвинут с выходного на понедельник. */
  shifted: boolean;
}

const QUARTER_LABELS = ['I квартал', 'II квартал', 'III квартал', 'IV квартал'];
const MONTH_LABELS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

interface ReportingPeriod {
  period: string;
  label: string;
  year: number;
  /** Последний месяц отчётного периода, 1–12. */
  endMonth: number;
}

function reportingPeriods(rule: TaxRule, yearFrom: number, yearTo: number): ReportingPeriod[] {
  const out: ReportingPeriod[] = [];
  for (let year = yearFrom; year <= yearTo; year++) {
    if (rule.frequency === 'monthly') {
      for (let m = 1; m <= 12; m++) {
        out.push({ period: `${year}-${pad(m)}`, label: `${MONTH_LABELS[m - 1]} ${year}`, year, endMonth: m });
      }
    } else if (rule.frequency === 'quarterly') {
      for (let q = 1; q <= 4; q++) {
        out.push({ period: `${year}-Q${q}`, label: `${QUARTER_LABELS[q - 1]} ${year}`, year, endMonth: q * 3 });
      }
    } else {
      out.push({ period: `${year}`, label: `${year} год`, year, endMonth: 12 });
    }
  }
  return out;
}

function dueDateOf(rule: TaxRule, p: ReportingPeriod): { date: string; shifted: boolean } {
  // Смещение может перевалить за декабрь — отсюда нормализация года.
  const absMonth = p.endMonth + rule.monthOffset;
  const year = p.year + Math.floor((absMonth - 1) / 12);
  const month = ((absMonth - 1) % 12) + 1;
  const day = Math.min(rule.dueDay, daysInMonth(year, month));

  const raw = iso(year, month, day);
  const adjusted = shiftOffWeekend(year, month, day);
  return { date: adjusted, shifted: adjusted !== raw };
}

/** Все сроки, попадающие в окно [from, to] включительно. */
export function occurrencesBetween(from: string, to: string): TaxOccurrence[] {
  const yearFrom = Number(from.slice(0, 4)) - 2;
  const yearTo = Number(to.slice(0, 4)) + 1;

  const out: TaxOccurrence[] = [];
  for (const rule of TAX_RULES) {
    for (const p of reportingPeriods(rule, yearFrom, yearTo)) {
      const { date, shifted } = dueDateOf(rule, p);
      if (date < from || date > to) continue;
      out.push({
        code: rule.code,
        title: rule.title,
        kind: rule.kind,
        frequency: rule.frequency,
        section: rule.section,
        hint: rule.hint,
        period: p.period,
        periodLabel: p.label,
        dueDate: date,
        shifted,
      });
    }
  }
  out.sort((a, b) => (a.dueDate === b.dueDate ? a.title.localeCompare(b.title) : a.dueDate.localeCompare(b.dueDate)));
  return out;
}

export function shiftDate(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + days);
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
