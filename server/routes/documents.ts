import { Router } from 'express';
import { db, nowTimestamp, today, logAudit, isPeriodClosed, ensurePeriod } from '../db';
import { requireAuth } from '../auth';
import type { AuthUser } from '../auth';
import { csvMoney, csvRow, csvBody } from '../csv';
import {
  TRANSITIONS,
  CHIEF_APPROVAL_THRESHOLD,
  DOC_TYPES,
  SECTIONS,
  ORIGINAL_STATUSES,
  DOC_TYPE_SHORT,
  APPROVAL_LABELS,
  ORIGINAL_LABELS,
  PAGE_SIZE,
  type ApprovalStatus,
  type DocType,
  type OriginalStatus,
  type PaymentState,
  type Section,
} from '../../shared/domain';

export const documentsRouter = Router();

documentsRouter.use(requireAuth);

// ── Чтение ──────────────────────────────────────────────────────────────────

const BASE_SELECT = `
  SELECT
    d.id, d.type, d.number, d.doc_date, d.due_date, d.period,
    d.counterparty_id, d.contract_id, d.expense_item_id,
    d.amount_minor, d.vat_minor, d.purpose, d.section,
    d.responsible_user_id, d.created_by,
    d.approval_status, d.original_status, d.posting_status,
    d.created_at, d.updated_at,
    cp.name AS counterparty_name, cp.bin AS counterparty_bin,
    ei.name AS expense_item_name, ei.code AS expense_item_code,
    ru.name AS responsible_name,
    cu.name AS created_by_name,
    ct.number AS contract_number,
    COALESCE(pay.paid, 0) AS paid_minor,
    (SELECT COUNT(*) FROM attachments a WHERE a.document_id = d.id) AS attachments_count,
    (SELECT COUNT(*) FROM comments c WHERE c.document_id = d.id) AS comments_count
  FROM documents d
  LEFT JOIN counterparties cp ON cp.id = d.counterparty_id
  LEFT JOIN expense_items ei ON ei.id = d.expense_item_id
  LEFT JOIN users ru ON ru.id = d.responsible_user_id
  LEFT JOIN users cu ON cu.id = d.created_by
  LEFT JOIN contracts ct ON ct.id = d.contract_id
  LEFT JOIN (
    SELECT document_id, SUM(amount_minor) AS paid FROM document_payments GROUP BY document_id
  ) pay ON pay.document_id = d.id
`;

interface DocRow {
  id: number;
  type: DocType;
  number: string;
  doc_date: string;
  due_date: string | null;
  period: string;
  counterparty_id: number | null;
  contract_id: number | null;
  expense_item_id: number | null;
  amount_minor: number;
  vat_minor: number;
  purpose: string;
  section: Section;
  responsible_user_id: number | null;
  created_by: number | null;
  approval_status: ApprovalStatus;
  original_status: OriginalStatus;
  posting_status: 'not_posted' | 'posted';
  created_at: string;
  updated_at: string;
  counterparty_name: string | null;
  counterparty_bin: string | null;
  expense_item_name: string | null;
  expense_item_code: string | null;
  responsible_name: string | null;
  created_by_name: string | null;
  contract_number: string | null;
  paid_minor: number;
  attachments_count: number;
  comments_count: number;
}

function paymentState(row: DocRow): PaymentState {
  if (row.paid_minor <= 0) return 'unpaid';
  if (row.paid_minor >= row.amount_minor) return 'paid';
  return 'partial';
}

/** Просрочен = срок оплаты прошёл, деньги не ушли полностью, документ не отклонён. */
function isOverdue(row: DocRow): boolean {
  if (!row.due_date) return false;
  if (row.approval_status === 'rejected') return false;
  if (row.paid_minor >= row.amount_minor) return false;
  return row.due_date < today();
}

