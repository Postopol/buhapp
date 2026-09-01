import { Router } from 'express';
import { db, nowTimestamp, logAudit } from '../db';
import { requireAuth, requireRole } from '../auth';
import type { AuthUser } from '../auth';
import { countForFilters, type ListQuery } from './documents';
import { APPROVAL_LABELS } from '../../shared/domain';

export const viewsRouter = Router();

viewsRouter.use(requireAuth);

/** Сколько пресетов может завести один человек — чтобы панель не разрослась. */
const MAX_VIEWS_PER_USER = 20;

/** Что вообще можно сохранить в пресете. Всё остальное отбрасывается. */
const ALLOWED_KEYS = [
  'search', 'type', 'section', 'approval', 'original', 'payment',
  'posting', 'counterparty', 'period', 'overdue', 'mine', 'sort', 'dir',
] as const;

const APPROVAL_STATUSES = Object.keys(APPROVAL_LABELS);

/**
 * Фильтр по согласованию принимает список статусов через запятую — так плитка
 * закрытия месяца открывает реестр ровно с теми статусами, что посчитала.
 * Пресет обязан такой список пережить, но хранить мусор не должен: неизвестные
 * статусы отбрасываем, и если не осталось ни одного — выкидываем ключ целиком.
 */
function normalizeApproval(value: string): string {
  const picked = value.split(',').map((s) => s.trim());
  return [...new Set(picked)].filter((s) => APPROVAL_STATUSES.includes(s)).join(',');
}

function sanitizeQuery(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ALLOWED_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'all') continue;
    const clean = key === 'approval' ? normalizeApproval(trimmed) : trimmed.slice(0, 120);
    if (!clean) continue;
    out[key] = clean;
  }
  return out;
}

/**
 * Личный пресет — дело владельца, общий — дело роли: он висит на панели у всех,
 * поэтому им распоряжается любой главбух, а не только тот, кто его завёл.
 * Раньше и переименование, и удаление требовали совпадения user_id, и общий
 * фильтр ушедшего главбуха оставался несменяемым навсегда.
 */
function canManage(row: { user_id: number | null; shared: number }, user: AuthUser): boolean {
  if (row.shared === 1) return user.role === 'chief_accountant';
  return row.user_id === user.id;
}

interface ViewRow {
  id: number;
  user_id: number | null;
  name: string;
  query: string;
  shared: number;
  sort: number;
  owner_name: string | null;
}

const VIEW_SELECT = `
  SELECT v.id, v.user_id, v.name, v.query, v.shared, v.sort, u.name AS owner_name
  FROM saved_views v LEFT JOIN users u ON u.id = v.user_id
`;

function parseQuery(json: string): Record<string, string> {
  try {
    return sanitizeQuery(JSON.parse(json));
  } catch {
    return {};
  }
}

function mapView(row: ViewRow, user: AuthUser) {
  const query = parseQuery(row.query);
  const stats = countForFilters(query as ListQuery, user);
  return {
    id: row.id,
    name: row.name,
    query,
    shared: row.shared === 1,
    ownerName: row.owner_name,
    mine: row.user_id === user.id,
    count: stats.count,
    amount: stats.amount,
  };
}

viewsRouter.get('/', (req, res) => {
  const user = req.user!;
  // Свои пресеты плюс общие. Счётчики считаются в области видимости смотрящего:
  // у инициатора общий пресет покажет только его документы.
  const rows = db
    .prepare(`${VIEW_SELECT} WHERE v.user_id = ? OR v.shared = 1 ORDER BY v.shared DESC, v.sort, v.id`)
    .all(user.id) as ViewRow[];

  res.json({ views: rows.map((row) => mapView(row, user)) });
});

