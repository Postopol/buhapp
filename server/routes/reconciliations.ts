import { Router } from 'express';
import type { Request, Response } from 'express';
import { db, nowTimestamp, today, logAudit, isPeriodClosed } from '../db';
import { requireAuth, requireRole } from '../auth';
import type { AuthUser } from '../auth';
import { statement, BASIS_TEXT, type Statement } from '../reconciliation';
import { parseImportText, matchRows, type OurRow } from '../reconMatch';
import { csvMoney, csvRow, csvBody } from '../csv';
import {
  RECONCILIATION_TRANSITIONS,
  RECONCILIATION_STATUS_LABELS,
  LINE_MATCH_LABELS,
  RECON_ACCEPT_THRESHOLD,
  MAX_IMPORT_LINES,
  OUR_COMPANY,
  type LineMatch,
  type ReconciliationLineKind,
  type ReconciliationStatus,
} from '../../shared/domain';

export const reconciliationsRouter = Router();

reconciliationsRouter.use(requireAuth);
/**
 * Инициатор к сверке не допущен целиком. Он видит только свои документы
 * (visibilityScope в documents.ts), и акт, построенный в его области
 * видимости, с контрагентом не сошёлся бы — а несходящийся акт хуже, чем
 * никакого. Руководитель читает, но ничего не меняет.
 */
