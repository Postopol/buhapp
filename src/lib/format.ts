/** Суммы везде хранятся и передаются в тиынах — здесь единственное место, где они превращаются в текст. */

const kzt = new Intl.NumberFormat('ru-KZ', {
  style: 'currency',
  currency: 'KZT',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const kztShort = new Intl.NumberFormat('ru-KZ', {
  style: 'currency',
  currency: 'KZT',
  maximumFractionDigits: 0,
});

const plain = new Intl.NumberFormat('ru-KZ', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(minor: number): string {
  return kzt.format(minor / 100);
}

/** Без тиын — для крупных сумм в плитках и итогах. */
export function formatMoneyShort(minor: number): string {
  return kztShort.format(minor / 100);
}

/** Только число, без символа валюты — для правых колонок таблицы. */
export function formatAmount(minor: number): string {
  return plain.format(minor / 100);
}

/** Пользовательский ввод «1 250 000,50» → тиыны.
 *
 *  Минус по умолчанию не проходит: в сумме документа или платежа он опечатка.
 *  Но там, где отрицательное значение осмысленно — сальдо контрагента при
 *  авансе или переплате, — его надо уметь внести, для таких полей allowNegative.
 *  Типографский минус принимаем наравне с дефисом: суммы копируют из письма или
 *  Excel, а оттуда он приходит именно в таком виде. */
export function parseMoney(input: string, options?: { allowNegative?: boolean }): number | null {
  const cleaned = input.replace(/\s| /g, '').replace(',', '.').replace(/^[−–—]/, '-');
  const shape = options?.allowNegative ? /^-?\d+(\.\d{0,2})?$/ : /^\d+(\.\d{0,2})?$/;
  if (!cleaned || !shape.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const MONTHS_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/** YYYY-MM-DD → «13 августа». Год добавляется, только если он не текущий.
 *  alwaysYear — для дат, у которых нет контекста периода вокруг: границы акта
 *  сверки и строки его оборотов бывают за прошлый год, а «15 июля» без года
 *  читается как за этот. */
export function formatDate(iso: string | null, alwaysYear = false): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const currentYear = new Date().getFullYear();
  const base = `${d} ${MONTHS[m - 1]}`;
  return !alwaysYear && y === currentYear ? base : `${base} ${y}`;
}

/** YYYY-MM-DD HH:MM:SS → «13 августа, 14:32». */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const time = iso.slice(11, 16);
  return time ? `${formatDate(iso)}, ${time}` : formatDate(iso);
}

/** YYYY-MM → «Август 2026». */
export function formatPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  return `${MONTHS_NOM[m - 1]} ${y}`;
}

export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * «через 3 дня» / «просрочен на 5 дней» — бухгалтеру важна не дата,
 * а сколько осталось.
 */
export function dueLabel(dueDate: string | null): { text: string; overdue: boolean } | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - now.getTime()) / 86_400_000);

  if (days < 0) return { text: `просрочен на ${plural(-days, 'день', 'дня', 'дней')}`, overdue: true };
  if (days === 0) return { text: 'срок сегодня', overdue: false };
  if (days === 1) return { text: 'срок завтра', overdue: false };
  return { text: `через ${plural(days, 'день', 'дня', 'дней')}`, overdue: false };
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
