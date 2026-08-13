import { Router } from 'express';
import { db, nowTimestamp, currentPeriod, logAudit, ensurePeriod } from '../db';
import { requireAuth, requireRole } from '../auth';
import { PERIOD_STATUS_LABELS, type PeriodStatus } from '../../shared/domain';

export const periodsRouter = Router();

periodsRouter.use(requireAuth);
// Закрытие месяца — работа бухгалтерии, инициатору здесь делать нечего.
periodsRouter.use(requireRole('accountant', 'chief_accountant', 'director'));

const PERIOD_RE = /^\d{4}-\d{2}$/;

interface Blocker {
  key: string;
  title: string;
  hint: string;
  count: number;
  amount: number;
  /** Параметры, с которыми откроется реестр. */
  filter: Record<string, string>;
}

/**
 * Блокировки считаются на лету из документов — их нельзя «отметить сделанным»,
 * они исчезают только когда исчезает причина.
 */
function blockersOf(period: string): Blocker[] {
  const measure = (where: string) =>
    db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(d.amount_minor), 0) AS amount
         FROM documents d WHERE d.period = ? AND (${where})`
      )
      .get(period) as { count: number; amount: number };

  const unfinished = measure(`d.approval_status IN ('draft','review','returned')`);
  const originals = measure(`d.original_status = 'none' AND d.approval_status <> 'rejected'`);
  const notPosted = measure(`d.approval_status = 'approved' AND d.posting_status = 'not_posted'`);

  const unallocated = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(p.amount_minor - COALESCE(a.allocated, 0)), 0) AS amount
       FROM payments p
       LEFT JOIN (
         SELECT payment_id, SUM(amount_minor) AS allocated FROM document_payments GROUP BY payment_id
       ) a ON a.payment_id = p.id
       WHERE substr(p.payment_date, 1, 7) = ? AND p.amount_minor > COALESCE(a.allocated, 0)`
    )
    .get(period) as { count: number; amount: number };

  return [
    {
      key: 'unfinished',
      title: 'Документы не прошли согласование',
      hint: 'Черновики, документы на проверке и возвращённые на доработку',
      count: unfinished.count,
      amount: unfinished.amount,
      filter: { period, approval: 'review' },
    },
    {
      key: 'originals',
      title: 'Нет оригиналов',
      hint: 'Без бумаги документ нельзя принять к учёту',
      count: originals.count,
      amount: originals.amount,
      filter: { period, original: 'none' },
    },
    {
      key: 'not_posted',
      title: 'Согласованы, но не проведены',
      hint: 'Документы не переданы в учётную систему',
      count: notPosted.count,
      amount: notPosted.amount,
      filter: { period, approval: 'approved', posting: 'not_posted' },
    },
    {
      key: 'unallocated',
      title: 'Платежи не разнесены полностью',
      hint: 'Деньги ушли, но не привязаны к документам',
      count: unallocated.count,
      amount: unallocated.amount,
      filter: { period },
    },
  ];
}

interface TaskRow {
  id: number;
  sort: number;
  title: string;
  hint: string;
  responsible_user_id: number | null;
  responsible_name: string | null;
  done: number;
  done_at: string | null;
  done_by_name: string | null;
  note: string;
}

function tasksOf(period: string) {
  const rows = db
    .prepare(
      `SELECT t.id, t.sort, t.title, t.hint, t.responsible_user_id, t.done, t.done_at, t.note,
              r.name AS responsible_name, b.name AS done_by_name
       FROM closing_tasks t
       LEFT JOIN users r ON r.id = t.responsible_user_id
       LEFT JOIN users b ON b.id = t.done_by
       WHERE t.period = ? ORDER BY t.sort`
    )
    .all(period) as TaskRow[];
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    hint: t.hint,
    responsibleId: t.responsible_user_id,
    responsibleName: t.responsible_name,
    done: t.done === 1,
    doneAt: t.done_at,
    doneByName: t.done_by_name,
    note: t.note,
  }));
}

function periodPayload(period: string) {
  ensurePeriod(period);
  const row = db.prepare('SELECT period, status, closed_at, closed_by FROM periods WHERE period = ?').get(period) as {
    period: string;
    status: PeriodStatus;
    closed_at: string | null;
    closed_by: number | null;
  };
  const closedBy = row.closed_by
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(row.closed_by) as { name: string } | undefined)
    : undefined;

  const stats = db
    .prepare(
      `SELECT COUNT(*) AS documents,
              COALESCE(SUM(d.amount_minor), 0) AS amount,
              COALESCE(SUM(d.vat_minor), 0) AS vat
       FROM documents d WHERE d.period = ?`
    )
    .get(period) as { documents: number; amount: number; vat: number };

  const blockers = blockersOf(period);
  const tasks = tasksOf(period);

  return {
    period: row.period,
    status: row.status,
    statusLabel: PERIOD_STATUS_LABELS[row.status],
    closedAt: row.closed_at,
    closedByName: closedBy?.name ?? null,
    documents: stats.documents,
    amount: stats.amount,
    vat: stats.vat,
    blockers,
    blockingCount: blockers.reduce((sum, b) => sum + b.count, 0),
    tasks,
    tasksDone: tasks.filter((t) => t.done).length,
    tasksTotal: tasks.length,
    canClose: blockers.every((b) => b.count === 0) && tasks.every((t) => t.done),
  };
}