reconciliationsRouter.use(requireRole('accountant', 'chief_accountant', 'director'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-\d{2}$/;

/**
 * Закрытый месяц сверку НЕ ограничивает — и это осознанно, вопреки сквозному
 * правилу заморозки. Акт не меняет ни одной учётной цифры: он читает документы
 * и платежи и складывает переписку с контрагентом. Сверяются же как раз после
 * закрытия месяца — запрет отрезал бы главный сценарий.
 *
 * Обходным путём заморозки сверка при этом не становится: исправление
 * найденного расхождения идёт через обычные роуты документов и платежей
 * и упирается в их собственные 409.
 *
 * Вместо запрета акт отдаёт `final` — закрыты ли все месяцы диапазона.
 * Если нет, цифры под актом ещё могут поехать, и это написано на экране.
 */
function isRangeFinal(from: string, to: string): boolean {
  const months: string[] = [];
  const [fy, fm] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return months.every(isPeriodClosed);
}

function writeAllowed(res: Response, user: AuthUser): boolean {
  if (user.role === 'director') {
    res.status(403).json({ error: 'Руководителю доступен только просмотр' });
    return false;
  }
  return true;
}

// ── Чтение из БД ────────────────────────────────────────────────────────────

interface ActRow {
  id: number;
  number: string;
  counterparty_id: number;
  counterparty_name: string;
  counterparty_bin: string;
  date_from: string;
  date_to: string;
  status: ReconciliationStatus;
  opening_minor: number;
  accrued_minor: number;
  paid_minor: number;
  closing_minor: number;
  unapproved_minor: number;
  unapproved_count: number;
  unallocated_minor: number;
  excluded_minor: number;
  excluded_count: number;
  excluded_paid_minor: number;
  excluded_paid_count: number;
  their_closing_minor: number | null;
  note: string;
  responsible_user_id: number | null;
  responsible_name: string | null;
  built_at: string;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
}

const ACT_SELECT = `
  SELECT r.id, r.number, r.counterparty_id, r.date_from, r.date_to, r.status,
         r.opening_minor, r.accrued_minor, r.paid_minor, r.closing_minor,
         r.unapproved_minor, r.unapproved_count, r.unallocated_minor,
         r.excluded_minor, r.excluded_count, r.excluded_paid_minor, r.excluded_paid_count,
         r.their_closing_minor, r.note, r.responsible_user_id,
         r.built_at, r.created_by, r.created_at, r.updated_at,
         r.sent_at, r.signed_at,
         cp.name AS counterparty_name, cp.bin AS counterparty_bin,
         ru.name AS responsible_name,
         cu.name AS created_by_name,
         su.name AS signed_by_name
  FROM reconciliations r
  JOIN counterparties cp ON cp.id = r.counterparty_id
  LEFT JOIN users ru ON ru.id = r.responsible_user_id
  LEFT JOIN users cu ON cu.id = r.created_by
  LEFT JOIN users su ON su.id = r.signed_by
`;

interface LineRow {
  id: number;
  sort: number;
  kind: ReconciliationLineKind;
  document_id: number | null;
  payment_id: number | null;
  line_date: string;
  title: string;
  purpose: string;
  vat_minor: number;
  accrued_minor: number;
  paid_minor: number;
  their_amount_minor: number | null;
  their_raw: string;
  match: LineMatch;
  resolved: number;
  comment: string;
}

/**
 * Сумма строки в нашей системе координат: у начисления это начислено,
 * у оплаты — оплачено. Обе колонки одновременно ненулевыми не бывают.
 */
function ourAmount(row: { accrued_minor: number; paid_minor: number }): number {
  return row.accrued_minor + row.paid_minor;
}

/**
 * Диагноз строки выводится из цифр, а не хранится отдельным решением —
 * иначе он разъедется с суммами при первой же правке.
 */
export function verdictFor(
  kind: ReconciliationLineKind,
  ours: number,
  theirs: number | null
): LineMatch {
  if (kind === 'their') return 'only_theirs';
  if (theirs === null) return 'unknown';
  if (theirs === 0) return 'only_ours';
  if (theirs === ours) return 'match';
  return 'amount_diff';
}

/**
 * Подсказка «почему разошлось». Самый частый случай в РК — контрагент
 * показал сумму без НДС: налог уже сидит внутри amount_minor (12/112).
 */
function hintFor(row: LineRow): string {
  if (row.match === 'only_ours') {
    return row.kind === 'payment'
      ? 'Деньги ушли, а контрагент их не разнёс — пришлите платёжное поручение'
      : 'Контрагент об этом документе не знает — запросите подтверждение';
  }
  if (row.match === 'only_theirs') return 'Документа у нас нет — запросите оригинал и заведите его';
  if (row.match !== 'amount_diff' || row.their_amount_minor === null) return '';
  const delta = ourAmount(row) - row.their_amount_minor;
  if (row.vat_minor && delta === row.vat_minor) {
    return 'Расхождение в точности равно НДС — контрагент показал сумму без налога';
  }
  if (delta > 0) return 'У контрагента сумма меньше нашей';
  return 'У контрагента сумма больше нашей';
}

/** Строка требует разбора: диагноз не «сходится» и не «не сверяли». */
function needsWork(row: LineRow): boolean {
  return row.resolved === 0 && (row.match === 'amount_diff' || row.match === 'only_ours' || row.match === 'only_theirs');
}

function mapLine(row: LineRow) {
  const ours = ourAmount(row);
  return {
    id: row.id,
    kind: row.kind,
    documentId: row.document_id,
    paymentId: row.payment_id,
    date: row.line_date,
    title: row.title,
    purpose: row.purpose,
    comment: row.comment,
    accrued: row.accrued_minor,
    paid: row.paid_minor,
    vat: row.vat_minor,
    ourAmount: ours,
    theirAmount: row.their_amount_minor,
    theirRaw: row.their_raw,
    delta: row.their_amount_minor === null ? null : ours - row.their_amount_minor,
    match: row.match,
    matchLabel: LINE_MATCH_LABELS[row.match],
    resolved: row.resolved === 1,
    needsWork: needsWork(row),
    hint: hintFor(row),
  };
}

function linesOf(actId: number): LineRow[] {
  // Никаких JOIN к documents: строка обязана быть самодостаточной, иначе
  // удаление первички гасит и суммы, и подсказки в подписанном акте.
  return db
    .prepare('SELECT * FROM reconciliation_lines WHERE reconciliation_id = ? ORDER BY sort, id')
    .all(actId) as LineRow[];
}

function mapAct(row: ActRow) {
  const diff = row.their_closing_minor === null ? null : row.closing_minor - row.their_closing_minor;
  return {
    id: row.id,
    number: row.number,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    counterpartyBin: row.counterparty_bin,
    from: row.date_from,
    to: row.date_to,
    status: row.status,
    statusLabel: RECONCILIATION_STATUS_LABELS[row.status],
    opening: row.opening_minor,
    accrued: row.accrued_minor,
    paid: row.paid_minor,
    closing: row.closing_minor,
    unapproved: row.unapproved_minor,
    unapprovedCount: row.unapproved_count,
    unallocated: row.unallocated_minor,
    theirClosing: row.their_closing_minor,
    diff,
    note: row.note,
    responsibleId: row.responsible_user_id,
    responsibleName: row.responsible_name,
    builtAt: row.built_at,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    signedAt: row.signed_at,
    signedByName: row.signed_by_name,
    periodClosed: isPeriodClosed(row.date_to.slice(0, 7)),
    /** Все месяцы диапазона закрыты — цифры под актом больше не поедут. */
    final: isRangeFinal(row.date_from, row.date_to),
  };
}

function loadAct(id: number): ActRow | undefined {
  return db.prepare(`${ACT_SELECT} WHERE r.id = ?`).get(id) as ActRow | undefined;
}

/**
 * Акт ведёт ответственный за контрагента, автор акта или главбух. Чужой
 * участок трогать нельзя — иначе двое бухгалтеров молча правят один акт.
 */
function mayEdit(row: ActRow, user: AuthUser): string | null {
  if (user.role === 'chief_accountant') return null;
  if (row.created_by === user.id) return null;
  if (row.responsible_user_id === user.id) return null;
  return `Контрагент закреплён за ${row.responsible_name ?? 'другим бухгалтером'} — акт ведёт он или главный бухгалтер`;
}

// ── Снимок ──────────────────────────────────────────────────────────────────

/** Записывает расчёт в шапку и строки. Вызывается только внутри транзакции. */
function writeSnapshot(actId: number, snap: Statement, ts: string): void {
  db.prepare(
    `UPDATE reconciliations
     SET opening_minor = ?, accrued_minor = ?, paid_minor = ?, closing_minor = ?,
         unapproved_minor = ?, unapproved_count = ?, unallocated_minor = ?,
         excluded_minor = ?, excluded_count = ?, excluded_paid_minor = ?, excluded_paid_count = ?,
         built_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    snap.opening, snap.accrued, snap.paid, snap.closing,
    snap.unapproved, snap.unapprovedCount, snap.unallocated,
    snap.excluded, snap.excludedCount, snap.excludedPaid, snap.excludedPaidCount,
    ts, ts, actId
  );

  // Строки снимка пересобираются целиком; строки контрагента (kind='their')
  // — это ручной ввод, их пересборка сносить не должна.
  //
  // Уже проделанную сверку переносим на новые строки по источнику: пересборка
  // обновляет НАШИ цифры, а суммы контрагента, комментарии и отметки
  // «разобрано» — работа бухгалтера, и терять её молча нельзя.
  const previous = db
    .prepare(
      `SELECT kind, document_id, payment_id, their_amount_minor, their_raw, match, resolved, comment
       FROM reconciliation_lines WHERE reconciliation_id = ? AND kind <> 'their'`
    )
    .all(actId) as LineRow[];
  const sourceKey = (kind: string, doc: number | null, pay: number | null) => `${kind}:${doc ?? ''}:${pay ?? ''}`;
  const carried = new Map(
    previous
      .filter((p) => p.their_amount_minor !== null || p.comment !== '')
      .map((p) => [sourceKey(p.kind, p.document_id, p.payment_id), p])
  );

  db.prepare(`DELETE FROM reconciliation_lines WHERE reconciliation_id = ? AND kind <> 'their'`).run(actId);

  const insert = db.prepare(
    `INSERT INTO reconciliation_lines
       (reconciliation_id, sort, kind, document_id, payment_id, line_date, title,
        purpose, vat_minor, accrued_minor, paid_minor,
        their_amount_minor, their_raw, match, resolved, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  snap.lines.forEach((line, index) => {
    const before = carried.get(sourceKey(line.kind, line.documentId, line.paymentId));
    const ours = line.accrued + line.paid;
    const theirs = before?.their_amount_minor ?? null;
    // Диагноз пересчитывается от НОВОЙ нашей суммы: старый мог относиться
    // к цифре, которой уже нет.
    const match = verdictFor(line.kind, ours, theirs);
    const stillResolved = before && theirs !== null && verdictFor(line.kind, ours, theirs) === before.match
      ? before.resolved
      : 0;

    insert.run(
      actId, index, line.kind, line.documentId, line.paymentId,
      line.date, line.title, line.purpose, line.vat, line.accrued, line.paid,
      theirs, before?.their_raw ?? '', match, stillResolved, before?.comment ?? ''
    );
  });
}

function actPayload(row: ActRow, user: AuthUser) {
  // Один пересчёт по текущим данным закрывает сразу две задачи: дрейф снимка
  // и справочные предупреждения. Предупреждения намеренно живые, а не
  // замороженные: они говорят о том, что с первичкой сейчас.
  const now = statement(row.counterparty_id, row.date_from, row.date_to);
  const lines = linesOf(row.id);

  // Право на правку считает сервер и отдаёт готовым: на клиенте его пришлось
  // бы выводить из роли, участка и статуса заново — и оно бы разъехалось.
  const denied = mayEdit(row, user);
  const frozen = row.status === 'signed' || row.status === 'cancelled';

  return {
    ...mapAct(row),
    lines: lines.map(mapLine),
    basis: BASIS_TEXT,
    permissions: {
      edit: user.role !== 'director' && !frozen && denied === null,
      /** Почему нельзя — это показывается на экране, а не угадывается. */
      editDenied:
        user.role === 'director'
          ? 'Руководителю доступен только просмотр'
          : frozen
            ? `Акт «${RECONCILIATION_STATUS_LABELS[row.status]}» — изменить нельзя`
            : denied,
      /** Крупные расхождения закрывает только главбух. */
      resolveThreshold: RECON_ACCEPT_THRESHOLD,
      isChief: user.role === 'chief_accountant',
    },
    /**
     * Дрейф: снимок против текущих данных. Платёж можно удалить главбухом,
     * а период — переоткрыть; подписанный акт от этого не меняется, но
     * бухгалтер обязан видеть, что первичка под актом уже другая.
     */
    drift: {
      closingNow: now.closing,
      delta: now.closing - row.closing_minor,
      changed: now.closing !== row.closing_minor,
      checkedAt: nowTimestamp(),
    },
    warnings: {
      unapproved: row.unapproved_minor,
      unapprovedCount: row.unapproved_count,
      unallocated: row.unallocated_minor,
      excluded: row.excluded_minor,
      excludedCount: row.excluded_count,
      excludedPaid: row.excluded_paid_minor,
      excludedPaidCount: row.excluded_paid_count,
      duplicates: now.duplicates,
      unresolved: lines.filter(needsWork).length,
    },
    transitions: RECONCILIATION_TRANSITIONS[row.status],
    history: historyOf(row.id),
  };
}

interface AuditRow {
  id: number;
  action: string;
  user_name: string;
  details: string | null;
  created_at: string;
}

/**
 * История в том же виде, что у документа: camelCase и разобранный details.
 * Сырые строки БД клиент прочитать не может — причина перехода и автор
 * просто не отрисуются.
 */
function historyOf(actId: number) {
  const rows = db
    .prepare(
      `SELECT id, action, user_name, details, created_at
       FROM audit_log WHERE entity_type = 'reconciliation' AND entity_id = ?
       ORDER BY id DESC`
    )
    // entity_id — TEXT: без String(id) SQLite сравнит число с текстом и вернёт пусто.
    .all(String(actId)) as AuditRow[];

  return rows.map((h) => ({
    id: h.id,
    action: h.action,
    userName: h.user_name,
    details: h.details ? (JSON.parse(h.details) as unknown) : null,
    createdAt: h.created_at,
  }));
}

// ── Реестр ──────────────────────────────────────────────────────────────────

reconciliationsRouter.get('/', (req, res) => {
  const { counterparty, status, period } = req.query as {
    counterparty?: string;
    status?: string;
    period?: string;
  };
  const conditions: string[] = ['1 = 1'];
  const params: unknown[] = [];

  if (counterparty && counterparty !== 'all') {
    conditions.push('r.counterparty_id = ?');
    params.push(Number(counterparty));
  }
  if (status && status !== 'all' && status in RECONCILIATION_STATUS_LABELS) {
    conditions.push('r.status = ?');
    params.push(status);
  }
  if (period && PERIOD_RE.test(period)) {
    // Акт попадает в месяц, если пересекается с ним хотя бы днём.
    conditions.push('r.date_from <= ? AND r.date_to >= ?');
    params.push(`${period}-31`, `${period}-01`);
  }

  const where = conditions.join(' AND ');
  const rows = db
    .prepare(`${ACT_SELECT} WHERE ${where} ORDER BY r.date_to DESC, r.id DESC LIMIT 300`)
    .all(...params) as ActRow[];

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN r.status = 'disputed' THEN 1 ELSE 0 END), 0) AS disputed,
              COALESCE(SUM(CASE WHEN r.status = 'signed' THEN 1 ELSE 0 END), 0) AS signed
       FROM reconciliations r WHERE ${where}`
    )
    .get(...params) as { count: number; disputed: number; signed: number };

  res.json({ acts: rows.map(mapAct), total: totals.count, disputed: totals.disputed, signed: totals.signed });
});

/** Сводка для экрана закрытия месяца: что со сверкой в этом периоде. */
reconciliationsRouter.get('/summary', (req, res) => {
  const period = (req.query.period as string) || today().slice(0, 7);
  if (!PERIOD_RE.test(period)) {
    res.status(400).json({ error: 'Некорректный период' });
    return;
  }
  const acts = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM reconciliations
       WHERE date_from <= ? AND date_to >= ? AND status <> 'cancelled'
       GROUP BY status`
    )
    .all(`${period}-31`, `${period}-01`) as { status: ReconciliationStatus; count: number }[];

  const byStatus = Object.fromEntries(acts.map((a) => [a.status, a.count])) as Record<string, number>;

  // Контрагенты с ненулевым долгом, по которым акта за период нет вообще —
  // именно они и есть незакрытая работа.
  const uncovered = db
    .prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT d.counterparty_id
         FROM documents d
         LEFT JOIN (
           SELECT document_id, SUM(amount_minor) AS paid FROM document_payments GROUP BY document_id
         ) pay ON pay.document_id = d.id
         WHERE d.counterparty_id IS NOT NULL AND d.approval_status <> 'rejected'
         GROUP BY d.counterparty_id
         HAVING SUM(d.amount_minor) - COALESCE(SUM(COALESCE(pay.paid, 0)), 0) <> 0
       ) debtors
       WHERE debtors.counterparty_id NOT IN (
         SELECT counterparty_id FROM reconciliations
         WHERE date_from <= ? AND date_to >= ? AND status <> 'cancelled'
       )`
    )
    .get(`${period}-31`, `${period}-01`) as { count: number };

  res.json({
    summary: {
      period,
      total: acts.reduce((sum, a) => sum + a.count, 0),
      draft: byStatus.draft ?? 0,
      sent: byStatus.sent ?? 0,
      signed: byStatus.signed ?? 0,
      disputed: byStatus.disputed ?? 0,
      debtorsWithoutAct: uncovered.count,
    },
  });
});

/** Расчёт без сохранения — посмотреть, что получится, до заведения акта. */
reconciliationsRouter.get('/preview', (req, res) => {
  const { counterparty, from, to } = req.query as { counterparty?: string; from?: string; to?: string };
  const error = validateRange(counterparty, from, to);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  res.json({ statement: statement(Number(counterparty), from!, to!) });
});

function validateRange(counterparty?: string, from?: string, to?: string): string | null {
  if (!counterparty || !Number.isInteger(Number(counterparty))) return 'Не выбран контрагент';
  if (!from || !DATE_RE.test(from) || !to || !DATE_RE.test(to)) return 'Некорректный период сверки';
  if (from > to) return 'Начало периода позже конца';
  const exists = db.prepare('SELECT id FROM counterparties WHERE id = ?').get(Number(counterparty));
  if (!exists) return 'Контрагент не найден';
  return null;
}

// ── Формирование ────────────────────────────────────────────────────────────

/**
 * Номер вида АС-2026-001. Счётчик годовой, выдаётся внутри транзакции.
 * Считаем от максимума, а не от количества: после удаления акта COUNT
 * откатывается и выдал бы уже занятый номер — UNIQUE упал бы в 500.
 */
function nextNumber(year: string): string {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(substr(number, ?) AS INTEGER)), 0) AS last
       FROM reconciliations WHERE number LIKE ?`
    )
    .get(`АС-${year}-`.length + 1, `АС-${year}-%`) as { last: number };
  return `АС-${year}-${String(row.last + 1).padStart(3, '0')}`;
}

