/**
 * Разбор выписки контрагента и сопоставление её с нашими строками.
 *
 * Ни одной зависимости от БД и Express — только чистые функции, поэтому
 * модуль проверяется отдельным прогоном без сервера (как `taxCalendar.ts`).
 *
 * Задача не «распознать что угодно», а честно разобрать то, что бухгалтер
 * копирует из письма или Excel, и вслух сказать, чего не понял. Молча
 * проглоченная строка хуже, чем отвергнутая: расхождение уедет в акт.
 */

/** Одна распознанная строка контрагента. Суммы — в тиынах. */
export interface TheirRow {
  date: string | null;
  number: string;
  /** Сколько он нам начислил (наш долг вырос). */
  accrued: number;
  /** Сколько он от нас получил. */
  paid: number;
  /** Исходная строка — чтобы показать бухгалтеру, что именно разобрали. */
  raw: string;
}

export interface ParseResult {
  rows: TheirRow[];
  /** Строки, которые разобрать не вышло, с причиной. */
  skipped: { raw: string; reason: string }[];
}

/**
 * «1 250 000,50», «1250000.5», «1 250 000 ₸» → тиыны.
 * Неразрывный пробел из Excel встречается чаще обычного.
 */
export function parseMoneyMinor(input: string): number | null {
  const cleaned = input
    .replace(/[\s  ]/g, '')
    .replace(/[₸тг]/gi, '')
    .replace(',', '.');
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

/** «13.08.2026», «13/08/2026», «2026-08-13» → «2026-08-13». */
export function parseDateLoose(input: string): string | null {
  const s = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/.exec(s);
  if (dmy) {
    const year = Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return valid(year, Number(dmy[2]), Number(dmy[1]));
  }
  return null;

  function valid(y: number, m: number, d: number): string | null {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    // 31 февраля тоже проходит по диапазонам, а дальше даёт NaN при сравнении
    // дат и молча срывает сопоставление — проверяем календарь.
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}`;
  }
}

/**
 * Номер документа к сравнимому виду: «СЧ-4471», «сч 4471», «№4471» — один
 * и тот же документ, у контрагента он назван по-своему.
 */
export function normalizeNumber(input: string): string {
  return input.toLowerCase().replace(/[^0-9a-zа-яё]/gi, '');
}

/** Хвост цифр номера — последняя зацепка, когда буквенный префикс разный. */
function digitTail(input: string): string {
  const digits = input.replace(/\D/g, '');
  return digits.length >= 3 ? digits : '';
}

const HEADER_WORDS = /дата|номер|сумма|дебет|кредит|документ|начислен|оплач/i;

/** Подводящие строки выписки: сумма в них есть, но документом они не являются. */
const TOTAL_WORDS = /^\s*(итого|всего|сальдо|оборот|баланс)/i;

/**
 * Разбор вставленного текста. Разделитель определяется по первой содержательной
 * строке: таб (из Excel), «;» (из CSV) или «|».
 *
 * Ожидаемый порядок колонок: дата, номер, начислено, оплачено.
 * Если числовая колонка одна, её направление задаёт `defaultKind`.
 */
export function parseImportText(text: string, defaultKind: 'accrued' | 'paid' = 'accrued'): ParseResult {
  const rows: TheirRow[] = [];
  const skipped: { raw: string; reason: string }[] = [];

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows, skipped };

  const sep = pickSeparator(lines[0]);

  for (const raw of lines) {
    // Пустые ячейки НЕ выбрасываем: в выписке «дата;номер;;3400,00» пустая
    // колонка и есть смысл — сумма стоит в «оплачено». Отбросив её, мы бы
    // сдвинули колонки и записали оплату в начисление.
    const cells = raw.split(sep).map((c) => c.trim());
    const filled = cells.filter((c) => c !== '');
    if (filled.length < 2) {
      skipped.push({ raw, reason: 'меньше двух колонок' });
      continue;
    }
    const date = cells.map(parseDateLoose).find((d) => d !== null) ?? null;

    // Шапка таблицы: слова вместо чисел и никакой даты. Дата — верный признак
    // строки с данными: без этого условия «15.06.2026 ПП-341 оплачено частично
    // 3,400,000.00» (сумма в неразбираемом формате) уходила бы в шапку и
    // исчезала бесследно вместо честного «не нашли сумму».
    if (!date && !filled.some((c) => parseMoneyMinor(c) !== null) && HEADER_WORDS.test(raw)) {
      continue;
    }
    if (TOTAL_WORDS.test(raw)) {
      skipped.push({ raw, reason: 'итоговая строка, а не документ' });
      continue;
    }

    const moneyCells = cells
      .map((cell, index) => ({ value: parseMoneyMinor(cell), index }))
      .filter((c) => c.value !== null && !isDateCell(cells[c.index]));

    if (moneyCells.length === 0) {
      skipped.push({ raw, reason: 'не нашли сумму' });
      continue;
    }
    // Номер — первая непустая ячейка, которая не дата и не сумма.
    const number =
      cells.find(
        (c, i) => c !== '' && !isDateCell(c) && !moneyCells.some((m) => m.index === i)
      ) ?? '';
    if (!number) {
      skipped.push({ raw, reason: 'не нашли номер документа' });
      continue;
    }

    let accrued = 0;
    let paid = 0;
    if (moneyCells.length >= 2) {
      accrued = (moneyCells[0].value as number) || 0;
      paid = (moneyCells[1].value as number) || 0;
    } else {
      // Одна сумма. Соседняя пустая ячейка говорит, из какой она колонки:
      // «…;;3400,00» — оплата, «…;3400,00;» — начисление.
      const only = moneyCells[0].value as number;
      const at = moneyCells[0].index;
      const emptyBefore = at > 0 && cells[at - 1] === '' && !isDateCell(cells[at - 1]);
      const emptyAfter = at < cells.length - 1 && cells[at + 1] === '';
      if (emptyBefore && !emptyAfter) paid = only;
      else if (emptyAfter && !emptyBefore) accrued = only;
      else if (defaultKind === 'accrued') accrued = only;
      else paid = only;
    }
    if (accrued === 0 && paid === 0) {
      skipped.push({ raw, reason: 'нулевая сумма' });
      continue;
    }

    rows.push({ date, number, accrued, paid, raw });
  }

  return { rows, skipped };

  function isDateCell(cell: string): boolean {
    return parseDateLoose(cell) !== null;
  }
}

function pickSeparator(line: string): string | RegExp {
  if (line.includes('\t')) return '\t';
  if (line.includes(';')) return ';';
  if (line.includes('|')) return '|';
  return /\s{2,}/;
}

// ── Сопоставление ───────────────────────────────────────────────────────────

export interface OurRow {
  id: number;
  kind: 'document' | 'payment';
  date: string;
  title: string;
  amount: number;
}

export interface MatchPair {
  /** id нашей строки; null — строка есть только у контрагента. */
  ourId: number | null;
  their: TheirRow;
  theirAmount: number;
}

export interface MatchResult {
  pairs: MatchPair[];
  /** Наши строки, к которым пары не нашлось. */
  unmatchedOurs: number[];
}

/**
 * Три прохода, каждая наша строка занимается не больше одного раза:
 *   1) совпал номер и сумма — самый надёжный случай;
 *   2) совпал номер (сумма разошлась) либо совпал хвост цифр номера;
 *   3) совпала сумма и дата рядом — когда номер у контрагента свой.
 * Начисления сопоставляются с начислениями, оплаты с оплатами: платёж,
 * подставленный под счёт, дал бы ложное «сходится».
 */
export function matchRows(ours: OurRow[], theirs: TheirRow[], dateToleranceDays = 5): MatchResult {
  const taken = new Set<number>();
  const pairs: MatchPair[] = [];

  const theirKind = (row: TheirRow) => (row.paid > 0 ? 'payment' : 'document');
  const theirAmountOf = (row: TheirRow) => (row.paid > 0 ? row.paid : row.accrued);

  const candidates = (row: TheirRow) =>
    ours.filter((o) => !taken.has(o.id) && o.kind === theirKind(row));

  const claim = (row: TheirRow, ourId: number | null) => {
    if (ourId !== null) taken.add(ourId);
    pairs.push({ ourId, their: row, theirAmount: theirAmountOf(row) });
  };

  // Номер короче двух знаков ни о чём не говорит: пустой ключ через
  // includes() совпал бы с любой строкой и дал ложное «сходится».
  const keyOf = (row: TheirRow) => {
    const key = normalizeNumber(row.number);
    return key.length >= 2 ? key : '';
  };

  const passes: ((row: TheirRow) => OurRow | undefined)[] = [
    (row) => {
      const key = keyOf(row);
      if (!key) return undefined;
      return candidates(row).find(
        (o) => normalizeNumber(o.title).includes(key) && o.amount === theirAmountOf(row)
      );
    },
    (row) => {
      const key = keyOf(row);
      const tail = digitTail(row.number);
      if (!key && !tail) return undefined;
      return candidates(row).find(
        (o) => (key !== '' && normalizeNumber(o.title).includes(key)) || (tail !== '' && digitTail(o.title) === tail)
      );
    },
    (row) => {
      if (!row.date) return undefined;
      // Последняя зацепка — сумма и близкая дата, без номера. Берём её
      // только когда кандидат ровно один: две одинаковые суммы за неделю
      // (типичная аренда) иначе дали бы «сходится» по чужому документу.
      const fits = candidates(row).filter(
        (o) => o.amount === theirAmountOf(row) && daysBetween(o.date, row.date!) <= dateToleranceDays
      );
      return fits.length === 1 ? fits[0] : undefined;
    },
  ];

  // Проходы идут по всем строкам целиком: сначала все точные совпадения,
  // и только потом приблизительные — иначе первая же строка растащит пары.
  const rest = [...theirs];
  for (const pass of passes) {
    for (let i = rest.length - 1; i >= 0; i--) {
      const found = pass(rest[i]);
      if (found) {
        claim(rest[i], found.id);
        rest.splice(i, 1);
      }
    }
  }
  for (const row of rest) claim(row, null);

  // Порядок пар не зависит от того, на каком проходе они нашлись.
  pairs.sort((a, b) => (a.their.raw < b.their.raw ? -1 : a.their.raw > b.their.raw ? 1 : 0));

  return {
    pairs,
    unmatchedOurs: ours.filter((o) => !taken.has(o.id)).map((o) => o.id),
  };
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}