function mapDoc(row: DocRow) {
  return {
    id: row.id,
    type: row.type,
    number: row.number,
    docDate: row.doc_date,
    dueDate: row.due_date,
    period: row.period,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    counterpartyBin: row.counterparty_bin,
    contractId: row.contract_id,
    contractNumber: row.contract_number,
    expenseItemId: row.expense_item_id,
    expenseItemName: row.expense_item_name,
    expenseItemCode: row.expense_item_code,
    amount: row.amount_minor,
    vat: row.vat_minor,
    paid: row.paid_minor,
    paymentState: paymentState(row),
    purpose: row.purpose,
    section: row.section,
    responsibleId: row.responsible_user_id,
    responsibleName: row.responsible_name,
    createdById: row.created_by,
    createdByName: row.created_by_name,
    approvalStatus: row.approval_status,
    originalStatus: row.original_status,
    postingStatus: row.posting_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachmentsCount: row.attachments_count,
    commentsCount: row.comments_count,
    overdue: isOverdue(row),
    periodClosed: isPeriodClosed(row.period),
  };
}

/**
 * Инициатор видит только то, что завёл сам. Бухгалтерия и руководитель — всё.
 * Возвращает кусок SQL и параметры, которые всегда подмешиваются в WHERE.
 */
function visibilityScope(user: AuthUser): { sql: string; params: unknown[] } {
  if (user.role === 'initiator') {
    return { sql: 'd.created_by = ?', params: [user.id] };
  }
  return { sql: '1 = 1', params: [] };
}

const SORTABLE: Record<string, string> = {
  docDate: 'd.doc_date',
  dueDate: 'd.due_date',
  amount: 'd.amount_minor',
  number: 'd.number',
  counterparty: 'cp.name',
  updatedAt: 'd.updated_at',
};

export interface ListQuery {
  search?: string;
  type?: string;
  section?: string;
  approval?: string;
  original?: string;
  payment?: string;
  posting?: string;
  counterparty?: string;
  period?: string;
  responsible?: string;
  overdue?: string;
  mine?: string;
  sort?: string;
  dir?: string;
  limit?: string;
  offset?: string;
}

function buildFilters(q: ListQuery, user: AuthUser): { where: string; params: unknown[] } {
  const scope = visibilityScope(user);
  const conditions: string[] = [scope.sql];
  const params: unknown[] = [...scope.params];

  const eq = (value: string | undefined, column: string, allowed?: readonly string[]) => {
    if (!value || value === 'all') return;
    if (allowed && !allowed.includes(value)) return;
    conditions.push(`${column} = ?`);
    params.push(value);
  };

  eq(q.type, 'd.type', DOC_TYPES);
  eq(q.section, 'd.section', SECTIONS);
  eq(q.approval, 'd.approval_status', Object.keys(APPROVAL_LABELS));
  eq(q.original, 'd.original_status', ORIGINAL_STATUSES);
  eq(q.posting, 'd.posting_status', ['not_posted', 'posted']);
  eq(q.period, 'd.period');

  if (q.counterparty && q.counterparty !== 'all') {
    conditions.push('d.counterparty_id = ?');
    params.push(Number(q.counterparty));
  }
  if (q.responsible && q.responsible !== 'all') {
    conditions.push('d.responsible_user_id = ?');
    params.push(Number(q.responsible));
  }
  if (q.mine === 'true') {
    // «Мои» = мой участок для бухгалтера, мои документы для инициатора.
    if (user.role === 'initiator') {
      conditions.push('d.created_by = ?');
      params.push(user.id);
    } else {
      conditions.push('(d.responsible_user_id = ? OR d.created_by = ?)');
      params.push(user.id, user.id);
    }
  }

  if (q.payment === 'unpaid') conditions.push('COALESCE(pay.paid, 0) = 0');
  if (q.payment === 'partial') conditions.push('COALESCE(pay.paid, 0) > 0 AND COALESCE(pay.paid, 0) < d.amount_minor');
  if (q.payment === 'paid') conditions.push('COALESCE(pay.paid, 0) >= d.amount_minor');

  if (q.overdue === 'true') {
    conditions.push(
      `d.due_date IS NOT NULL AND d.due_date < ? AND d.approval_status <> 'rejected' AND COALESCE(pay.paid, 0) < d.amount_minor`
    );
    params.push(today());
  }

  if (q.search && q.search.trim()) {
    conditions.push(
      `(rulower(d.number) LIKE ? OR rulower(d.purpose) LIKE ? OR rulower(COALESCE(cp.name, '')) LIKE ? OR COALESCE(cp.bin, '') LIKE ?)`
    );
    const term = `%${q.search.trim().toLowerCase()}%`;
    params.push(term, term, term, term);
  }

  return { where: conditions.join(' AND '), params };
}

