import { Router } from 'express';
import { db, nowTimestamp, logAudit } from '../db';
import { requireAuth, requireRole } from '../auth';

export const counterpartiesRouter = Router();

counterpartiesRouter.use(requireAuth);
// Справочник отдаёт не реквизиты, а финансовую картину компании: сальдо, долг
// и число документов по каждому контрагенту. Инициатор по матрице ролей видит
// только своё, а для формы документа ему хватает реквизитов из
// workspace/dictionaries — поэтому весь раздел закрыт бухгалтерией
// и руководителем, ровно как пункт меню на клиенте.
counterpartiesRouter.use(requireRole('accountant', 'chief_accountant', 'director'));

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

// ── Сальдо ──────────────────────────────────────────────────────────────────
//
// Сколько признано документами и сколько закрыто деньгами.
//
// ВНИМАНИЕ: правило отбора обязано совпадать с `server/reconciliation.ts`
// слово в слово. Акт сверки за всю историю сходится с долгом на карточке до
// тиына, и это единственная проверка, которая ловит расхождение правил, —
// правка здесь без такой же правки там ломает акт, уходящий контрагенту.

/** Отклонённый документ долга не создаёт — ни в начислениях, ни в оплатах по нему. */
const NOT_REJECTED = `d.approval_status <> 'rejected'`;

/**
 * Счёт на оплату сам по себе обязательства не создаёт — начисление создаёт
 * закрывающий его акт или накладная. Поэтому документ, на который сослался
 * `closes_document_id` другого НЕ отклонённого документа, из начислений
 * выпадает. Из оплат он не выпадает: платежи разносятся именно на счёт, и он
 * остаётся их носителем. Без этого правила поток «счёт → оплата → акт»
 * задваивал сальдо контрагента.
 */
const NOT_CLOSED_BY_OTHER = `NOT EXISTS (
      SELECT 1 FROM documents closer
      WHERE closer.closes_document_id = d.id AND closer.approval_status <> 'rejected'
    )`;

const BALANCE_COLUMNS = `
    COALESCE(SUM(CASE WHEN ${NOT_REJECTED} AND ${NOT_CLOSED_BY_OTHER} THEN d.amount_minor ELSE 0 END), 0) AS accrued,
    COALESCE(SUM(CASE WHEN ${NOT_REJECTED} THEN COALESCE(pay.paid, 0) ELSE 0 END), 0) AS paid,
    COUNT(*) AS documents,
    COALESCE(SUM(CASE WHEN d.original_status = 'none' THEN 1 ELSE 0 END), 0) AS missing_originals`;

const BALANCE_FROM = `
  FROM documents d
  LEFT JOIN (
    SELECT document_id, SUM(amount_minor) AS paid FROM document_payments GROUP BY document_id
  ) pay ON pay.document_id = d.id`;

/** Сальдо одного контрагента — для карточки. */
const BALANCE_SELECT = `SELECT ${BALANCE_COLUMNS} ${BALANCE_FROM} WHERE d.counterparty_id = ?`;

interface Balance {
  accrued: number;
  paid: number;
  documents: number;
  missing_originals: number;
}

/** У контрагента без документов агрегат строки не вернёт, а показать нули надо. */
const EMPTY_BALANCE: Balance = { accrued: 0, paid: 0, documents: 0, missing_originals: 0 };

/**
 * Сальдо сразу по списку контрагентов. Справочник отдаётся без пагинации,
 * и отдельный запрос на каждую строку означал столько же обращений к базе,
 * сколько контрагентов в компании, — на каждое открытие экрана.
 */