periodsRouter.get('/', (_req, res) => {
  ensurePeriod(currentPeriod());
  const rows = db
    .prepare(
      `SELECT p.period, p.status, p.closed_at,
              (SELECT COUNT(*) FROM documents d WHERE d.period = p.period) AS documents,
              (SELECT COUNT(*) FROM closing_tasks t WHERE t.period = p.period AND t.done = 1) AS tasks_done,
              (SELECT COUNT(*) FROM closing_tasks t WHERE t.period = p.period) AS tasks_total
       FROM periods p ORDER BY p.period DESC`
    )
    .all() as {
    period: string;
    status: PeriodStatus;
    closed_at: string | null;
    documents: number;
    tasks_done: number;
    tasks_total: number;
  }[];

  res.json({
    periods: rows.map((r) => ({
      period: r.period,
      status: r.status,
      closedAt: r.closed_at,
      documents: r.documents,
      tasksDone: r.tasks_done,
      tasksTotal: r.tasks_total,
    })),
    current: currentPeriod(),
  });
});

periodsRouter.get('/:period', (req, res) => {
  const { period } = req.params;
  if (!PERIOD_RE.test(period)) {
    res.status(400).json({ error: 'Некорректный период' });
    return;
  }
  res.json({ period: periodPayload(period) });
});

periodsRouter.post('/:period/tasks/:taskId(\\d+)/toggle', requireRole('accountant', 'chief_accountant'), (req, res) => {
  const { period } = req.params;
  const taskId = Number(req.params.taskId);
  if (!PERIOD_RE.test(period)) {
    res.status(400).json({ error: 'Некорректный период' });
    return;
  }
  const task = db
    .prepare('SELECT id, title, done FROM closing_tasks WHERE id = ? AND period = ?')
    .get(taskId, period) as { id: number; title: string; done: number } | undefined;
  if (!task) {
    res.status(404).json({ error: 'Пункт не найден' });
    return;
  }
  const periodRow = db.prepare('SELECT status FROM periods WHERE period = ?').get(period) as { status: string };
  if (periodRow.status === 'closed') {
    res.status(409).json({ error: 'Период закрыт — чек-лист менять нельзя' });
    return;
  }

  const user = req.user!;
  const next = task.done === 1 ? 0 : 1;
  const { note } = req.body as { note?: string };

  db.prepare(
    `UPDATE closing_tasks SET done = ?, done_at = ?, done_by = ?, note = COALESCE(?, note) WHERE id = ?`
  ).run(next, next ? nowTimestamp() : null, next ? user.id : null, note ?? null, taskId);

  logAudit({
    entityType: 'period',
    entityId: period,
    action: next ? 'task_done' : 'task_undone',
    userId: user.id,
    userName: user.name,
    details: { task: task.title },
  });

  res.json({ period: periodPayload(period) });
});

periodsRouter.post('/:period/close', requireRole('chief_accountant'), (req, res) => {
  const { period } = req.params;
  if (!PERIOD_RE.test(period)) {
    res.status(400).json({ error: 'Некорректный период' });
    return;
  }
  const payload = periodPayload(period);
  if (payload.status === 'closed') {
    res.status(409).json({ error: 'Период уже закрыт' });
    return;
  }

  // Закрыть месяц с открытыми блокировками нельзя — иначе смысл теряется.
  const blocking = payload.blockers.filter((b) => b.count > 0);
  if (blocking.length > 0) {
    res.status(409).json({
      error: `Период нельзя закрыть: ${blocking.map((b) => `${b.title.toLowerCase()} (${b.count})`).join(', ')}`,
      blockers: blocking,
    });
    return;
  }
  const openTasks = payload.tasks.filter((t) => !t.done);
  if (openTasks.length > 0) {
    res.status(409).json({
      error: `Не выполнены пункты чек-листа: ${openTasks.map((t) => t.title.toLowerCase()).join('; ')}`,
    });
    return;
  }

  const user = req.user!;
  db.prepare(`UPDATE periods SET status = 'closed', closed_at = ?, closed_by = ? WHERE period = ?`).run(
    nowTimestamp(),
    user.id,
    period
  );
  logAudit({
    entityType: 'period',
    entityId: period,
    action: 'closed',
    userId: user.id,
    userName: user.name,
    details: { documents: payload.documents, amount: payload.amount },
  });

  res.json({ period: periodPayload(period) });
});

periodsRouter.post('/:period/reopen', requireRole('chief_accountant'), (req, res) => {
  const { period } = req.params;
  if (!PERIOD_RE.test(period)) {
    res.status(400).json({ error: 'Некорректный период' });
    return;
  }
  const row = db.prepare('SELECT status FROM periods WHERE period = ?').get(period) as
    | { status: string }
    | undefined;
  if (!row || row.status !== 'closed') {
    res.status(409).json({ error: 'Период не закрыт' });
    return;
  }
  const { reason } = req.body as { reason?: string };
  if (!reason || !reason.trim()) {
    res.status(400).json({ error: 'Укажите причину повторного открытия' });
    return;
  }

  const user = req.user!;
  db.prepare(`UPDATE periods SET status = 'open', closed_at = NULL, closed_by = NULL WHERE period = ?`).run(period);
  logAudit({
    entityType: 'period',
    entityId: period,
    action: 'reopened',
    userId: user.id,
    userName: user.name,
    details: { reason: reason.trim() },
  });

  res.json({ period: periodPayload(period) });
});