documentsRouter.get('/', (req, res) => {
  const q = req.query as ListQuery;
  const { where, params } = buildFilters(q, req.user!);

  const sortColumn = SORTABLE[q.sort ?? ''] ?? 'd.doc_date';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Number(q.limit) || PAGE_SIZE, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const rows = db
    .prepare(`${BASE_SELECT} WHERE ${where} ORDER BY ${sortColumn} ${dir}, d.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as DocRow[];

  // Итоги считаются по всей выборке, а не по странице — бухгалтеру нужна
  // сумма по фильтру целиком.
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM(d.amount_minor), 0) AS amount,
         COALESCE(SUM(d.vat_minor), 0) AS vat,
         COALESCE(SUM(COALESCE(pay.paid, 0)), 0) AS paid
       FROM documents d
       LEFT JOIN counterparties cp ON cp.id = d.counterparty_id
       LEFT JOIN (
         SELECT document_id, SUM(amount_minor) AS paid FROM document_payments GROUP BY document_id
       ) pay ON pay.document_id = d.id
       WHERE ${where}`
    )
    .get(...params) as { count: number; amount: number; vat: number; paid: number };

  res.json({
    documents: rows.map(mapDoc),
    total: totals.count,
    totals: {
      amount: totals.amount,
      vat: totals.vat,
      paid: totals.paid,
      unpaid: totals.amount - totals.paid,
    },
    limit,
    offset,
  });
});

