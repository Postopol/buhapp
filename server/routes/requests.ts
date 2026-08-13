import { Router } from 'express';
import { db, nowTimestamp, generateRequestId } from '../db';
import { requireAuth, requireRole } from '../auth';
import {
  FLOW_STEPS,
  STATUS_ORDER,
  STATUS_ACTIONS,
  EXPENSE_ITEMS,
  ROLE_LABELS,
  type RequestStatus,
  type Role,
} from '../constants';

export const requestsRouter = Router();

requestsRouter.use(requireAuth);

interface RequestRow {
  id: string;
  initiator: string;
  expense_item: string;
  amount: number;
  status: RequestStatus;
  created_at: string;
}

interface TimelineEntryRow {
  step_index: number;
  performer: string;
  performed_at: string;
}

function mapRequest(row: RequestRow) {
  return {
    id: row.id,
    initiator: row.initiator,
    expenseItem: row.expense_item,
    amount: row.amount,
    status: row.status,
    date: row.created_at.split(' ')[0],
  };
}

function buildTimeline(requestId: string) {
  const entries = db.prepare(
    'SELECT step_index, performer, performed_at FROM timeline_entries WHERE request_id = ? ORDER BY step_index'
  ).all(requestId) as TimelineEntryRow[];
  const entryMap = new Map(entries.map((e) => [e.step_index, e]));
  return FLOW_STEPS.map((step, i) => {
    const entry = entryMap.get(i);
    return {
      id: i + 1,
      action: step.action,
      user: entry?.performer ?? step.defaultUser,
      date: entry?.performed_at ?? 'Ожидается',
      status: entry ? ('completed' as const) : ('pending' as const),
    };
  });
}

requestsRouter.get('/', (req, res) => {
  const { search, status } = req.query as { search?: string; status?: string };
  let query = 'SELECT id, initiator, expense_item, amount, status, created_at FROM requests';
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (status && status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (search && search.trim()) {
    conditions.push('(LOWER(id) LIKE ? OR LOWER(initiator) LIKE ? OR LOWER(expense_item) LIKE ?)');
    const q = `%${search.trim().toLowerCase()}%`;
    params.push(q, q, q);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...params) as RequestRow[];
  res.json({ requests: rows.map(mapRequest) });
});

requestsRouter.get('/:id', (req, res) => {
  const row = db.prepare(
    'SELECT id, initiator, expense_item, amount, status, created_at FROM requests WHERE id = ?'
  ).get(req.params.id) as RequestRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Заявка не найдена' });
    return;
  }
  res.json({ request: { ...mapRequest(row), timeline: buildTimeline(row.id) } });
});

requestsRouter.post('/', requireRole('accountant'), (req, res) => {
  const { initiator, expenseItem, amount } = req.body as {
    initiator?: string;
    expenseItem?: string;
    amount?: number;
  };
  if (!initiator || !initiator.trim()) {
    res.status(400).json({ error: 'Укажите инициатора' });
    return;
  }
  if (!expenseItem || !EXPENSE_ITEMS.includes(expenseItem)) {
    res.status(400).json({ error: 'Недопустимая статья расходов' });
    return;
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0 || !Number.isInteger(amt)) {
    res.status(400).json({ error: 'Сумма должна быть положительным целым числом' });
    return;
  }
  const ts = nowTimestamp();
  const performer = `${req.user!.name} (${ROLE_LABELS[req.user!.role as Role]})`;
  const tx = db.transaction(() => {
    const id = generateRequestId();
    db.prepare(
      'INSERT INTO requests (id, initiator, expense_item, amount, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, initiator.trim(), expenseItem, amt, 'draft', ts, req.user!.id);
    db.prepare(
      'INSERT INTO timeline_entries (request_id, step_index, performer, performed_at) VALUES (?, ?, ?, ?)'
    ).run(id, 0, performer, ts);
    return id;
  });
  const id = tx();
  const row = db.prepare(
    'SELECT id, initiator, expense_item, amount, status, created_at FROM requests WHERE id = ?'
  ).get(id) as RequestRow;
  res.status(201).json({ request: { ...mapRequest(row), timeline: buildTimeline(id) } });
});

requestsRouter.post('/:id/advance', (req, res) => {
  const row = db.prepare(
    'SELECT id, initiator, expense_item, amount, status, created_at FROM requests WHERE id = ?'
  ).get(req.params.id) as RequestRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Заявка не найдена' });
    return;
  }
  const action = STATUS_ACTIONS[row.status];
  if (!action) {
    res.status(400).json({ error: 'Заявка уже завершена' });
    return;
  }
  if (!action.roles.includes(req.user!.role)) {
    res.status(403).json({ error: 'Недостаточно прав для этого действия' });
    return;
  }
  const nextStatus = action.nextStatus;
  const ts = nowTimestamp();
  const stepIndex = STATUS_ORDER.indexOf(nextStatus);
  const performer = nextStatus === 'done' ? 'Система' : `${req.user!.name} (${ROLE_LABELS[req.user!.role as Role]})`;
  const tx = db.transaction(() => {
    db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(nextStatus, row.id);
    db.prepare(
      'INSERT INTO timeline_entries (request_id, step_index, performer, performed_at) VALUES (?, ?, ?, ?)'
    ).run(row.id, stepIndex, performer, ts);
  });
  tx();
  const updated = db.prepare(
    'SELECT id, initiator, expense_item, amount, status, created_at FROM requests WHERE id = ?'
  ).get(row.id) as RequestRow;
  res.json({ request: { ...mapRequest(updated), timeline: buildTimeline(row.id) } });
});
