import { Router } from 'express';
import { db, nowTimestamp, today, logAudit } from '../db';
import { requireAuth, requireRole } from '../auth';
import { occurrencesBetween, shiftDate, type TaxOccurrence } from '../taxCalendar';
import { TAX_RULES, type Section } from '../../shared/domain';

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

/** Состояние хранится только для тронутых сроков — остальные считаются несданными. */
function statesFor(codes: string[]): Map<string, StateRow> {
  if (codes.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT e.code, e.period, e.done, e.done_at, e.amount_minor, e.note,
              u.name AS done_by_name, r.name AS responsible_name
       FROM tax_events e
       LEFT JOIN users u ON u.id = e.done_by
       LEFT JOIN users r ON r.id = e.responsible_user_id`
    )
    .all() as StateRow[];
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

const CODES = new Set(TAX_RULES.map((r) => r.code));
const PERIOD_RE = /^\d{4}(-(\d{2}|Q[1-4]))?$/;

taxesRouter.get('/', (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
  if (!CODES.has(code) || !PERIOD_RE.test(period)) {
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

  const rule = TAX_RULES.find((r) => r.code === code)!;
  res.json({ event: { code, period, done: next === 1, title: rule.title } });
});

taxesRouter.post('/:code/:period/details', requireRole('accountant', 'chief_accountant'), (req, res) => {
  const { code, period } = req.params;
  if (!CODES.has(code) || !PERIOD_RE.test(period)) {
    res.status(400).json({ error: 'Неизвестный срок' });
    return;
  }
  const { amount, note } = req.body as { amount?: number | null; note?: string };

  if (amount !== undefined && amount !== null) {
    const value = Number(amount);
    if (!Number.isInteger(value) || value < 0) {
      res.status(400).json({ error: 'Сумма должна быть неотрицательным числом' });
      return;
    }
  }

  const user = req.user!;
  db.prepare(
    `INSERT INTO tax_events (code, period, amount_minor, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(code, period) DO UPDATE SET
       amount_minor = COALESCE(excluded.amount_minor, tax_events.amount_minor),
       note = CASE WHEN excluded.note = '' THEN tax_events.note ELSE excluded.note END`
  ).run(code, period, amount ?? null, (note ?? '').trim());

  logAudit({
    entityType: 'tax',
    entityId: `${code}:${period}`,
    action: 'details',
    userId: user.id,
    userName: user.name,
    details: { amount: amount ?? undefined, note: note?.trim() || undefined },
  });

  res.json({ ok: true });
});