viewsRouter.post('/', (req, res) => {
  const user = req.user!;
  const { name, query, shared } = req.body as { name?: string; query?: unknown; shared?: boolean };

  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Укажите название фильтра' });
    return;
  }
  const clean = sanitizeQuery(query);
  if (Object.keys(clean).length === 0) {
    res.status(400).json({ error: 'Пустой фильтр сохранять незачем' });
    return;
  }

  const own = db.prepare('SELECT COUNT(*) AS c FROM saved_views WHERE user_id = ?').get(user.id) as { c: number };
  if (own.c >= MAX_VIEWS_PER_USER) {
    res.status(409).json({ error: `Можно хранить не больше ${MAX_VIEWS_PER_USER} фильтров — удалите ненужные` });
    return;
  }

  // Общие пресеты заводит только главбух: панель у всех одна.
  const isShared = shared === true && user.role === 'chief_accountant';
  const trimmed = name.trim().slice(0, 60);

  const duplicate = db
    .prepare('SELECT id FROM saved_views WHERE user_id = ? AND name = ?')
    .get(user.id, trimmed);
  if (duplicate) {
    res.status(409).json({ error: 'Фильтр с таким названием уже есть' });
    return;
  }

  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM saved_views WHERE user_id = ?').get(user.id) as {
    m: number;
  };
  const info = db
    .prepare('INSERT INTO saved_views (user_id, name, query, shared, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, trimmed, JSON.stringify(clean), isShared ? 1 : 0, maxSort.m + 1, nowTimestamp());

  const id = Number(info.lastInsertRowid);
  logAudit({
    entityType: 'view',
    entityId: id,
    action: 'created',
    userId: user.id,
    userName: user.name,
    details: { name: trimmed, shared: isShared, query: clean },
  });

  const row = db.prepare(`${VIEW_SELECT} WHERE v.id = ?`).get(id) as ViewRow;
  res.status(201).json({ view: mapView(row, user) });
});

viewsRouter.patch('/:id(\\d+)', (req, res) => {
  const user = req.user!;
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, user_id, name, shared FROM saved_views WHERE id = ?').get(id) as
    | { id: number; user_id: number | null; name: string; shared: number }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Фильтр не найден' });
    return;
  }
  if (!canManage(row, user)) {
    res.status(403).json({
      error: row.shared === 1 ? 'Общий фильтр меняет только главный бухгалтер' : 'Изменить можно только свой фильтр',
    });
    return;
  }

  const { name, query } = req.body as { name?: string; query?: unknown };
  const fields: Record<string, unknown> = {};
  if (name !== undefined) {
    if (!name.trim()) {
      res.status(400).json({ error: 'Название не может быть пустым' });
      return;
    }
    fields.name = name.trim().slice(0, 60);
  }
  if (query !== undefined) {
    const clean = sanitizeQuery(query);
    if (Object.keys(clean).length === 0) {
      res.status(400).json({ error: 'Пустой фильтр сохранять незачем' });
      return;
    }
    fields.query = JSON.stringify(clean);
  }

  const keys = Object.keys(fields);
  if (keys.length) {
    db.prepare(`UPDATE saved_views SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...Object.values(fields),
      id
    );
    logAudit({
      entityType: 'view',
      entityId: id,
      action: 'updated',
      userId: user.id,
      userName: user.name,
      details: { fields: keys },
    });
  }

  const updated = db.prepare(`${VIEW_SELECT} WHERE v.id = ?`).get(id) as ViewRow;
  res.json({ view: mapView(updated, user) });
});

viewsRouter.delete('/:id(\\d+)', (req, res) => {
  const user = req.user!;
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, user_id, name, shared FROM saved_views WHERE id = ?').get(id) as
    | { id: number; user_id: number | null; name: string; shared: number }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Фильтр не найден' });
    return;
  }
  if (!canManage(row, user)) {
    res.status(403).json({
      error: row.shared === 1 ? 'Общий фильтр удаляет только главный бухгалтер' : 'Удалить можно только свой фильтр',
    });
    return;
  }

  db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
  logAudit({
    entityType: 'view',
    entityId: id,
    action: 'deleted',
    userId: user.id,
    userName: user.name,
    details: { name: row.name },
  });
  res.json({ ok: true });
});

/** Порядок плиток — личное дело каждого, поэтому только свои. */
viewsRouter.post('/reorder', requireRole('initiator', 'accountant', 'chief_accountant', 'director'), (req, res) => {
  const user = req.user!;
  const { ids } = req.body as { ids?: number[] };
  if (!Array.isArray(ids)) {
    res.status(400).json({ error: 'Не передан порядок' });
    return;
  }
  const own = db.prepare('SELECT id FROM saved_views WHERE user_id = ?').all(user.id) as { id: number }[];
  const ownIds = new Set(own.map((r) => r.id));

  const tx = db.transaction(() => {
    const update = db.prepare('UPDATE saved_views SET sort = ? WHERE id = ? AND user_id = ?');
    ids.filter((id) => ownIds.has(Number(id))).forEach((id, index) => update.run(index, Number(id), user.id));
  });
  tx();

  const rows = db
    .prepare(`${VIEW_SELECT} WHERE v.user_id = ? OR v.shared = 1 ORDER BY v.shared DESC, v.sort, v.id`)
    .all(user.id) as ViewRow[];
  res.json({ views: rows.map((row) => mapView(row, user)) });
});