/** Выгрузка текущей выборки в CSV — Excel с разделителем «;» и BOM. */
documentsRouter.get('/export.csv', (req, res) => {
  const q = req.query as ListQuery;
  const { where, params } = buildFilters(q, req.user!);
  const rows = db
    .prepare(`${BASE_SELECT} WHERE ${where} ORDER BY d.doc_date DESC, d.id DESC LIMIT 10000`)
    .all(...params) as DocRow[];

  const header = [
    'Дата', 'Тип', 'Номер', 'Контрагент', 'БИН', 'Сумма', 'в т.ч. НДС', 'Оплачено',
    'Статья', 'Срок оплаты', 'Согласование', 'Оригинал', 'Оплата', 'Учёт', 'Ответственный', 'Назначение',
  ];
  const paymentLabel: Record<PaymentState, string> = { unpaid: 'Не оплачен', partial: 'Частично', paid: 'Оплачен' };

  const lines = [csvRow(header)];
  for (const row of rows) {
    lines.push(
      csvRow([
        row.doc_date,
        DOC_TYPE_SHORT[row.type],
        row.number,
        row.counterparty_name ?? '',
        row.counterparty_bin ?? '',
        csvMoney(row.amount_minor),
        csvMoney(row.vat_minor),
        csvMoney(row.paid_minor),
        row.expense_item_name ?? '',
        row.due_date ?? '',
        APPROVAL_LABELS[row.approval_status],
        ORIGINAL_LABELS[row.original_status],
        paymentLabel[paymentState(row)],
        row.posting_status === 'posted' ? 'Проведён' : 'Не проведён',
        row.responsible_name ?? '',
        row.purpose,
      ])
    );
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="documents-${today()}.csv"`);
  res.send(csvBody(lines));
});

function loadDoc(id: number): DocRow | undefined {
  return db.prepare(`${BASE_SELECT} WHERE d.id = ?`).get(id) as DocRow | undefined;
}

function canSee(row: DocRow, user: AuthUser): boolean {
  if (user.role === 'initiator') return row.created_by === user.id;
  return true;
}

/** Закрытый период не меняется — иначе отчётность разъедется с учётом. */
const PERIOD_LOCKED = 'Период закрыт — документ изменить нельзя. Обратитесь к главному бухгалтеру.';

function periodLocked(row: DocRow): boolean {
  return isPeriodClosed(row.period);
}

documentsRouter.get('/:id(\\d+)', (req, res) => {
  const row = loadDoc(Number(req.params.id));
  if (!row || !canSee(row, req.user!)) {
    res.status(404).json({ error: 'Документ не найден' });
    return;
  }

  const attachments = db
    .prepare(
      `SELECT a.id, a.filename, a.mime, a.size, a.uploaded_at, u.name AS uploaded_by_name
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.document_id = ? ORDER BY a.id`
    )
    .all(row.id) as { id: number; filename: string; mime: string; size: number; uploaded_at: string; uploaded_by_name: string | null }[];

  const comments = db
    .prepare('SELECT id, user_name, body, kind, created_at FROM comments WHERE document_id = ? ORDER BY id')
    .all(row.id) as { id: number; user_name: string; body: string; kind: string; created_at: string }[];

  const history = db
    .prepare(
      `SELECT id, action, user_name, details, created_at FROM audit_log
       WHERE entity_type = 'document' AND entity_id = ? ORDER BY id DESC`
    )
    .all(String(row.id)) as { id: number; action: string; user_name: string; details: string | null; created_at: string }[];

  const payments = db
    .prepare(
      `SELECT p.id, p.payment_date, p.reference, p.bank_account, dp.amount_minor
       FROM document_payments dp JOIN payments p ON p.id = dp.payment_id
       WHERE dp.document_id = ? ORDER BY p.payment_date`
    )
    .all(row.id) as { id: number; payment_date: string; reference: string; bank_account: string; amount_minor: number }[];

  res.json({
    document: {
      ...mapDoc(row),
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        size: a.size,
        uploadedAt: a.uploaded_at,
        uploadedByName: a.uploaded_by_name,
      })),
      comments: comments.map((c) => ({
        id: c.id,
        userName: c.user_name,
        body: c.body,
        kind: c.kind,
        createdAt: c.created_at,
      })),
      history: history.map((h) => ({
        id: h.id,
        action: h.action,
        userName: h.user_name,
        details: h.details ? (JSON.parse(h.details) as unknown) : null,
        createdAt: h.created_at,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        paymentDate: p.payment_date,
        reference: p.reference,
        bankAccount: p.bank_account,
        amount: p.amount_minor,
      })),
    },
  });
});

// ── Создание и правка ───────────────────────────────────────────────────────

interface DocBody {
  type?: DocType;
  number?: string;
  docDate?: string;
  dueDate?: string | null;
  counterpartyId?: number | null;
  contractId?: number | null;
  expenseItemId?: number | null;
  amount?: number;
  vat?: number;
  purpose?: string;
  section?: Section;
  responsibleId?: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(body: DocBody, partial: boolean): string | null {
  const need = (key: keyof DocBody) => !partial || body[key] !== undefined;

  if (need('type') && (!body.type || !DOC_TYPES.includes(body.type))) return 'Выберите тип документа';
  if (need('number') && (!body.number || !body.number.trim())) return 'Укажите номер документа';
  if (need('docDate') && (!body.docDate || !DATE_RE.test(body.docDate))) return 'Укажите дату документа';
  if (body.dueDate && !DATE_RE.test(body.dueDate)) return 'Некорректный срок оплаты';
  if (body.dueDate && body.docDate && body.dueDate < body.docDate) {
    return 'Срок оплаты не может быть раньше даты документа';
  }
  if (need('section') && (!body.section || !SECTIONS.includes(body.section))) return 'Выберите участок';

  if (need('amount')) {
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) return 'Сумма должна быть положительным числом';
  }
  if (body.vat !== undefined && body.vat !== null) {
    const vat = Number(body.vat);
    if (!Number.isInteger(vat) || vat < 0) return 'Некорректная сумма НДС';
    const amount = Number(body.amount);
    if (Number.isInteger(amount) && vat > amount) return 'НДС не может превышать сумму документа';
  }
  if (body.counterpartyId) {
    const exists = db.prepare('SELECT 1 FROM counterparties WHERE id = ?').get(body.counterpartyId);
    if (!exists) return 'Контрагент не найден';
  }
  if (body.expenseItemId) {
    const exists = db.prepare('SELECT 1 FROM expense_items WHERE id = ?').get(body.expenseItemId);
    if (!exists) return 'Статья расходов не найдена';
  }
  return null;
}

documentsRouter.post('/', (req, res) => {
  const body = req.body as DocBody;
  const error = validate(body, false);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const period = body.docDate!.slice(0, 7);
  if (isPeriodClosed(period)) {
    res.status(409).json({ error: `Период ${period} закрыт — документ этой датой завести нельзя` });
    return;
  }
  ensurePeriod(period);

  const user = req.user!;
  const ts = nowTimestamp();

  // Ответственного назначаем по участку: документ сразу попадает в очередь
  // конкретного бухгалтера, а не в общий котёл.
  let responsibleId = body.responsibleId ?? null;
  if (!responsibleId) {
    const owner = db
      .prepare(`SELECT id FROM users WHERE section = ? AND role = 'accountant' ORDER BY id LIMIT 1`)
      .get(body.section) as { id: number } | undefined;
    responsibleId = owner?.id ?? null;
  }

  const info = db
    .prepare(
      `INSERT INTO documents
        (type, number, doc_date, due_date, period, counterparty_id, contract_id, expense_item_id,
         amount_minor, vat_minor, purpose, section, responsible_user_id, created_by,
         approval_status, original_status, posting_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'none', 'not_posted', ?, ?)`
    )
    .run(
      body.type,
      body.number!.trim(),
      body.docDate,
      body.dueDate || null,
      period,
      body.counterpartyId ?? null,
      body.contractId ?? null,
      body.expenseItemId ?? null,
      Number(body.amount),
      Number(body.vat) || 0,
      (body.purpose ?? '').trim(),
      body.section,
      responsibleId,
      user.id,
      ts,
      ts
    );

  const id = Number(info.lastInsertRowid);
  logAudit({
    entityType: 'document',
    entityId: id,
    action: 'created',
    userId: user.id,
    userName: user.name,
    details: { number: body.number, amount: Number(body.amount) },
  });

  res.status(201).json({ document: mapDoc(loadDoc(id)!) });
});

documentsRouter.patch('/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const row = loadDoc(id);
  if (!row || !canSee(row, req.user!)) {
    res.status(404).json({ error: 'Документ не найден' });
    return;
  }
  const user = req.user!;

  if (periodLocked(row)) {
    res.status(409).json({ error: PERIOD_LOCKED });
    return;
  }

  // Согласованный документ правит только главбух — иначе подпись теряет смысл.
  if (row.approval_status === 'approved' && user.role !== 'chief_accountant') {
    res.status(403).json({ error: 'Согласованный документ может изменить только главный бухгалтер' });
    return;
  }
  if (row.approval_status === 'review' && user.role === 'initiator') {
    res.status(403).json({ error: 'Документ на проверке, изменения недоступны' });
    return;
  }

  const body = req.body as DocBody;
  const error = validate({ ...body, amount: body.amount ?? row.amount_minor, docDate: body.docDate ?? row.doc_date }, true);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const fields: Record<string, unknown> = {};
  const assign = (column: string, value: unknown) => {
    if (value !== undefined) fields[column] = value;
  };
  assign('type', body.type);
  assign('number', body.number?.trim());
  assign('doc_date', body.docDate);
  assign('due_date', body.dueDate === undefined ? undefined : body.dueDate || null);
  assign('counterparty_id', body.counterpartyId);
  assign('contract_id', body.contractId);
  assign('expense_item_id', body.expenseItemId);
  assign('amount_minor', body.amount === undefined ? undefined : Number(body.amount));
  assign('vat_minor', body.vat === undefined ? undefined : Number(body.vat) || 0);
  assign('purpose', body.purpose?.trim());
  assign('section', body.section);
  assign('responsible_user_id', body.responsibleId);
  if (body.docDate) {
    const newPeriod = body.docDate.slice(0, 7);
    // Перенос датой в уже закрытый месяц — тот же обход блокировки.
    if (newPeriod !== row.period && isPeriodClosed(newPeriod)) {
      res.status(409).json({ error: `Период ${newPeriod} закрыт — перенести документ туда нельзя` });
      return;
    }
    ensurePeriod(newPeriod);
    fields.period = newPeriod;
  }

  const keys = Object.keys(fields);
  if (keys.length === 0) {
    res.json({ document: mapDoc(row) });
    return;
  }
  fields.updated_at = nowTimestamp();

  const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE documents SET ${setSql} WHERE id = ?`).run(...Object.values(fields), id);

  logAudit({
    entityType: 'document',
    entityId: id,
    action: 'updated',
    userId: user.id,
    userName: user.name,
    details: { fields: keys },
  });

  res.json({ document: mapDoc(loadDoc(id)!) });
});