reconciliationsRouter.post('/', (req, res) => {
  const user = req.user!;
  if (!writeAllowed(res, user)) return;

  const { counterpartyId, from, to } = req.body as {
    counterpartyId?: number;
    from?: string;
    to?: string;
  };
  const error = validateRange(String(counterpartyId), from, to);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const duplicate = db
    .prepare(
      `SELECT id, number FROM reconciliations
       WHERE counterparty_id = ? AND date_from = ? AND date_to = ? AND status <> 'cancelled'`
    )
    .get(counterpartyId, from, to) as { id: number; number: string } | undefined;
  if (duplicate) {
    res.status(409).json({ error: `Акт за этот период уже есть — ${duplicate.number}`, id: duplicate.id });
    return;
  }

  const responsible = db
    .prepare('SELECT responsible_user_id FROM counterparties WHERE id = ?')
    .get(counterpartyId) as { responsible_user_id: number | null };

  const ts = nowTimestamp();
  const snap = statement(Number(counterpartyId), from!, to!);

  const id = db.transaction(() => {
    const number = nextNumber(to!.slice(0, 4));
    const info = db
      .prepare(
        `INSERT INTO reconciliations
           (number, counterparty_id, date_from, date_to, status,
            opening_minor, accrued_minor, paid_minor, closing_minor,
            responsible_user_id, built_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', 0, 0, 0, 0, ?, ?, ?, ?, ?)`
      )
      .run(number, counterpartyId, from, to, responsible.responsible_user_id ?? user.id, ts, user.id, ts, ts);
    const actId = Number(info.lastInsertRowid);
    writeSnapshot(actId, snap, ts);
    return actId;
  })();

  logAudit({
    entityType: 'reconciliation',
    entityId: id,
    action: 'created',
    userId: user.id,
    userName: user.name,
    details: { counterpartyId, from, to, closing: snap.closing },
  });

  res.status(201).json({ act: actPayload(loadAct(id)!, user) });
});

