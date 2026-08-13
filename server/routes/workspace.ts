import { Router } from 'express';
import { db, today, currentPeriod } from '../db';
import { requireAuth } from '../auth';
import type { AuthUser } from '../auth';
import { CHIEF_APPROVAL_THRESHOLD, ACCOUNTING_ROLES } from '../../shared/domain';
import { upcomingDeadlines } from './taxes';

export const workspaceRouter = Router();

workspaceRouter.use(requireAuth);

/** Смещение от сегодня в днях в формате YYYY-MM-DD. */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PAID_JOIN = `
  LEFT JOIN (
    SELECT document_id, SUM(amount_minor) AS paid FROM document_payments GROUP BY document_id
  ) pay ON pay.document_id = d.id
`;

interface Bucket {
  count: number;
  amount: number;
}

function measure(where: string, params: unknown[]): Bucket {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(d.amount_minor), 0) AS amount
       FROM documents d ${PAID_JOIN} WHERE ${where}`
    )
    .get(...params) as Bucket;
  return row;
}

/** Ограничение видимости: инициатор живёт только внутри своих документов. */
function scope(user: AuthUser): { sql: string; params: unknown[] } {
  if (user.role === 'initiator') return { sql: 'd.created_by = ?', params: [user.id] };
  return { sql: '1 = 1', params: [] };
}

interface QueueDef {
  key: string;
  title: string;
  hint: string;
  tone: 'urgent' | 'attention' | 'normal';
  where: string;
  params: unknown[];
  /** Параметры, с которыми откроется реестр по клику. */
  filter: Record<string, string>;
}

function buildQueues(user: AuthUser): QueueDef[] {
  const s = scope(user);
  const queues: QueueDef[] = [];
  const wrap = (sql: string, params: unknown[] = []) => ({
    where: `${s.sql} AND (${sql})`,
    params: [...s.params, ...params],
  });

  if (user.role === 'accountant' || user.role === 'chief_accountant') {
    // Главбух видит очередь того, что может согласовать только он.
    if (user.role === 'chief_accountant') {
      queues.push({
        key: 'my-approval',
        title: 'Ждут моего согласования',
        hint: `Крупные документы — от ${(CHIEF_APPROVAL_THRESHOLD / 100).toLocaleString('ru-KZ')} ₸`,
        tone: 'urgent',
        ...wrap(`d.approval_status = 'review' AND d.amount_minor >= ?`, [CHIEF_APPROVAL_THRESHOLD]),
        filter: { approval: 'review' },
      });
      queues.push({
        key: 'review-all',
        title: 'Все документы на проверке',
        hint: 'Вся очередь согласования по компании',
        tone: 'normal',
        ...wrap(`d.approval_status = 'review'`),
        filter: { approval: 'review' },
      });
    } else {
      queues.push({
        key: 'my-approval',
        title: 'Ждут моей проверки',
        hint: 'Документы моего участка в статусе «на проверке»',
        tone: 'urgent',
        ...wrap(`d.approval_status = 'review' AND (d.responsible_user_id = ? OR d.section = ?)`, [
          user.id,
          user.section ?? '',
        ]),
        filter: { approval: 'review', mine: 'true' },
      });
    }

    queues.push({
      key: 'overdue',
      title: 'Просрочена оплата',
      hint: 'Срок прошёл, деньги не ушли',
      tone: 'urgent',
      ...wrap(
        `d.due_date IS NOT NULL AND d.due_date < ? AND d.approval_status <> 'rejected' AND COALESCE(pay.paid, 0) < d.amount_minor`,
        [today()]
      ),
      filter: { overdue: 'true' },
    });

    queues.push({
      key: 'due-soon',
      title: 'Оплатить на этой неделе',
      hint: 'Согласовано, срок в ближайшие 7 дней',
      tone: 'attention',
      ...wrap(
        `d.approval_status = 'approved' AND d.due_date IS NOT NULL AND d.due_date >= ? AND d.due_date <= ? AND COALESCE(pay.paid, 0) < d.amount_minor`,
        [today(), inDays(7)]
      ),
      filter: { approval: 'approved', payment: 'unpaid' },
    });

    queues.push({
      key: 'missing-originals',
      title: 'Нет оригинала',
      hint: 'Документ в работе или уже оплачен, а бумаги нет',
      tone: 'attention',
      ...wrap(`d.original_status = 'none' AND d.approval_status <> 'rejected'`),
      filter: { original: 'none' },
    });

    queues.push({
      key: 'not-posted',
      title: 'Не проведены в учёте',
      hint: 'Согласованы, но в учётную систему не переданы',
      tone: 'normal',
      ...wrap(`d.approval_status = 'approved' AND d.posting_status = 'not_posted'`),
      filter: { approval: 'approved', posting: 'not_posted' },
    });
  }

  if (user.role === 'initiator') {
    queues.push({
      key: 'returned',
      title: 'Возвращено на доработку',
      hint: 'Бухгалтерия просит исправить — без этого оплаты не будет',
      tone: 'urgent',
      ...wrap(`d.approval_status = 'returned'`),
      filter: { approval: 'returned' },
    });
    queues.push({
      key: 'drafts',
      title: 'Мои черновики',
      hint: 'Заведены, но не отправлены на проверку',
      tone: 'attention',
      ...wrap(`d.approval_status = 'draft'`),
      filter: { approval: 'draft' },
    });
    queues.push({
      key: 'in-review',
      title: 'На проверке в бухгалтерии',
      hint: 'Ждут решения — от вас ничего не требуется',
      tone: 'normal',
      ...wrap(`d.approval_status = 'review'`),
      filter: { approval: 'review' },
    });
    queues.push({
      key: 'unpaid',
      title: 'Согласовано, ждёт оплаты',
      hint: 'Деньги ещё не ушли поставщику',
      tone: 'normal',
      ...wrap(`d.approval_status = 'approved' AND COALESCE(pay.paid, 0) < d.amount_minor`),
      filter: { approval: 'approved', payment: 'unpaid' },
    });
  }

  if (user.role === 'director') {
    queues.push({
      key: 'review-all',
      title: 'В работе у бухгалтерии',
      hint: 'Документы на согласовании',
      tone: 'attention',
      ...wrap(`d.approval_status = 'review'`),
      filter: { approval: 'review' },
    });
    queues.push({
      key: 'overdue',
      title: 'Просрочена оплата',
      hint: 'Срок прошёл, деньги не ушли',
      tone: 'urgent',
      ...wrap(
        `d.due_date IS NOT NULL AND d.due_date < ? AND d.approval_status <> 'rejected' AND COALESCE(pay.paid, 0) < d.amount_minor`,
        [today()]
      ),
      filter: { overdue: 'true' },
    });
    queues.push({
      key: 'unpaid',
      title: 'Согласовано к оплате',
      hint: 'Обязательства, по которым деньги ещё не ушли',
      tone: 'normal',
      ...wrap(`d.approval_status = 'approved' AND COALESCE(pay.paid, 0) < d.amount_minor`),
      filter: { approval: 'approved', payment: 'unpaid' },
    });
  }

  return queues;
}

workspaceRouter.get('/', (req, res) => {
  const user = req.user!;
  const s = scope(user);

  const queues = buildQueues(user).map((q) => {
    const bucket = measure(q.where, q.params);
    return {
      key: q.key,
      title: q.title,
      hint: q.hint,
      tone: q.tone,
      count: bucket.count,
      amount: bucket.amount,
      filter: q.filter,
    };
  });

  const period = currentPeriod();
  const periodStats = db
    .prepare(
      `SELECT
         COUNT(*) AS documents,
         COALESCE(SUM(d.amount_minor), 0) AS amount,
         COALESCE(SUM(d.vat_minor), 0) AS vat,
         COALESCE(SUM(CASE WHEN d.posting_status = 'not_posted' THEN 1 ELSE 0 END), 0) AS not_posted,
         COALESCE(SUM(CASE WHEN d.original_status = 'none' THEN 1 ELSE 0 END), 0) AS missing_originals
       FROM documents d ${PAID_JOIN}
       WHERE ${s.sql} AND d.period = ?`
    )
    .get(...s.params, period) as {
    documents: number;
    amount: number;
    vat: number;
    not_posted: number;
    missing_originals: number;
  };

  // Последние изменения — чтобы вернуться к тому, с чем работал вчера.
  const recent = db
    .prepare(
      `SELECT d.id, d.type, d.number, d.doc_date, d.amount_minor, d.approval_status, d.updated_at,
              cp.name AS counterparty_name
       FROM documents d
       LEFT JOIN counterparties cp ON cp.id = d.counterparty_id
       ${PAID_JOIN}
       WHERE ${s.sql}
       ORDER BY d.updated_at DESC, d.id DESC LIMIT 8`
    )
    .all(...s.params) as {
    id: number;
    type: string;
    number: string;
    doc_date: string;
    amount_minor: number;
    approval_status: string;
    updated_at: string;
    counterparty_name: string | null;
  }[];

  // Налоговые сроки касаются только бухгалтерии и руководителя.
  const deadlines =
    ACCOUNTING_ROLES.includes(user.role) || user.role === 'director' ? upcomingDeadlines(5) : [];

  res.json({
    queues,
    deadlines,
    period: {
      period,
      documents: periodStats.documents,
      amount: periodStats.amount,
      vat: periodStats.vat,
      notPosted: periodStats.not_posted,
      missingOriginals: periodStats.missing_originals,
    },
    recent: recent.map((r) => ({
      id: r.id,
      type: r.type,
      number: r.number,
      docDate: r.doc_date,
      amount: r.amount_minor,
      approvalStatus: r.approval_status,
      updatedAt: r.updated_at,
      counterpartyName: r.counterparty_name,
    })),
  });
});

/** Справочники одним запросом — нужны почти на каждом экране. */
workspaceRouter.get('/dictionaries', (_req, res) => {
  const expenseItems = db
    .prepare('SELECT id, code, name FROM expense_items WHERE active = 1 ORDER BY name')
    .all() as { id: number; code: string; name: string }[];

  const counterparties = db
    .prepare('SELECT id, bin, name, iban, is_vat_payer FROM counterparties ORDER BY name')
    .all() as { id: number; bin: string; name: string; iban: string; is_vat_payer: number }[];

  const users = db
    .prepare(`SELECT id, name, role, section FROM users WHERE role IN ('accountant','chief_accountant') ORDER BY name`)
    .all() as { id: number; name: string; role: string; section: string | null }[];

  const periods = db
    .prepare('SELECT DISTINCT period FROM documents ORDER BY period DESC LIMIT 24')
    .all() as { period: string }[];

  const contracts = db
    .prepare('SELECT id, number, counterparty_id, subject FROM contracts ORDER BY number')
    .all() as { id: number; number: string; counterparty_id: number; subject: string }[];

  res.json({
    expenseItems,
    counterparties: counterparties.map((c) => ({
      id: c.id,
      bin: c.bin,
      name: c.name,
      iban: c.iban,
      isVatPayer: c.is_vat_payer === 1,
    })),
    users,
    periods: periods.map((p) => p.period),
    contracts: contracts.map((c) => ({
      id: c.id,
      number: c.number,
      counterpartyId: c.counterparty_id,
      subject: c.subject,
    })),
  });
});