// ── Маршрут согласования ────────────────────────────────────────────────────

/**
 * Возвращает текст ошибки, если переход недоступен, иначе null.
 * Одна функция и для одиночного действия, и для массового.
 */
function checkTransition(row: DocRow, to: ApprovalStatus, comment: string, user: AuthUser): string | null {
  if (periodLocked(row)) return PERIOD_LOCKED;
  const transition = TRANSITIONS[row.approval_status]?.find((t) => t.to === to);
  if (!transition) {
    return `Из состояния «${APPROVAL_LABELS[row.approval_status]}» такой переход невозможен`;
  }
  if (!transition.roles.includes(user.role)) {
    return 'Недостаточно прав для этого действия';
  }
  if (transition.requiresComment && !comment.trim()) {
    return 'Укажите причину';
  }
  // Инициатор отправляет на проверку только собственный документ.
  if (user.role === 'initiator' && row.created_by !== user.id) {
    return 'Это не ваш документ';
  }
  if (to === 'approved' && row.amount_minor >= CHIEF_APPROVAL_THRESHOLD && user.role !== 'chief_accountant') {
    const limit = (CHIEF_APPROVAL_THRESHOLD / 100).toLocaleString('ru-KZ');
    return `Документы на сумму от ${limit} ₸ согласовывает главный бухгалтер`;
  }
  return null;
}