reconciliationsRouter.get('/:id(\\d+)', (req, res) => {
  const row = loadAct(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Акт сверки не найден' });
    return;
  }
  res.json({ act: actPayload(row, req.user!) });
});

reconciliationsRouter.post('/:id(\\d+)/rebuild', (req, res) => {
  const user = req.user!;
  if (!writeAllowed(res, user)) return;

  const row = loadAct(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Акт сверки не найден' });
    return;
  }
  const denied = mayEdit(row, user);
  if (denied) {
    res.status(403).json({ error: denied });
    return;
  }
  if (row.status !== 'draft') {
    res.status(409).json({
      error: 'Акт уже отправлен контрагенту — снимок пересобрать нельзя, сформируйте новый акт',
    });
    return;
  }

  const ts = nowTimestamp();
  const snap = statement(row.counterparty_id, row.date_from, row.date_to);
  db.transaction(() => writeSnapshot(row.id, snap, ts))();

  logAudit({
    entityType: 'reconciliation',
    entityId: row.id,
    action: 'rebuilt',
    userId: user.id,
    userName: user.name,
    details: { was: row.closing_minor, now: snap.closing },
  });

  res.json({ act: actPayload(loadAct(row.id)!, user) });
});

// ── Данные контрагента ──────────────────────────────────────────────────────