function balancesOf(counterpartyIds: number[]): Map<number, Balance> {
  const byId = new Map<number, Balance>();
  if (counterpartyIds.length === 0) return byId;

  const placeholders = counterpartyIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT d.counterparty_id AS counterparty_id, ${BALANCE_COLUMNS}
       ${BALANCE_FROM}
       WHERE d.counterparty_id IN (${placeholders})
       GROUP BY d.counterparty_id`
    )
    .all(...counterpartyIds) as (Balance & { counterparty_id: number })[];

  for (const row of rows) byId.set(row.counterparty_id, row);
  return byId;
}

/** Карточка и строка списка показывают одни и те же цифры — считаются они здесь. */
function withBalance(row: CpRow, balance: Balance) {
  return {
    ...mapCp(row),
    accrued: balance.accrued,
    paid: balance.paid,
    debt: balance.accrued - balance.paid,
    documentsCount: balance.documents,
    missingOriginals: balance.missing_originals,
  };
}

/**
 * `%` и `_` в строке поиска для бухгалтера — обычные символы, а для SQLite
 * подстановочные: «ТОО_Сервис» без экранирования находит и «ТОО Сервис»,
 * и «ТОО-Сервис», а один «%» вытаскивает вообще весь справочник. Экранируем
 * сами, поэтому рядом с каждым LIKE обязан стоять тот же ESCAPE.
 */
const LIKE_ESCAPE = "ESCAPE '\\'";

function likeTerm(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

counterpartiesRouter.get('/', (req, res) => {
  const { search } = req.query as { search?: string };
  const params: unknown[] = [];
  let where = '';
  if (search && search.trim()) {
    where = `WHERE (rulower(c.name) LIKE ? ${LIKE_ESCAPE} OR c.bin LIKE ? ${LIKE_ESCAPE})`;
    const term = likeTerm(search);
    params.push(term, term);
  }
  const rows = db.prepare(`${CP_SELECT} ${where} ORDER BY c.name`).all(...params) as CpRow[];

  const balances = balancesOf(rows.map((row) => row.id));
  res.json({
    counterparties: rows.map((row) => withBalance(row, balances.get(row.id) ?? EMPTY_BALANCE)),
  });
});

counterpartiesRouter.get('/:id(\\d+)', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`${CP_SELECT} WHERE c.id = ?`).get(id) as CpRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Контрагент не найден' });
    return;
  }
  const balance = db.prepare(BALANCE_SELECT).get(id) as Balance;
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
      ...withBalance(row, balance),
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

/**
 * Контрольный разряд БИН/ИИН по алгоритму РК: взвешенная сумма первых
 * одиннадцати цифр по весам 1…11, остаток от деления на 11 — и есть
 * двенадцатая цифра. Если остаток вышел 10, счёт повторяется по второму
 * набору весов (3…11, 1, 2); второе «10» означает, что такого номера
 * не существует вовсе.
 *
 * Двенадцати цифр мало: опечатка в БИН проходит справочник насквозь, попадает
 * в счёт-фактуру и всплывает только в акте сверки, который контрагент уже
 * не признаёт своим.
 */
const BIN_WEIGHTS_FIRST = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const BIN_WEIGHTS_SECOND = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];

function binChecksumOk(bin: string): boolean {
  const digits = [...bin].map(Number);
  const control = (weights: number[]) =>
    weights.reduce((sum, weight, i) => sum + weight * digits[i], 0) % 11;

  let expected = control(BIN_WEIGHTS_FIRST);
  if (expected === 10) expected = control(BIN_WEIGHTS_SECOND);
  return expected !== 10 && expected === digits[11];
}

const BIN_CHECKSUM_ERROR = 'БИН/ИИН не проходит проверку контрольного разряда — сверьте номер';

/**
 * Ответственный обязан существовать. Ссылка на удалённого или выдуманного
 * пользователя падала нарушением внешнего ключа, то есть пятисоткой на ровном
 * месте, — форме от такого ответа толку нет.
 */
function unknownResponsible(id: number | null | undefined): boolean {
  if (id === undefined || id === null) return false;
  return db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) === undefined;
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
  // Контрольный разряд проверяется ПОСЛЕ поиска дубля: номера, заведённые до
  // появления этой проверки, в базе уже лежат, и на попытку завести такой же
  // полезнее ответить «уже заведён» со ссылкой на карточку, чем придираться
  // к разряду и прятать существующего контрагента.
  if (!binChecksumOk(bin)) {
    res.status(400).json({ error: BIN_CHECKSUM_ERROR });
    return;
  }
  const user = req.user!;
  const responsibleId = body.responsibleId ?? user.id;
  if (unknownResponsible(responsibleId)) {
    res.status(400).json({ error: 'Ответственный не найден' });
    return;
  }
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
      responsibleId,
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
  const existing = db.prepare('SELECT id, bin FROM counterparties WHERE id = ?').get(id) as
    | { id: number; bin: string }
    | undefined;
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

  // Смена БИН на уже занятый упиралась в UNIQUE и уходила пятисоткой вместо
  // внятного 409 со ссылкой на карточку, где этот БИН заведён. Неизменный БИН
  // не проверяется вовсе: контрольный разряд появился позже части справочника,
  // и старая запись иначе стала бы нередактируемой целиком — вплоть до
  // невозможности исправить в ней же опечатку в наименовании.
  if (body.bin !== undefined && body.bin.trim() !== existing.bin) {
    const bin = body.bin.trim();
    const taken = db
      .prepare('SELECT id FROM counterparties WHERE bin = ? AND id <> ?')
      .get(bin, id) as { id: number } | undefined;
    if (taken) {
      res.status(409).json({ error: 'Контрагент с таким БИН уже заведён', id: taken.id });
      return;
    }
    if (!binChecksumOk(bin)) {
      res.status(400).json({ error: BIN_CHECKSUM_ERROR });
      return;
    }
  }

  if (unknownResponsible(body.responsibleId)) {
    res.status(400).json({ error: 'Ответственный не найден' });
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
