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

/** Пробелы-разряды: обычный, неразрывный и узкий неразрывный из Excel. */
const SPACES = /[\s  ]/g;

/** Разряды через запятую («3,400,000.00») и через точку («3.400.000,00»). */
const GROUPED_BY_COMMA = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const GROUPED_BY_DOT = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/;

/** Обозначения валюты, которые бухгалтер дописывает к сумме. */
const CURRENCY_TAIL = /(₸|тенге|тнг|тг|kzt)$/i;

/**
 * Разделители к единому виду «1234.56».
 *
 * Запятая двулика: «3400,00» — это копейки, «3,400,000.00» — разряды.
 * Различаем по числу и длине групп: одна запятая — дробная часть, несколько —
 * разряды, и тогда каждая группа обязана быть ровно трёхзначной. «10,123» при
 * таком правиле остаётся мусором намеренно: копеек в три знака не бывает, а
 * гадать между «10 123» и «10,123» нельзя — промах в тысячу раз дороже отказа.
 */
function normalizeSeparators(s: string): string | null {
  const commas = s.split(',').length - 1;
  const dots = s.split('.').length - 1;
  if (commas > 0 && dots > 0) {
    // Оба знака сразу: дробный — тот, что правее, второй обязан быть разрядным.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      return GROUPED_BY_DOT.test(s) ? s.split('.').join('').replace(',', '.') : null;
    }
    return GROUPED_BY_COMMA.test(s) ? s.split(',').join('') : null;
  }
  if (commas > 1) return GROUPED_BY_COMMA.test(s) ? s.split(',').join('') : null;
  if (dots > 1) return GROUPED_BY_DOT.test(s) ? s.split('.').join('') : null;
  return s.replace(',', '.');
}

/**
 * «1 250 000,50», «1250000.5», «3,400,000.00», «1 250 000 ₸» → тиыны.
 * Неразрывный пробел из Excel встречается чаще обычного.
 */
export function parseMoneyMinor(input: string): number | null {
  const cleaned = input
    .replace(SPACES, '')
    // Валюту режем только с краю. Раньше «т» и «г» вырезались из любой позиции,
    // и «5 т» (тонны из колонки количества) разбиралось как сумму 5 тенге,
    // а первая же денежная ячейка становится начислением.
    .replace(/^₸/, '')
    .replace(CURRENCY_TAIL, '');
  if (!cleaned) return null;
  const normalized = normalizeSeparators(cleaned);
  if (normalized === null) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(parseFloat(normalized) * 100);
}

/**
 * Похоже ли содержимое ячейки на деньги, а не на количество или порядковый
 * номер: копейки, разряды, символ валюты. Ноль тоже деньги — им в выписке
 * отмечают пустую колонку («…;0;3 400 000,00»).
 *
 * Голое «5» деньгами не считаем: в выписке рядом с суммой стоит колонка
 * количества, и она молча становилась начислением, а настоящая сумма
 * съезжала в оплату — счёт превращался в платёж.
 */
