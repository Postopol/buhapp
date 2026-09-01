import { Router } from 'express';
import { db, nowTimestamp, today, logAudit } from '../db';
import { requireAuth, requireRole } from '../auth';
import { occurrencesBetween, shiftDate, type TaxOccurrence } from '../taxCalendar';
import {
  DATE_RE,
  TAX_PERIOD_RE,
  TAX_RULES,
  type Section,
  type TaxFrequency,
  type TaxRule,
} from '../../shared/domain';

export const taxesRouter = Router();

taxesRouter.use(requireAuth);
taxesRouter.use(requireRole('accountant', 'chief_accountant', 'director'));

interface StateRow {
  code: string;
  period: string;
  done: number;
  done_at: string | null;
  done_by_name: string | null;
  amount_minor: number | null;
  note: string;
  responsible_name: string | null;
}

/**
 * Состояние хранится только для тронутых сроков — остальные считаются несданными.
 * Выбираем строго по кодам из окна: без WHERE запрос тащил всю таблицу
 * tax_events целиком при каждом открытии календаря.
 */
function statesFor(codes: string[]): Map<string, StateRow> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT e.code, e.period, e.done, e.done_at, e.amount_minor, e.note,
              u.name AS done_by_name, r.name AS responsible_name
       FROM tax_events e
       LEFT JOIN users u ON u.id = e.done_by
       LEFT JOIN users r ON r.id = e.responsible_user_id
       WHERE e.code IN (${unique.map(() => '?').join(', ')})`
    )
    .all(...unique) as StateRow[];
  return new Map(rows.map((r) => [`${r.code}:${r.period}`, r]));
}

/** Ответственный по умолчанию — бухгалтер участка, к которому относится налог. */
const sectionOwner = (section: Section): string | null => {
  const row = db
    .prepare(`SELECT name FROM users WHERE section = ? AND role = 'accountant' ORDER BY id LIMIT 1`)
    .get(section) as { name: string } | undefined;
  if (row) return row.name;
  const chief = db
    .prepare(`SELECT name FROM users WHERE role = 'chief_accountant' ORDER BY id LIMIT 1`)
    .get() as { name: string } | undefined;
  return chief?.name ?? null;
};

function decorate(occurrences: TaxOccurrence[]) {
  const states = statesFor(occurrences.map((o) => o.code));
  const now = today();
  const ownerCache = new Map<Section, string | null>();

  return occurrences.map((o) => {
    const state = states.get(`${o.code}:${o.period}`);
    const done = state?.done === 1;
    if (!ownerCache.has(o.section)) ownerCache.set(o.section, sectionOwner(o.section));

    const daysLeft = Math.round(
      (new Date(`${o.dueDate}T00:00:00`).getTime() - new Date(`${now}T00:00:00`).getTime()) / 86_400_000
    );

    return {
      ...o,
      done,
      doneAt: state?.done_at ?? null,
      doneByName: state?.done_by_name ?? null,
      amount: state?.amount_minor ?? null,
      note: state?.note ?? '',
      responsibleName: state?.responsible_name ?? ownerCache.get(o.section) ?? null,
      daysLeft,
      overdue: !done && o.dueDate < now,
    };
  });
}

/**
 * Какой формы бывает период у каждой частоты. Проверяется ВТОРЫМ шагом, после
 * общей маски TAX_PERIOD_RE, — она уже отсекла «2026-77» и «2026-Q9», здесь
 * остаётся только выбрать семейство, поэтому маски такие короткие.
 *
 * Одной общей маски мало: период «2026-Q2» у месячного налога проходит её
 * насквозь, но такого срока календарь не порождает никогда. Строка в tax_events
 * завелась бы и навсегда осталась невидимым мусором — её уже ни к чему не привязать.
 */
const PERIOD_SHAPE: Record<TaxFrequency, RegExp> = {
  monthly: /^\d{4}-\d{2}$/,
  quarterly: /^\d{4}-Q[1-4]$/,
  semiannual: /^\d{4}-H[12]$/,
  yearly: /^\d{4}$/,
};

/** Срок существует, только если код известен и период соответствует частоте правила. */
function ruleFor(code: string, period: string): TaxRule | undefined {
  if (!TAX_PERIOD_RE.test(period)) return undefined;
  const rule = TAX_RULES.find((r) => r.code === code);
  if (!rule) return undefined;
  return PERIOD_SHAPE[rule.frequency].test(period) ? rule : undefined;
}

taxesRouter.get('/', (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  const now = today();
  // По умолчанию — прошедший квартал и полгода вперёд.
  const start = from && DATE_RE.test(from) ? from : shiftDate(now, -90);
  const end = to && DATE_RE.test(to) ? to : shiftDate(now, 180);

  if (start > end) {
    res.status(400).json({ error: 'Начало окна позже конца' });
    return;
  }

  const events = decorate(occurrencesBetween(start, end));
  const overdue = events.filter((e) => e.overdue);
  const soon = events.filter((e) => !e.done && !e.overdue && e.daysLeft <= 14);

  res.json({
    events,
    from: start,
    to: end,
    today: now,
    summary: {
      total: events.length,
      done: events.filter((e) => e.done).length,
      overdue: overdue.length,
      soon: soon.length,
    },
  });
});

/** Ближайшие сроки для рабочего места: просрочка плюс две недели вперёд. */
export function upcomingDeadlines(limit = 5) {
  const now = today();
  const events = decorate(occurrencesBetween(shiftDate(now, -60), shiftDate(now, 14)));
  return events
    .filter((e) => !e.done)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, limit);
}

taxesRouter.post('/:code/:period/toggle', requireRole('accountant', 'chief_accountant'), (req, res) => {
  const { code, period } = req.params;
  const rule = ruleFor(code, period);
  if (!rule) {
    res.status(400).json({ error: 'Неизвестный срок' });
    return;
  }
  const user = req.user!;
  const existing = db.prepare('SELECT id, done FROM tax_events WHERE code = ? AND period = ?').get(code, period) as
    | { id: number; done: number }
    | undefined;
  const next = existing?.done === 1 ? 0 : 1;
  const ts = nowTimestamp();

  if (existing) {
    db.prepare('UPDATE tax_events SET done = ?, done_at = ?, done_by = ? WHERE id = ?').run(
      next,
      next ? ts : null,
      next ? user.id : null,
      existing.id
    );
  } else {
    db.prepare(
      'INSERT INTO tax_events (code, period, done, done_at, done_by) VALUES (?, ?, ?, ?, ?)'
    ).run(code, period, next, next ? ts : null, next ? user.id : null);
  }

  logAudit({
    entityType: 'tax',
    entityId: `${code}:${period}`,
    action: next ? 'done' : 'undone',
    userId: user.id,
    userName: user.name,
  });

  res.json({ event: { code, period, done: next === 1, title: rule.title } });
});

taxesRouter.post('/:code/:period/details', requireRole('accountant', 'chief_accountant'), (req, res) => {
  const { code, period } = req.params;
  if (!ruleFor(code, period)) {
    res.status(400).json({ error: 'Неизвестный срок' });
    return;
  }

  /**
   * «Поле не передали» и «передали пусто» — разные намерения, и раньше апсерт
   * их не различал: COALESCE трактовал явный null как «не менять», поэтому
   * ошибочно введённую сумму нельзя было убрать никаким способом.
   */
  const body = (req.body ?? {}) as { amount?: number | string | null; note?: string | null };
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const hasAmount = has('amount');
  const hasNote = has('note');
  if (!hasAmount && !hasNote) {
    res.status(400).json({ error: 'Нечего сохранять' });
    return;
  }

  let amount: number | null = null;
  if (hasAmount && body.amount !== null && body.amount !== '') {
    const value = Number(body.amount);
    if (!Number.isInteger(value) || value < 0) {
      res.status(400).json({ error: 'Сумма должна быть неотрицательным числом' });
      return;
    }
    amount = value;
  }
  const note = hasNote ? (body.note ?? '').trim() : '';

  const user = req.user!;
  const existing = db
    .prepare('SELECT amount_minor, note FROM tax_events WHERE code = ? AND period = ?')
    .get(code, period) as { amount_minor: number | null; note: string } | undefined;

  const nextAmount = hasAmount ? amount : existing?.amount_minor ?? null;
  const nextNote = hasNote ? note : existing?.note ?? '';

  db.prepare(
    `INSERT INTO tax_events (code, period, amount_minor, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(code, period) DO UPDATE SET
       amount_minor = excluded.amount_minor,
       note = excluded.note`
  ).run(code, period, nextAmount, nextNote);

  logAudit({
    entityType: 'tax',
    entityId: `${code}:${period}`,
    action: 'details',
    userId: user.id,
    userName: user.name,
    // Логируем именно переданные поля: null здесь означает «сумму очистили»,
    // и по журналу должно быть видно, что это осознанное действие.
    details: {
      ...(hasAmount ? { amount: nextAmount } : {}),
      ...(hasNote ? { note: nextNote } : {}),
    },
  });

  res.json({ ok: true });
});
