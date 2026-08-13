import { Router } from 'express';
import { db, nowTimestamp, logAudit } from '../db';
import { requireAuth, requireRole } from '../auth';

export const counterpartiesRouter = Router();

counterpartiesRouter.use(requireAuth);

interface CpRow {
  id: number;
  bin: string;
  name: string;
  is_vat_payer: number;
  bank_name: string;
  bank_bic: string;
  iban: string;
  responsible_user_id: number | null;
  responsible_name: string | null;
  note: string;
  created_at: string;
}

function mapCp(row: CpRow) {
  return {
    id: row.id,
    bin: row.bin,
    name: row.name,
    isVatPayer: row.is_vat_payer === 1,
    bankName: row.bank_name,
    bankBic: row.bank_bic,
    iban: row.iban,
    responsibleId: row.responsible_user_id,
    responsibleName: row.responsible_name,
    note: row.note,
    createdAt: row.created_at,
  };
}

const CP_SELECT = `
  SELECT c.id, c.bin, c.name, c.is_vat_payer, c.bank_name, c.bank_bic, c.iban,
         c.responsible_user_id, c.note, c.created_at, u.name AS responsible_name
  FROM counterparties c
  LEFT JOIN users u ON u.id = c.responsible_user_id
`;

/**
 * Сальдо по контрагенту: сколько признано документами и сколько закрыто
 * деньгами. Отклонённые документы в долг не идут.
 */
const BALANCE_SELECT = `
  SELECT
    COALESCE(SUM(CASE WHEN d.approval_status <> 'rejected' THEN d.amount_minor ELSE 0 END), 0) AS accrued,
    COALESCE(SUM(CASE WHEN d.approval_status <> 'rejected' THEN COALESCE(pay.paid, 0) ELSE 0 END), 0) AS paid,
    COUNT(*) AS documents,
    COALESCE(SUM(CASE WHEN d.original_status = 'none' THEN 1 ELSE 0 END), 0) AS missing_originals
  FROM documents d
  LEFT JOIN (
    SELECT document_id, SUM(amount_minor) AS paid FROM document_payments GROUP BY document_id
  ) pay ON pay.document_id = d.id
  WHERE d.counterparty_id = ?
`;

counterpartiesRouter.get('/', (req, res) => {
  const { search } = req.query as { search?: string };
  const params: unknown[] = [];
  let where = '';
  if (search && search.trim()) {
    where = 'WHERE LOWER(c.name) LIKE ? OR c.bin LIKE ?';
    const term = `%${search.trim().toLowerCase()}%`;
    params.push(term, term);
  }
  const rows = db.prepare(`${CP_SELECT} ${where} ORDER BY c.name`).all(...params) as CpRow[];

  const balanceStmt = db.prepare(BALANCE_SELECT);
  res.json({
    counterparties: rows.map((row) => {
      const b = balanceStmt.get(row.id) as {
        accrued: number;
        paid: number;
        documents: number;
        missing_originals: number;
      };
      return {
        ...mapCp(row),
        accrued: b.accrued,
        paid: b.paid,
        debt: b.accrued - b.paid,
        documentsCount: b.documents,
        missingOriginals: b.missing_originals,
      };
    }),
  });
});

counterpartiesRouter.get('/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`${CP_SELECT} WHERE c.id = ?`).get(id) as CpRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Контрагент не найден' });
    return;
  }
  const balance = db.prepare(BALANCE_SELECT).get(id) as {
    accrued: number;
    paid: number;
    documents: number;
    missing_originals: number;
  };
  const contracts = db
    .prepare(
      `SELECT id, number, contract_date, subject, amount_minor, valid_until
       FROM contracts WHERE counterparty_id = ? ORDER BY contract_date DESC`
    )
    .all(id) as {
    id: number;
    number: string;
    contract_date: string;
    subject: string;
    amount_minor: number;
    valid_until: string | null;
  }[];

  res.json({
    counterparty: {
      ...mapCp(row),
      accrued: balance.accrued,
      paid: balance.paid,
      debt: balance.accrued - balance.paid,
      documentsCount: balance.documents,
      missingOriginals: balance.missing_originals,
      contracts: contracts.map((c) => ({
        id: c.id,
        number: c.number,
        date: c.contract_date,
        subject: c.subject,
        amount: c.amount_minor,
        validUntil: c.valid_until,
        expired: c.valid_until !== null && c.valid_until < nowTimestamp().slice(0, 10),
      })),
    },
  });
});