function looksMonetary(cell: string, value: number): boolean {
  if (value === 0) return true;
  const compact = cell.replace(SPACES, '');
  if (CURRENCY_TAIL.test(compact) || compact.startsWith('₸')) return true;
  // Копейки («3400,00»), разряды через знак («3,400,000») или через пробел.
  return /[.,]\d{1,2}$/.test(compact) || /\d[.,]\d{3}/.test(compact) || /\d[\s  ]\d{3}/.test(cell);
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
    // Но хвостовые пустые ячейки смысла не несут: «…;3400,00;» — это след
    // завершающего разделителя, а не колонка. Оставив их, мы получали «пусто
    // и до, и после», обе ветки направления молчали, и оплата уходила в
    // начисление значением по умолчанию.
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    const filled = cells.filter((c) => c !== '');
    if (filled.length < 2) {
      skipped.push({ raw, reason: 'меньше двух колонок' });
      continue;
    }
    const date = cells.map(parseDateLoose).find((d) => d !== null) ?? null;

    // Шапка таблицы: слова вместо чисел и никакой даты. Цифр в шапке не бывает
    // вовсе — а вот в строке данных без даты они есть всегда (номер документа).
    // Без этой оговорки «ПП-341 [таб] оплачено [таб] <сумма в неизвестном виде>»
    // считалась шапкой и исчезала бесследно вместо честного «не нашли сумму».
    if (
      !date &&
      !filled.some((c) => parseMoneyMinor(c) !== null) &&
      !filled.some((c) => /\d/.test(c)) &&
      HEADER_WORDS.test(raw)
    ) {
      continue;
    }
    if (TOTAL_WORDS.test(raw)) {
      skipped.push({ raw, reason: 'итоговая строка, а не документ' });
      continue;
    }

    const numeric: { cell: string; index: number; value: number }[] = [];
    cells.forEach((cell, index) => {
      if (cell === '' || isDateCell(cell)) return;
      const value = parseMoneyMinor(cell);
      if (value !== null) numeric.push({ cell, index, value });
    });
    // Из разбираемых чисел суммами считаем те, что и выглядят суммами. Голые
    // числа берём, только если денежных на вид ячеек в строке нет вообще —
    // иначе колонка количества («…;СЧ-441;5;1 250 000,00») подменяла начисление.
    const monetary = numeric.filter((c) => looksMonetary(c.cell, c.value));
    const moneyCells = monetary.length > 0 ? monetary : numeric;

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
      accrued = moneyCells[0].value;
      paid = moneyCells[1].value;
    } else {
      // Одна сумма. Соседняя пустая ячейка говорит, из какой она колонки:
      // «…;;3400,00» — оплата, «…;3400,00;» — начисление.
      const only = moneyCells[0].value;
      const at = moneyCells[0].index;
      const emptyBefore = at > 0 && cells[at - 1] === '';
      const emptyAfter = at < cells.length - 1 && cells[at + 1] === '';
      if (emptyBefore && !emptyAfter) paid = only;
      else if (emptyAfter && !emptyBefore) accrued = only;
      else if (defaultKind === 'accrued') accrued = only;
      else paid = only;
    }
    // Сторно выписки (возврат, аннулированный акт) разобрать мало — его нужно
    // ещё правильно провести, а знака в акте сверки нет: строка с минусом
    // уехала бы в начисления с нулевой суммой и дала случайный диагноз.
    // Честнее вернуть её бухгалтеру.
    if (accrued < 0 || paid < 0) {
      skipped.push({ raw, reason: 'отрицательная сумма (сторно) — заведите строку вручную' });
      continue;
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
 * Совпадение номера, а не куска номера. Через `includes()` номер контрагента
 * «12» подходил к нашему «Счёт СЧ-4412»: требуем, чтобы цифры ключа не
 * оказались обрывком более длинного числа — с той стороны, где у ключа цифра,
 * соседний символ цифрой быть не должен.
 */
function numberMatches(ourTitle: string, key: string): boolean {
  const hay = normalizeNumber(ourTitle);
  const digit = (c: string) => c !== '' && c >= '0' && c <= '9';
  let at = hay.indexOf(key);
  while (at >= 0) {
    const before = at > 0 ? hay[at - 1] : '';
    const after = at + key.length < hay.length ? hay[at + key.length] : '';
    const startOk = !digit(key[0]) || !digit(before);
    const endOk = !digit(key[key.length - 1]) || !digit(after);
    if (startOk && endOk) return true;
    at = hay.indexOf(key, at + 1);
  }
  return false;
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

  // Свёрнутая строка оборотки — «акт на 100 000, оплачено 100 000» одной
  // строкой — несёт сразу два факта. Вид строки определяется по оплате, и
  // начисленная половина пропадала из акта без предупреждения. Расщепляем:
  // каждая половина ищет свою пару, и расхождение по любой из них видно.
  const rows: TheirRow[] = [];
  for (const row of theirs) {
    if (row.accrued > 0 && row.paid > 0) rows.push({ ...row, paid: 0 }, { ...row, accrued: 0 });
    else rows.push(row);
  }

  // Вид строки — по самому факту оплаты, а не по её знаку: сторно
  // parseImportText отклоняет, но заведённая руками отрицательная оплата
  // иначе уехала бы в начисления с нулевой суммой.
  const theirKind = (row: TheirRow) => (row.paid !== 0 ? 'payment' : 'document');
  const theirAmountOf = (row: TheirRow) => (row.paid !== 0 ? row.paid : row.accrued);

  const candidates = (row: TheirRow) =>
    ours.filter((o) => !taken.has(o.id) && o.kind === theirKind(row));

  const claim = (row: TheirRow, ourId: number | null) => {
    if (ourId !== null) taken.add(ourId);
    pairs.push({ ourId, their: row, theirAmount: theirAmountOf(row) });
  };

  // Короткий номер ни о чём не говорит: «12» встречается внутри половины наших
  // номеров, и такой ключ давал ложное «сходится» по чужому документу.
  const keyOf = (row: TheirRow) => {
    const key = normalizeNumber(row.number);
    return key.length >= 3 ? key : '';
  };

  const passes: ((row: TheirRow) => OurRow | undefined)[] = [
    (row) => {
      const key = keyOf(row);
      if (!key) return undefined;
      // Совпали и номер, и сумма: даже если таких строк у нас две, они
      // неразличимы, и любая из них одинаково верна.
      return candidates(row).find(
        (o) => numberMatches(o.title, key) && o.amount === theirAmountOf(row)
      );
    },
    (row) => {
      const key = keyOf(row);
      const tail = digitTail(row.number);
      if (!key && !tail) return undefined;
      // Здесь сумма уже разошлась, и пара держится на одном номере. Кандидат
      // обязан быть единственным: выбрав первого из двух подходящих, мы бы
      // приписали расхождение произвольно выбранному документу.
      const fits = candidates(row).filter(
        (o) => (key !== '' && numberMatches(o.title, key)) || (tail !== '' && digitTail(o.title) === tail)
      );
      return fits.length === 1 ? fits[0] : undefined;
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
  const rest = [...rows];
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