function applyTransition(row: DocRow, to: ApprovalStatus, comment: string, user: AuthUser): void {
  const ts = nowTimestamp();
  const tx = db.transaction(() => {
    db.prepare('UPDATE documents SET approval_status = ?, updated_at = ? WHERE id = ?').run(to, ts, row.id);
    if (comment.trim()) {
      const kind = to === 'returned' || to === 'rejected' ? 'return_reason' : 'comment';
      db.prepare(
        'INSERT INTO comments (document_id, user_id, user_name, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(row.id, user.id, user.name, comment.trim(), kind, ts);
    }
  });
  tx();
  logAudit({
    entityType: 'document',
    entityId: row.id,
    action: 'approval',
    userId: user.id,
    userName: user.name,
    details: { from: row.approval_status, to, comment: comment.trim() || undefined },
  });
}

documentsRouter.post('/:id(\\d+)/transition', (req, res) => {
  const row = loadDoc(Number(req.params.id));
  if (!row || !canSee(row, req.user!)) {
    res.status(404).json({ error: 'Документ не найден' });
    return;
  }
  const { to, comment } = req.body as { to?: ApprovalStatus; comment?: string };
  if (!to) {
    res.status(400).json({ error: 'Не указано действие' });
    return;
  }
  const error = checkTransition(row, to, comment ?? '', req.user!);
  if (error) {
    res.status(403).json({ error });
    return;
  }
  applyTransition(row, to, comment ?? '', req.user!);
  res.json({ document: mapDoc(loadDoc(row.id)!) });
});

/** Массовое согласование — то, ради чего бухгалтер вообще открывает реестр. */
documentsRouter.post('/bulk/transition', (req, res) => {
  const { ids, to, comment } = req.body as { ids?: number[]; to?: ApprovalStatus; comment?: string };
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'Не выбрано ни одного документа' });
    return;
  }
  if (!to) {
    res.status(400).json({ error: 'Не указано действие' });
    return;
  }
  if (ids.length > 200) {
    res.status(400).json({ error: 'За один раз можно обработать не более 200 документов' });
    return;
  }

  const user = req.user!;
  const applied: number[] = [];
  const skipped: { id: number; number: string; reason: string }[] = [];

  for (const rawId of ids) {
    const row = loadDoc(Number(rawId));
    if (!row || !canSee(row, user)) {
      skipped.push({ id: Number(rawId), number: '—', reason: 'Документ не найден' });
      continue;
    }
    const error = checkTransition(row, to, comment ?? '', user);
    if (error) {
      skipped.push({ id: row.id, number: row.number, reason: error });
      continue;
    }
    applyTransition(row, to, comment ?? '', user);
    applied.push(row.id);
  }

  res.json({ applied, skipped });
});

// ── Оригинал и учёт: статусы, живущие отдельно от согласования ──────────────