reconciliationsRouter.patch('/:id(\\d+)', (req, res) => {
  const user = req.user!;
  if (!writeAllowed(res, user)) return;

  const row = loadAct(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Акт сверки не найден' });
    return;
  }
  const denied = mayEdit(row, user);
  if (denied) {
    res.status(403).json({ error: denied });
    return;
  }
  if (row.status === 'signed' || row.status === 'cancelled') {
    res.status(409).json({ error: `Акт «${RECONCILIATION_STATUS_LABELS[row.status]}» — изменить нельзя` });
    return;
  }

  const { theirClosing, note } = req.body as { theirClosing?: number | null; note?: string };
  const fields: Record<string, unknown> = {};
  if (theirClosing !== undefined) {
    if (theirClosing !== null && !Number.isInteger(theirClosing)) {
      res.status(400).json({ error: 'Сальдо контрагента должно быть целым числом тиын' });
      return;
    }
    fields.their_closing_minor = theirClosing;
  }
  if (note !== undefined) fields.note = String(note).slice(0, 2000);

  const keys = Object.keys(fields);
  if (keys.length) {
    fields.updated_at = nowTimestamp();
    const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE reconciliations SET ${setSql} WHERE id = ?`).run(...Object.values(fields), row.id);
    logAudit({
      entityType: 'reconciliation',
      entityId: row.id,
      action: 'their_balance',
      userId: user.id,
      userName: user.name,
      details: {
        theirClosing: theirClosing ?? null,
        delta: theirClosing == null ? null : row.closing_minor - theirClosing,
      },
    });
  }

  res.json({ act: actPayload(loadAct(row.id)!, user) });
});

/** Общие проверки для правки строк. */
function lineGuard(req: Request, res: Response): ActRow | null {
  const user = req.user!;
  if (!writeAllowed(res, user)) return null;

  const row = loadAct(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Акт сверки не найден' });
    return null;
  }
  const denied = mayEdit(row, user);
  if (denied) {
    res.status(403).json({ error: denied });
    return null;
  }
  if (row.status === 'signed' || row.status === 'cancelled') {
    res.status(409).json({ error: `Акт «${RECONCILIATION_STATUS_LABELS[row.status]}» — изменить нельзя` });
    return null;
  }
  return row;
}

reconciliationsRouter.patch('/:id(\\d+)/lines/:lineId(\\d+)', (req, res) => {
  const act = lineGuard(req, res);
  if (!act) return;

  const lineId = Number(req.params.lineId);
  const line = db
    .prepare('SELECT * FROM reconciliation_lines WHERE id = ? AND reconciliation_id = ?')
    .get(lineId, act.id) as LineRow | undefined;
  if (!line) {
    res.status(404).json({ error: 'Строка не найдена' });
    return;
  }

  const { theirAmount, comment } = req.body as { theirAmount?: number | null; comment?: string };
  if (theirAmount !== undefined && theirAmount !== null && !Number.isInteger(theirAmount)) {
    res.status(400).json({ error: 'Сумма контрагента должна быть целым числом тиын' });
    return;
  }

  const nextTheirs = theirAmount === undefined ? line.their_amount_minor : theirAmount;
  const match = verdictFor(line.kind, ourAmount(line), nextTheirs);

  // Разбор снимается, только если цифра ДЕЙСТВИТЕЛЬНО поменялась: решение
  // принималось по прежней сумме. Клиент шлёт theirAmount всегда, поэтому
  // судить по наличию поля нельзя — иначе правка комментария сбрасывала бы
  // отметку «разобрано».
  const keepResolved = nextTheirs === line.their_amount_minor ? line.resolved : 0;

  db.prepare(
    `UPDATE reconciliation_lines
     SET their_amount_minor = ?, match = ?, comment = ?, resolved = ?
     WHERE id = ?`
  ).run(
    nextTheirs,
    match,
    comment === undefined ? line.comment : String(comment).slice(0, 500),
    keepResolved,
    lineId
  );
  db.prepare('UPDATE reconciliations SET updated_at = ? WHERE id = ?').run(nowTimestamp(), act.id);

  logAudit({
    entityType: 'reconciliation',
    entityId: act.id,
    action: 'line_matched',
    userId: req.user!.id,
    userName: req.user!.name,
    details: { line: lineId, title: line.title, theirAmount: nextTheirs, match },
  });

  res.json({ act: actPayload(loadAct(act.id)!, req.user!) });
});

/**
 * «Разобрано»: расхождение объяснено и закрыто. Обязателен текст решения —
 * галочка без объяснения через месяц ничего не значит.
 */
reconciliationsRouter.post('/:id(\\d+)/lines/:lineId(\\d+)/resolve', (req, res) => {
  const act = lineGuard(req, res);
  if (!act) return;

  const lineId = Number(req.params.lineId);
  const line = db
    .prepare('SELECT * FROM reconciliation_lines WHERE id = ? AND reconciliation_id = ?')
    .get(lineId, act.id) as LineRow | undefined;
  if (!line) {
    res.status(404).json({ error: 'Строка не найдена' });
    return;
  }

  const { comment, resolved } = req.body as { comment?: string; resolved?: boolean };
  const next = resolved === false ? 0 : 1;

  if (next === 1) {
    if (!(comment ?? line.comment).trim()) {
      res.status(400).json({ error: 'Напишите, что решили по этому расхождению' });
      return;
    }
    const delta = Math.abs(ourAmount(line) - (line.their_amount_minor ?? 0));
    if (delta >= RECON_ACCEPT_THRESHOLD && req.user!.role !== 'chief_accountant') {
      res.status(403).json({
        error: `Расхождение больше ${(RECON_ACCEPT_THRESHOLD / 100).toLocaleString('ru-KZ')} ₸ — закрыть его может только главный бухгалтер`,
      });
      return;
    }
  }

  db.prepare('UPDATE reconciliation_lines SET resolved = ?, comment = ? WHERE id = ?').run(
    next,
    comment === undefined ? line.comment : String(comment).slice(0, 500),
    lineId
  );
  db.prepare('UPDATE reconciliations SET updated_at = ? WHERE id = ?').run(nowTimestamp(), act.id);

  logAudit({
    entityType: 'reconciliation',
    entityId: act.id,
    action: next === 1 ? 'line_resolved' : 'line_reopened',
    userId: req.user!.id,
    userName: req.user!.name,
    details: { line: lineId, title: line.title, comment },
  });

  res.json({ act: actPayload(loadAct(act.id)!, req.user!) });
});

/** Строка «есть у контрагента, у нас нет» — вводится руками. */
reconciliationsRouter.post('/:id(\\d+)/lines', (req, res) => {
  const act = lineGuard(req, res);
  if (!act) return;

  const { date, title, theirAmount, comment } = req.body as {
    date?: string;
    title?: string;
    theirAmount?: number;
    comment?: string;
  };
  if (!date || !DATE_RE.test(date)) {
    res.status(400).json({ error: 'Укажите дату строки' });
    return;
  }
  if (!title || !title.trim()) {
    res.status(400).json({ error: 'Укажите документ контрагента' });
    return;
  }
  if (!Number.isInteger(theirAmount) || (theirAmount as number) <= 0) {
    res.status(400).json({ error: 'Сумма по данным контрагента должна быть положительным числом' });
    return;
  }

  const maxSort = db
    .prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM reconciliation_lines WHERE reconciliation_id = ?')
    .get(act.id) as { m: number };

  const info = db
    .prepare(
      `INSERT INTO reconciliation_lines
         (reconciliation_id, sort, kind, document_id, payment_id, line_date, title,
          purpose, vat_minor, accrued_minor, paid_minor, their_amount_minor, their_raw, match, comment)
       VALUES (?, ?, 'their', NULL, NULL, ?, ?, '', 0, 0, 0, ?, '', 'only_theirs', ?)`
    )
    .run(act.id, maxSort.m + 1, date, title.trim().slice(0, 200), theirAmount, (comment ?? '').slice(0, 500));

  db.prepare('UPDATE reconciliations SET updated_at = ? WHERE id = ?').run(nowTimestamp(), act.id);
  logAudit({
    entityType: 'reconciliation',
    entityId: act.id,
    action: 'line_added',
    userId: req.user!.id,
    userName: req.user!.name,
    details: { title, theirAmount },
  });

  res.status(201).json({ act: actPayload(loadAct(act.id)!, req.user!), lineId: Number(info.lastInsertRowid) });
});

/**
 * Выписка контрагента текстом: бухгалтер вставляет то, что пришло письмом
 * или из Excel, а система сама раскладывает суммы по строкам акта. Ручной
 * ввод остаётся — но переписывать полсотни строк руками никто не станет.
 */
reconciliationsRouter.post('/:id(\\d+)/import', (req, res) => {
  const act = lineGuard(req, res);
  if (!act) return;

  const { text, defaultKind } = req.body as { text?: string; defaultKind?: 'accrued' | 'paid' };
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Вставьте данные контрагента' });
    return;
  }

  const parsed = parseImportText(text, defaultKind === 'paid' ? 'paid' : 'accrued');
  if (parsed.rows.length > MAX_IMPORT_LINES) {
    res.status(400).json({ error: `За раз принимаем не больше ${MAX_IMPORT_LINES} строк` });
    return;
  }
  if (parsed.rows.length === 0) {
    res.status(400).json({
      error: 'Не удалось разобрать ни одной строки — нужны колонки «дата, номер, сумма»',
      skipped: parsed.skipped,
    });
    return;
  }

  const ourLines = linesOf(act.id).filter((l) => l.kind !== 'their');
  const ours: OurRow[] = ourLines.map((l) => ({
    id: l.id,
    kind: l.kind as 'document' | 'payment',
    date: l.line_date,
    title: l.title,
    amount: ourAmount(l),
  }));

  const result = matchRows(ours, parsed.rows);
  const byId = new Map(ourLines.map((l) => [l.id, l]));
  const ts = nowTimestamp();

  db.transaction(() => {
    // Импорт заменяет прошлый результат сопоставления: иначе строки от
    // предыдущей, уже неверной выписки останутся висеть расхождениями.
    // Но сносим только то, что пришло импортом (`their_raw` заполнен) —
    // строки, заведённые бухгалтером руками, это его работа, а не выписка.
    db.prepare(
      `DELETE FROM reconciliation_lines
       WHERE reconciliation_id = ? AND kind = 'their' AND their_raw <> ''`
    ).run(act.id);
    db.prepare(
      `UPDATE reconciliation_lines
       SET their_amount_minor = NULL, match = 'unknown', their_raw = '', resolved = 0
       WHERE reconciliation_id = ? AND kind <> 'their'`
    ).run(act.id);

    const updateOurs = db.prepare(
      'UPDATE reconciliation_lines SET their_amount_minor = ?, match = ?, their_raw = ? WHERE id = ?'
    );
    const maxSort = db
      .prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM reconciliation_lines WHERE reconciliation_id = ?')
      .get(act.id) as { m: number };
    const insertTheirs = db.prepare(
      `INSERT INTO reconciliation_lines
         (reconciliation_id, sort, kind, document_id, payment_id, line_date, title,
          purpose, vat_minor, accrued_minor, paid_minor, their_amount_minor, their_raw, match, comment)
       VALUES (?, ?, 'their', NULL, NULL, ?, ?, 'Из выписки контрагента', 0, 0, 0, ?, ?, 'only_theirs', '')`
    );

    let extra = maxSort.m;
    for (const pair of result.pairs) {
      if (pair.ourId !== null) {
        const line = byId.get(pair.ourId)!;
        updateOurs.run(
          pair.theirAmount,
          verdictFor(line.kind, ourAmount(line), pair.theirAmount),
          pair.their.raw,
          pair.ourId
        );
      } else {
        extra += 1;
        insertTheirs.run(
          act.id,
          extra,
          pair.their.date ?? act.date_from,
          pair.their.number.slice(0, 200),
          pair.theirAmount,
          pair.their.raw
        );
      }
    }
    // Наши строки, которых у контрагента не оказалось: он о них не знает.
    const markMissing = db.prepare(
      `UPDATE reconciliation_lines SET their_amount_minor = 0, match = 'only_ours' WHERE id = ?`
    );
    for (const id of result.unmatchedOurs) markMissing.run(id);

    db.prepare('UPDATE reconciliations SET updated_at = ? WHERE id = ?').run(ts, act.id);
  })();

  logAudit({
    entityType: 'reconciliation',
    entityId: act.id,
    action: 'imported',
    userId: req.user!.id,
    userName: req.user!.name,
    details: { parsed: parsed.rows.length, skipped: parsed.skipped.length, onlyTheirs: result.pairs.filter((p) => p.ourId === null).length },
  });

  res.json({
    act: actPayload(loadAct(act.id)!, req.user!),
    parsed: { rows: parsed.rows.length, skipped: parsed.skipped },
  });
});

reconciliationsRouter.delete('/:id(\\d+)/lines/:lineId(\\d+)', (req, res) => {
  const act = lineGuard(req, res);
  if (!act) return;

  const lineId = Number(req.params.lineId);
  const line = db
    .prepare('SELECT id, kind, title FROM reconciliation_lines WHERE id = ? AND reconciliation_id = ?')
    .get(lineId, act.id) as { id: number; kind: ReconciliationLineKind; title: string } | undefined;
  if (!line) {
    res.status(404).json({ error: 'Строка не найдена' });
    return;
  }
  // Строку снимка руками не убрать — она отражает наши данные, а не мнение о них.
  if (line.kind !== 'their') {
    res.status(409).json({ error: 'Удалить можно только строку, добавленную по данным контрагента' });
    return;
  }

  db.prepare('DELETE FROM reconciliation_lines WHERE id = ?').run(lineId);
  db.prepare('UPDATE reconciliations SET updated_at = ? WHERE id = ?').run(nowTimestamp(), act.id);
  logAudit({
    entityType: 'reconciliation',
    entityId: act.id,
    action: 'line_deleted',
    userId: req.user!.id,
    userName: req.user!.name,
    details: { line: lineId, title: line.title },
  });
  res.json({ act: actPayload(loadAct(act.id)!, req.user!) });
});

// ── Жизненный цикл ──────────────────────────────────────────────────────────

reconciliationsRouter.post('/:id(\\d+)/transition', (req, res) => {
  const user = req.user!;
  if (!writeAllowed(res, user)) return;

  const row = loadAct(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Акт сверки не найден' });
    return;
  }
  const { to, comment } = req.body as { to?: ReconciliationStatus; comment?: string };
  const move = RECONCILIATION_TRANSITIONS[row.status].find((t) => t.to === to);
  if (!move) {
    res.status(403).json({ error: `Из статуса «${RECONCILIATION_STATUS_LABELS[row.status]}» такой переход недоступен` });
    return;
  }
  if (!move.roles.includes(user.role)) {
    res.status(403).json({ error: 'Недостаточно прав для этого перехода' });
    return;
  }
  if (move.requiresComment && !(comment ?? '').trim()) {
    res.status(403).json({ error: 'Нужно указать причину' });
    return;
  }
  const denied = mayEdit(row, user);
  if (denied) {
    res.status(403).json({ error: denied });
    return;
  }

  if (to === 'signed') {
    // Из «расхождений» подписывают именно с протоколом: сальдо там расходится
    // по определению, и требовать его совпадения значило бы запретить переход
    // вовсе. Гарантия на этом пути другая — каждое расхождение разобрано
    // и объяснено, и это проверяется ниже для обоих путей.
    if (
      row.status !== 'disputed' &&
      row.their_closing_minor !== null &&
      row.their_closing_minor !== row.closing_minor
    ) {
      const delta = (row.closing_minor - row.their_closing_minor) / 100;
      res.status(409).json({
        error: `Сальдо контрагента отличается на ${delta.toLocaleString('ru-KZ')} ₸ — снимите расхождение или зафиксируйте протокол`,
      });
      return;
    }
    const unresolved = linesOf(row.id).filter(needsWork);
    if (unresolved.length > 0) {
      res.status(409).json({
        error: `Не разобрано расхождений: ${unresolved.length} (${unresolved.slice(0, 3).map((l) => l.title).join(', ')}${unresolved.length > 3 ? '…' : ''})`,
      });
      return;
    }
  }
  if (to === 'disputed') {
    if (row.their_closing_minor === null) {
      res.status(400).json({ error: 'Сначала внесите сальдо по данным контрагента' });
      return;
    }
    if (row.their_closing_minor === row.closing_minor) {
      res.status(400).json({ error: 'Расхождений нет — акт подписывается без протокола' });
      return;
    }
  }

  const ts = nowTimestamp();
  db.transaction(() => {
    const fields: Record<string, unknown> = { status: to, updated_at: ts };
    if (to === 'sent') {
      fields.sent_at = ts;
      // Подпись снимается вместе с возвратом в «отправлен».
      fields.signed_at = null;
      fields.signed_by = null;
    }
    if (to === 'signed') {
      fields.signed_at = ts;
      fields.signed_by = user.id;
    }
    const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE reconciliations SET ${setSql} WHERE id = ?`).run(...Object.values(fields), row.id);
  })();

  logAudit({
    entityType: 'reconciliation',
    entityId: row.id,
    action: 'transition',
    userId: user.id,
    userName: user.name,
    details: { from: row.status, to, comment: (comment ?? '').trim() || undefined },
  });

  res.json({ act: actPayload(loadAct(row.id)!, user) });
});

