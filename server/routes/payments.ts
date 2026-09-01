import { Router } from 'express';
import { db, nowTimestamp, logAudit, isPeriodClosed, ensurePeriod } from '../db';
import { requireAuth, requireRole } from '../auth';
import { PAYABLE_TYPES, DATE_RE } from '../../shared/domain';

export const paymentsRouter = Router();

paymentsRouter.use(requireAuth);

// Платежи ведёт бухгалтерия, но руководителю история оплат нужна на чтение:
// он видит все документы и акты сверки, а объяснить сальдо контрагента без
// оплат нельзя — раньше директор упирался в 403 на всём разделе. Инициатор
// не допущен никуда: его картина — только его документы.
const canReadPayments = requireRole('accountant', 'chief_accountant', 'director');
const canWritePayments = requireRole('accountant', 'chief_accountant');
paymentsRouter.use((req, res, next) =>
  (req.method === 'GET' ? canReadPayments : canWritePayments)(req, res, next)
);

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

interface Allocation {
  documentId: number;
  documentNumber: string;
  documentType: string;
  counterpartyName: string | null;
  amount: number;
}

/**
 * Разнесения сразу по списку платежей. Реестр отдаёт до 300 строк, и запрос
 * на каждую превращал один экран в три сотни обращений к базе — при том, что
 * данные забираются одним и тем же запросом с другим условием.
 */
function allocationsByPayment(paymentIds: number[]): Map<number, Allocation[]> {
  const byPayment = new Map<number, Allocation[]>();
  if (paymentIds.length === 0) return byPayment;

  const placeholders = paymentIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT dp.payment_id, dp.document_id, dp.amount_minor, d.number, d.type, cp.name AS counterparty_name
       FROM document_payments dp
       JOIN documents d ON d.id = dp.document_id
       LEFT JOIN counterparties cp ON cp.id = d.counterparty_id
       WHERE dp.payment_id IN (${placeholders})
       ORDER BY dp.id`
    )
    .all(...paymentIds) as {
    payment_id: number;
    document_id: number;
    amount_minor: number;
    number: string;
    type: string;
    counterparty_name: string | null;
  }[];

  for (const r of rows) {
    const list = byPayment.get(r.payment_id) ?? [];
    list.push({
      documentId: r.document_id,
      documentNumber: r.number,
      documentType: r.type,
      counterpartyName: r.counterparty_name,
      amount: r.amount_minor,
    });
    byPayment.set(r.payment_id, list);
  }
  return byPayment;
}

/** Разнесения одного платежа — тем же запросом, чтобы правило отбора было одно. */
function allocationsOf(paymentId: number): Allocation[] {
  return allocationsByPayment([paymentId]).get(paymentId) ?? [];
}

/**
 * `%` и `_` бухгалтер вводит как обычные символы — они встречаются в номерах
 * платёжек и в назначении, — а SQLite считает их подстановочными: поиск
 * «ПП-1_0» без экранирования находит и «ПП-100», и «ПП-110». Экранируем сами,
 * поэтому рядом с каждым LIKE обязан стоять тот же ESCAPE.
 */
const LIKE_ESCAPE = "ESCAPE '\\'";

function likeTerm(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

paymentsRouter.get('/', (req, res) => {
  const { search, from, to } = req.query as { search?: string; from?: string; to?: string };
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (search && search.trim()) {
    conditions.push(
      `(rulower(p.reference) LIKE ? ${LIKE_ESCAPE}` +
        ` OR rulower(p.note) LIKE ? ${LIKE_ESCAPE}` +
        ` OR p.bank_account LIKE ? ${LIKE_ESCAPE})`
    );
    const term = likeTerm(search);
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

  const allocations = allocationsByPayment(rows.map((row) => row.id));
  res.json({
    payments: rows.map((row) => ({ ...mapPayment(row), allocations: allocations.get(row.id) ?? [] })),
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

paymentsRouter.post('/', (req, res) => {
  const body = req.body as PaymentBody;

  if (!body.paymentDate || !DATE_RE.test(body.paymentDate)) {
    res.status(400).json({ error: 'Укажите дату платежа' });
    return;
  }
  // Оплаты в актах сверки режутся по дате ПЛАТЕЖА, а не по дате документа.
  // Поэтому платёж задним числом молча менял обороты и сальдо уже закрытого
  // месяца, даже когда сам документ лежал в открытом: проверять надо оба
  // периода, и месяц платежа — первым.
  const paymentPeriod = body.paymentDate.slice(0, 7);
  if (isPeriodClosed(paymentPeriod)) {
    res.status(409).json({ error: `Период ${paymentPeriod} закрыт — платёж этой датой провести нельзя` });
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

  // Два разнесения на один документ поштучную проверку проходили — каждое
  // сверялось с сохранённым doc.paid и по отдельности в остаток укладывалось, —
  // а потом падали пятисоткой на UNIQUE(document_id, payment_id). Суммы
  // складываются по документу ДО проверок: тогда и остаток считается по итогу,
  // и вставка на документ остаётся одна.
  const byDocument = new Map<number, number>();
  for (const a of allocations) {
    const documentId = Number(a.documentId);
    if (!Number.isInteger(documentId) || documentId <= 0) {
      res.status(400).json({ error: 'Некорректный документ в разнесении' });
      return;
    }
    const allocAmount = Number(a.amount);
    if (!Number.isInteger(allocAmount) || allocAmount <= 0) {
      res.status(400).json({ error: 'Некорректная сумма разнесения' });
      return;
    }
    byDocument.set(documentId, (byDocument.get(documentId) ?? 0) + allocAmount);
  }

  // Разнесение не может превышать ни сумму платежа, ни остаток по документу.
  let allocatedTotal = 0;
  for (const [documentId, allocAmount] of byDocument) {
    allocatedTotal += allocAmount;

    const doc = db
      .prepare(
        `SELECT d.id, d.number, d.amount_minor, d.approval_status, d.period,
                COALESCE((SELECT SUM(dp.amount_minor) FROM document_payments dp WHERE dp.document_id = d.id), 0) AS paid
         FROM documents d WHERE d.id = ?`
      )
      .get(documentId) as
      | { id: number; number: string; amount_minor: number; approval_status: string; period: string; paid: number }
      | undefined;

    if (!doc) {
      res.status(400).json({ error: `Документ #${documentId} не найден` });
      return;
    }
    if (isPeriodClosed(doc.period)) {
      res.status(409).json({ error: `Документ ${doc.number} в закрытом периоде ${doc.period} — оплату разнести нельзя` });
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
  // Месяц платежа обязан существовать как период со своим чек-листом: иначе
  // деньги, ушедшие в месяце без единого документа, не попадут ни в одно
  // закрытие — закрывать будет нечего, а обороты в нём есть.
  ensurePeriod(paymentPeriod);
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
    for (const [documentId, allocAmount] of byDocument) {
      insertAlloc.run(documentId, paymentId, allocAmount);
      db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(ts, documentId);
      logAudit({
        entityType: 'document',
        entityId: documentId,
        action: 'payment',
        userId: user.id,
        userName: user.name,
        details: { paymentId, amount: allocAmount, reference: body.reference },
      });
    }
    // Аудит самого платежа. Записи по документам его не заменяют: после
    // удаления платежа по ним не восстановить ни сумму, ни дату, ни то, как
    // деньги были разнесены, — а именно об этом и спрашивают при разборе.
    logAudit({
      entityType: 'payment',
      entityId: paymentId,
      action: 'created',
      userId: user.id,
      userName: user.name,
      details: {
        paymentDate: body.paymentDate,
        amount,
        reference: (body.reference ?? '').trim(),
        allocations: [...byDocument].map(([documentId, allocAmount]) => ({
          documentId,
          amount: allocAmount,
        })),
      },
    });
    return paymentId;
  });

  const paymentId = tx();
  const row = db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(paymentId) as PaymentRow;
  res.status(201).json({ payment: { ...mapPayment(row), allocations: allocationsOf(paymentId) } });
});

