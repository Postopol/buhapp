import { KZ_HOLIDAYS, TAX_RULES, type TaxRule } from '../shared/domain';

/**
 * Разворачивание правил налогового календаря в конкретные сроки.
 * Чистые функции без БД — состояние «сдано» живёт отдельно, в `tax_events`.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

const isoOf = (d: Date) => iso(d.getFullYear(), d.getMonth() + 1, d.getDate());

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

const HOLIDAYS = new Set(KZ_HOLIDAYS);

/**
 * Срок, выпавший на нерабочий день, по НК РК переносится на следующий РАБОЧИЙ,
 * а не просто на понедельник: праздники РК идут блоками (Наурыз 21–23,
 * новогодние 1–2 января), и с субботы можно уехать сразу на среду.
 *
 * Ограничитель на 14 шагов — страховка от опечатки в `KZ_HOLIDAYS`
 * (например, целого месяца, забитого праздниками): лучше вернуть заведомо
 * неверную дату, чем повесить весь налоговый календарь на бесконечном цикле.
 */
export function nextWorkingDay(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  for (let guard = 0; guard < 14; guard++) {
    const weekday = d.getDay();
    if (weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(isoOf(d))) break;
    d.setDate(d.getDate() + 1);
  }
  return isoOf(d);
}

export interface TaxOccurrence {
  code: string;
  title: string;
  kind: TaxRule['kind'];
  frequency: TaxRule['frequency'];
  section: TaxRule['section'];
  hint: string;
  /** Отчётный период: `2026-07`, `2026-Q2`, `2026-H1` или `2026`. */
  period: string;
  periodLabel: string;
  dueDate: string;
  /** Срок сдвинут с выходного или праздника на следующий рабочий день. */
  shifted: boolean;
}

const QUARTER_LABELS = ['I квартал', 'II квартал', 'III квартал', 'IV квартал'];
const HALF_LABELS = ['I полугодие', 'II полугодие'];
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
    } else if (rule.frequency === 'semiannual') {
      // Полугодие — период упрощёнки (ФНО 910.00): кончается июнем и декабрём.
      for (let h = 1; h <= 2; h++) {
        out.push({ period: `${year}-H${h}`, label: `${HALF_LABELS[h - 1]} ${year}`, year, endMonth: h * 6 });
      }
    } else {
      out.push({ period: `${year}`, label: `${year} год`, year, endMonth: 12 });
    }
  }
  return out;
}

function dueDateOf(rule: TaxRule, p: ReportingPeriod): { date: string; shifted: boolean } {
  // Смещение может перевалить за декабрь, а у авансовых платежей оно
  // отрицательное и может уйти за январь — отсюда нормализация года и
  // «положительный» остаток: обычный `%` на отрицательных даёт месяц 0.
  const absMonth = p.endMonth + rule.monthOffset;
  const year = p.year + Math.floor((absMonth - 1) / 12);
  const month = ((((absMonth - 1) % 12) + 12) % 12) + 1;
  const day = Math.min(rule.dueDay, daysInMonth(year, month));

  const raw = iso(year, month, day);
  const adjusted = nextWorkingDay(raw);
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