documentsRouter.post('/:id(\\d+)/original', (req, res) => {
  const row = loadDoc(Number(req.params.id));
  if (!row || !canSee(row, req.user!)) {
    res.status(404).json({ error: 'Документ не найден' });
    return;
  }
  const user = req.user!;
  if (periodLocked(row)) {
    res.status(409).json({ error: PERIOD_LOCKED });
    return;
  }
  if (user.role === 'initiator') {
    res.status(403).json({ error: 'Статус оригинала ведёт бухгалтерия' });
    return;
  }
  const { status } = req.body as { status?: OriginalStatus };
  if (!status || !ORIGINAL_STATUSES.includes(status)) {
    res.status(400).json({ error: 'Некорректный статус оригинала' });
    return;
  }
  db.prepare('UPDATE documents SET original_status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowTimestamp(),
    row.id
  );
  logAudit({
    entityType: 'document',
    entityId: row.id,
    action: 'original',
    userId: user.id,
    userName: user.name,
    details: { from: row.original_status, to: status },
  });
  res.json({ document: mapDoc(loadDoc(row.id)!) });
});

documentsRouter.post('/:id(\\d+)/posting', (req, res) => {
  const row = loadDoc(Number(req.params.id));
  if (!row || !canSee(row, req.user!)) {
    res.status(404).json({ error: 'Документ не найден' });
    return;
  }
  const user = req.user!;
  if (periodLocked(row)) {
    res.status(409).json({ error: PERIOD_LOCKED });
    return;
  }
  if (user.role === 'initiator' || user.role === 'director') {
    res.status(403).json({ error: 'Проводит документы бухгалтерия' });
    return;
  }
  const { status } = req.body as { status?: 'not_posted' | 'posted' };
  if (status !== 'posted' && status !== 'not_posted') {
    res.status(400).json({ error: 'Некорректный статус учёта' });
    return;
  }
  if (status === 'posted' && row.approval_status !== 'approved') {
    res.status(400).json({ error: 'Провести можно только согласованный документ' });
    return;
  }
  if (status === 'posted' && row.original_status === 'none') {
    res.status(400).json({ error: 'Нельзя провести документ без оригинала или скана' });
    return;
  }
  db.prepare('UPDATE documents SET posting_status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowTimestamp(),
    row.id
  );
  logAudit({
    entityType: 'document',
    entityId: row.id,
    action: 'posting',
    userId: user.id,
    userName: user.name,
    details: { from: row.posting_status, to: status },
  });
  res.json({ document: mapDoc(loadDoc(row.id)!) });
});

// ── Комментарии ─────────────────────────────────────────────────────────────

documentsRouter.post('/:id(\\d+)/comments', (req, res) => {
  const row = loadDoc(Number(req.params.id));
  if (!row || !canSee(row, req.user!)) {
    res.status(404).json({ error: 'Документ не найден' });
    return;
  }
  const { body } = req.body as { body?: string };
  if (!body || !body.trim()) {
    res.status(400).json({ error: 'Комментарий пустой' });
    return;
  }
  const user = req.user!;
  const ts = nowTimestamp();
  const info = db
    .prepare('INSERT INTO comments (document_id, user_id, user_name, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, user.id, user.name, body.trim(), 'comment', ts);

  res.status(201).json({
    comment: {
      id: Number(info.lastInsertRowid),
      userName: user.name,
      body: body.trim(),
      kind: 'comment',
      createdAt: ts,
    },
  });
});

/**
 * Счётчик для сохранённого фильтра. Считает тем же построителем, что и реестр,
 * иначе цифра на плитке и содержимое списка со временем разойдутся.
 */
export function countForFilters(query: ListQuery, user: AuthUser): { count: number; amount: number } {
  const { where, params } = buildFilters(query, user);
  return db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(d.amount_minor), 0) AS amount
       FROM documents d
       LEFT JOIN counterparties cp ON cp.id = d.counterparty_id
       LEFT JOIN (
         SELECT document_id, SUM(amount_minor) AS paid FROM document_payments GROUP BY document_id
       ) pay ON pay.document_id = d.id
       WHERE ${where}`
    )
    .get(...params) as { count: number; amount: number };
}

export { mapDoc, BASE_SELECT, type DocRow };
