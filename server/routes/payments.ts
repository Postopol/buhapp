import { Router } from 'express';
import { db, nowTimestamp, logAudit } from '../db';
import { requireAuth, requireRole } from '../auth';
import { PAYABLE_TYPES } from '../../shared/domain';

export const paymentsRouter = Router();

paymentsRouter.use(requireAuth);
// Инициатор и руководитель платежи не ведут.
paymentsRouter.use(requireRole('accountant', 'chief_accountant'));

interface PaymentRow {
  id: number;
  payment_date: string;
  amount_minor: number;
  bank_account: string;
  reference: string;
  note: string;
  created_at: string;
  created_by_name: string | null;
  allocated: number;
}

const PAYMENT_SELECT = `
  SELECT p.id, p.payment_date, p.amount_minor, p.bank_account, p.reference, p.note, p.created_at,
         u.name AS created_by_name,
         COALESCE((SELECT SUM(dp.amount_minor) FROM document_payments dp WHERE dp.payment_id = p.id), 0) AS allocated
  FROM payments p
  LEFT JOIN users u ON u.id = p.created_by
`;

function mapPayment(row: PaymentRow) {
  return {
    id: row.id,
    paymentDate: row.payment_date,
    amount: row.amount_minor,
    allocated: row.allocated,
    unallocated: row.amount_minor - row.allocated,
    bankAccount: row.bank_account,
    reference: row.reference,
    note: row.note,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
  };
}

function allocationsOf(paymentId: number) {
  const rows = db
    .prepare(
      `SELECT dp.document_id, dp.amount_minor, d.number, d.type, cp.name AS counterparty_name
       FROM document_payments dp
       JOIN documents d ON d.id = dp.document_id
       LEFT JOIN counterparties cp ON cp.id = d.counterparty_id
       WHERE dp.payment_id = ?
       ORDER BY dp.id`
    )
    .all(paymentId) as {
    document_id: number;
    amount_minor: number;
    number: string;
    type: string;
    counterparty_name: string | null;
  }[];
  return rows.map((r) => ({
    documentId: r.document_id,
    documentNumber: r.number,
    documentType: r.type,
    counterpartyName: r.counterparty_name,
    amount: r.amount_minor,
  }));
}