reconciliationsRouter.delete('/:id(\\d+)', requireRole('chief_accountant'), (req, res) => {
  const row = loadAct(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Акт сверки не найден' });
    return;
  }
  if (row.status !== 'draft') {
    res.status(409).json({ error: 'Отправленный акт не удаляется — аннулируйте его' });
    return;
  }

  db.prepare('DELETE FROM reconciliations WHERE id = ?').run(row.id);
  logAudit({
    entityType: 'reconciliation',
    entityId: row.id,
    action: 'deleted',
    userId: req.user!.id,
    userName: req.user!.name,
    details: { number: row.number },
  });
  res.json({ ok: true });
});

// ── Печатная форма ──────────────────────────────────────────────────────────

reconciliationsRouter.get('/:id(\\d+)/export.csv', (req, res) => {
  const row = loadAct(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Акт сверки не найден' });
    return;
  }
  const lines = linesOf(row.id);

  const money = csvMoney;
  const out: string[] = [];
  const push = (...cells: unknown[]) => out.push(csvRow(cells));

  push(`Акт сверки взаиморасчётов ${row.number}`);
  push(`за период с ${row.date_from} по ${row.date_to}`);
  push('');
  push('Сторона 1', OUR_COMPANY.name, `БИН ${OUR_COMPANY.bin}`);
  push('Сторона 2', row.counterparty_name, `БИН ${row.counterparty_bin}`);
  push('');
  push('Суммы в тенге. Положительное сальдо — задолженность Стороны 1 перед Стороной 2.');
  push(BASIS_TEXT);
  push('');
  push('Дата', 'Вид', 'Документ', 'Расшифровка', 'Начислено', 'Оплачено', 'По данным контрагента', 'Расхождение', 'Диагноз', 'Комментарий');
  push('', '', 'Сальдо на начало периода', '', money(row.opening_minor), '', '', '', '', '');

  for (const line of lines) {
    const ours = ourAmount(line);
    push(
      line.line_date,
      line.kind === 'document' ? 'Документ' : line.kind === 'payment' ? 'Оплата' : 'Данные контрагента',
      line.title,
      line.purpose,
      line.accrued_minor ? money(line.accrued_minor) : '',
      line.paid_minor ? money(line.paid_minor) : '',
      line.their_amount_minor === null ? '' : money(line.their_amount_minor),
      line.their_amount_minor === null ? '' : money(ours - line.their_amount_minor),
      LINE_MATCH_LABELS[line.match],
      line.resolved ? `Разобрано: ${line.comment}` : line.comment || hintFor(line)
    );
  }

  push('', '', 'Обороты за период', '', money(row.accrued_minor), money(row.paid_minor), '', '', '', '');
  push('', '', 'Сальдо на конец периода', '', money(row.closing_minor), '', '', '', '', '');
  if (row.their_closing_minor !== null) {
    push('', '', 'Сальдо по данным контрагента', '', money(row.their_closing_minor), '', '', '', '', '');
    push('', '', 'Расхождение', '', money(row.closing_minor - row.their_closing_minor), '', '', '', '', '');
  }
  push('');
  push('Сформирован', row.built_at, 'Статус', RECONCILIATION_STATUS_LABELS[row.status]);
  push('');
  push('От Стороны 1', '____________________', 'От Стороны 2', '____________________');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // Номер акта кириллический, а в заголовок можно только ASCII: латинское имя
  // как запасное плюс filename* по RFC 5987 для тех, кто его понимает.
  const readable = encodeURIComponent(`Акт сверки ${row.number}.csv`);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="reconciliation-${row.id}.csv"; filename*=UTF-8''${readable}`
  );
  res.send(csvBody(out));
});