interface CpBody {
  bin?: string;
  name?: string;
  isVatPayer?: boolean;
  bankName?: string;
  bankBic?: string;
  iban?: string;
  responsibleId?: number | null;
  note?: string;
}

/** БИН/ИИН в РК — ровно 12 цифр. */
function validateCp(body: CpBody, partial: boolean): string | null {
  if (!partial || body.bin !== undefined) {
    if (!body.bin || !/^\d{12}$/.test(body.bin.trim())) return 'БИН/ИИН должен состоять из 12 цифр';
  }
  if (!partial || body.name !== undefined) {
    if (!body.name || !body.name.trim()) return 'Укажите наименование';
  }
  if (body.iban && !/^KZ[0-9A-Z]{18}$/i.test(body.iban.trim())) {
    return 'IBAN должен начинаться с KZ и содержать 20 символов';
  }
  return null;
}

counterpartiesRouter.post('/', requireRole('accountant', 'chief_accountant'), (req, res) => {
  const body = req.body as CpBody;
  const error = validateCp(body, false);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const bin = body.bin!.trim();
  const exists = db.prepare('SELECT id FROM counterparties WHERE bin = ?').get(bin) as { id: number } | undefined;
  if (exists) {
    res.status(409).json({ error: 'Контрагент с таким БИН уже заведён', id: exists.id });
    return;
  }
  const user = req.user!;
  const info = db
    .prepare(
      `INSERT INTO counterparties (bin, name, is_vat_payer, bank_name, bank_bic, iban, responsible_user_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      bin,
      body.name!.trim(),
      body.isVatPayer ? 1 : 0,
      (body.bankName ?? '').trim(),
      (body.bankBic ?? '').trim(),
      (body.iban ?? '').trim().toUpperCase(),
      body.responsibleId ?? user.id,
      (body.note ?? '').trim(),
      nowTimestamp()
    );
  const id = Number(info.lastInsertRowid);
  logAudit({
    entityType: 'counterparty',
    entityId: id,
    action: 'created',
    userId: user.id,
    userName: user.name,
    details: { bin, name: body.name },
  });
  const row = db.prepare(`${CP_SELECT} WHERE c.id = ?`).get(id) as CpRow;
  res.status(201).json({ counterparty: mapCp(row) });
});

counterpartiesRouter.patch('/:id(\\d+)', requireRole('accountant', 'chief_accountant'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM counterparties WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Контрагент не найден' });
    return;
  }
  const body = req.body as CpBody;
  const error = validateCp(body, true);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const fields: Record<string, unknown> = {};
  if (body.bin !== undefined) fields.bin = body.bin.trim();
  if (body.name !== undefined) fields.name = body.name.trim();
  if (body.isVatPayer !== undefined) fields.is_vat_payer = body.isVatPayer ? 1 : 0;
  if (body.bankName !== undefined) fields.bank_name = body.bankName.trim();
  if (body.bankBic !== undefined) fields.bank_bic = body.bankBic.trim();
  if (body.iban !== undefined) fields.iban = body.iban.trim().toUpperCase();
  if (body.responsibleId !== undefined) fields.responsible_user_id = body.responsibleId;
  if (body.note !== undefined) fields.note = body.note.trim();

  const keys = Object.keys(fields);
  if (keys.length) {
    const setSql = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE counterparties SET ${setSql} WHERE id = ?`).run(...Object.values(fields), id);
    logAudit({
      entityType: 'counterparty',
      entityId: id,
      action: 'updated',
      userId: req.user!.id,
      userName: req.user!.name,
      details: { fields: keys },
    });
  }
  const row = db.prepare(`${CP_SELECT} WHERE c.id = ?`).get(id) as CpRow;
  res.json({ counterparty: mapCp(row) });
});