paymentsRouter.get('/', (req, res) => {
  const { search, from, to } = req.query as { search?: string; from?: string; to?: string };
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (search && search.trim()) {
    conditions.push('(LOWER(p.reference) LIKE ? OR LOWER(p.note) LIKE ? OR p.bank_account LIKE ?)');
    const term = `%${search.trim().toLowerCase()}%`;
    params.push(term, term, term);
  }
  if (from) {
    conditions.push('p.payment_date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('p.payment_date <= ?');
    params.push(to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`${PAYMENT_SELECT} ${where} ORDER BY p.payment_date DESC, p.id DESC LIMIT 300`)
    .all(...params) as PaymentRow[];

  res.json({
    payments: rows.map((row) => ({ ...mapPayment(row), allocations: allocationsOf(row.id) })),
  });
});

/**
 * Реестр на оплату: согласованные счета и авансовые, по которым остался долг.
 * Это рабочий экран «что платим сегодня».
 */
paymentsRouter.get('/payable', (_req, res) => {
  const placeholders = PAYABLE_TYPES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT d.id, d.number, d.type, d.doc_date, d.due_date, d.amount_minor, d.purpose,
              cp.name AS counterparty_name, cp.iban, cp.bin,
              ei.name AS expense_item_name,
              COALESCE(pay.paid, 0) AS paid_minor
       FROM documents d
       LEFT JOIN counterparties cp ON cp.id = d.counterparty_id
       LEFT JOIN expense_items ei ON ei.id = d.expense_item_id
       LEFT JOIN (
         SELECT document_id, SUM(amount_minor) AS paid FROM document_payments GROUP BY document_id
       ) pay ON pay.document_id = d.id
       WHERE d.approval_status = 'approved'
         AND d.type IN (${placeholders})
         AND COALESCE(pay.paid, 0) < d.amount_minor
       ORDER BY d.due_date IS NULL, d.due_date, d.id`
    )
    .all(...PAYABLE_TYPES) as {
    id: number;
    number: string;
    type: string;
    doc_date: string;
    due_date: string | null;
    amount_minor: number;
    purpose: string;
    counterparty_name: string | null;
    iban: string | null;
    bin: string | null;
    expense_item_name: string | null;
    paid_minor: number;
  }[];

  res.json({
    payable: rows.map((r) => ({
      id: r.id,
      number: r.number,
      type: r.type,
      docDate: r.doc_date,
      dueDate: r.due_date,
      amount: r.amount_minor,
      paid: r.paid_minor,
      outstanding: r.amount_minor - r.paid_minor,
      purpose: r.purpose,
      counterpartyName: r.counterparty_name,
      iban: r.iban,
      bin: r.bin,
      expenseItemName: r.expense_item_name,
    })),
  });
});

interface PaymentBody {
  paymentDate?: string;
  amount?: number;
  bankAccount?: string;
  reference?: string;
  note?: string;
  allocations?: { documentId: number; amount: number }[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

paymentsRouter.post('/', (req, res) => {
  const body = req.body as PaymentBody;

  if (!body.paymentDate || !DATE_RE.test(body.paymentDate)) {
    res.status(400).json({ error: 'Укажите дату платежа' });
    return;
  }
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({ error: 'Сумма платежа должна быть положительным числом' });
    return;
  }
  const allocations = body.allocations ?? [];
  if (allocations.length === 0) {
    res.status(400).json({ error: 'Платёж нужно разнести хотя бы на один документ' });
    return;
  }

  // Разнесение не может превышать ни сумму платежа, ни остаток по документу.
  let allocatedTotal = 0;
  for (const a of allocations) {
    const allocAmount = Number(a.amount);
    if (!Number.isInteger(allocAmount) || allocAmount <= 0) {
      res.status(400).json({ error: 'Некорректная сумма разнесения' });
      return;
    }
    allocatedTotal += allocAmount;

    const doc = db
      .prepare(
        `SELECT d.id, d.number, d.amount_minor, d.approval_status,
                COALESCE((SELECT SUM(dp.amount_minor) FROM document_payments dp WHERE dp.document_id = d.id), 0) AS paid
         FROM documents d WHERE d.id = ?`
      )
      .get(a.documentId) as
      | { id: number; number: string; amount_minor: number; approval_status: string; paid: number }
      | undefined;

    if (!doc) {
      res.status(400).json({ error: `Документ #${a.documentId} не найден` });
      return;
    }
    if (doc.approval_status !== 'approved') {
      res.status(400).json({ error: `Документ ${doc.number} не согласован — оплата невозможна` });
      return;
    }
    if (doc.paid + allocAmount > doc.amount_minor) {
      const left = (doc.amount_minor - doc.paid) / 100;
      res.status(400).json({ error: `По документу ${doc.number} остаток к оплате ${left.toLocaleString('ru-KZ')} ₸ — разнесено больше` });
      return;
    }
  }

  if (allocatedTotal > amount) {
    res.status(400).json({ error: 'Разнесено больше, чем сумма платежа' });
    return;
  }

  const user = req.user!;
  const ts = nowTimestamp();
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO payments (payment_date, amount_minor, bank_account, reference, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.paymentDate,
        amount,
        (body.bankAccount ?? '').trim(),
        (body.reference ?? '').trim(),
        (body.note ?? '').trim(),
        user.id,
        ts
      );
    const paymentId = Number(info.lastInsertRowid);
    const insertAlloc = db.prepare(
      'INSERT INTO document_payments (document_id, payment_id, amount_minor) VALUES (?, ?, ?)'
    );
    for (const a of allocations) {
      insertAlloc.run(a.documentId, paymentId, Number(a.amount));
      db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(ts, a.documentId);
      logAudit({
        entityType: 'document',
        entityId: a.documentId,
        action: 'payment',
        userId: user.id,
        userName: user.name,
        details: { paymentId, amount: Number(a.amount), reference: body.reference },
      });
    }
    return paymentId;
  });

  const paymentId = tx();
  const row = db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(paymentId) as PaymentRow;
  res.status(201).json({ payment: { ...mapPayment(row), allocations: allocationsOf(paymentId) } });
});

paymentsRouter.delete('/:id(\\d+)', requireRole('chief_accountant'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, reference FROM payments WHERE id = ?').get(id) as
    | { id: number; reference: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Платёж не найден' });
    return;
  }
  const affected = db
    .prepare('SELECT document_id FROM document_payments WHERE payment_id = ?')
    .all(id) as { document_id: number }[];

  db.prepare('DELETE FROM payments WHERE id = ?').run(id);

  for (const a of affected) {
    logAudit({
      entityType: 'document',
      entityId: a.document_id,
      action: 'payment_deleted',
      userId: req.user!.id,
      userName: req.user!.name,
      details: { paymentId: id, reference: row.reference },
    });
  }
  res.json({ ok: true });
});