/**
 * Удаление платежа — правка уже сложившихся оборотов: деньги возвращаются
 * и в реестр на оплату, и в сальдо контрагента, и в акт сверки. Поэтому здесь
 * то же, что при переоткрытии периода, — обязательная причина в аудит, — и
 * та же защита закрытого месяца, что при заведении: проверяются и месяц
 * платежа, и месяцы всех документов, на которые он разнесён.
 */
paymentsRouter.delete('/:id(\\d+)', requireRole('chief_accountant'), (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare('SELECT id, payment_date, amount_minor, reference FROM payments WHERE id = ?')
    .get(id) as
    | { id: number; payment_date: string; amount_minor: number; reference: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Платёж не найден' });
    return;
  }

  const { reason } = (req.body ?? {}) as { reason?: string };
  if (!reason || !reason.trim()) {
    res.status(400).json({ error: 'Укажите причину удаления платежа' });
    return;
  }

  const paymentPeriod = row.payment_date.slice(0, 7);
  if (isPeriodClosed(paymentPeriod)) {
    res.status(409).json({ error: `Период ${paymentPeriod} закрыт — платёж из него удалить нельзя` });
    return;
  }

  const affected = db
    .prepare(
      `SELECT dp.document_id, dp.amount_minor, d.number, d.period
       FROM document_payments dp
       JOIN documents d ON d.id = dp.document_id
       WHERE dp.payment_id = ?`
    )
    .all(id) as { document_id: number; amount_minor: number; number: string; period: string }[];

  const locked = affected.find((a) => isPeriodClosed(a.period));
  if (locked) {
    res.status(409).json({
      error: `Документ ${locked.number} в закрытом периоде ${locked.period} — снять с него оплату нельзя`,
    });
    return;
  }

  const user = req.user!;
  const ts = nowTimestamp();
  const why = reason.trim();
  const tx = db.transaction(() => {
    // Разнесения уходят каскадом вместе с платежом, поэтому всё, что нужно
    // аудиту, собрано до удаления — восстанавливать его потом неоткуда.
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    for (const a of affected) {
      // Документ снова числится неоплаченным — это изменение его состояния.
      db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(ts, a.document_id);
      logAudit({
        entityType: 'document',
        entityId: a.document_id,
        action: 'payment_deleted',
        userId: user.id,
        userName: user.name,
        details: { paymentId: id, amount: a.amount_minor, reference: row.reference, reason: why },
      });
    }
    logAudit({
      entityType: 'payment',
      entityId: id,
      action: 'deleted',
      userId: user.id,
      userName: user.name,
      details: {
        paymentDate: row.payment_date,
        amount: row.amount_minor,
        reference: row.reference,
        reason: why,
        allocations: affected.map((a) => ({
          documentId: a.document_id,
          documentNumber: a.number,
          amount: a.amount_minor,
        })),
      },
    });
  });
  tx();

  res.json({ ok: true });
});
