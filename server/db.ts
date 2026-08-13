import Database from 'better-sqlite3';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CLOSING_TASK_TEMPLATE,
  type ApprovalStatus,
  type DocType,
  type OriginalStatus,
  type PostingStatus,
  type Section,
} from '../shared/domain';

const DB_PATH = process.env.DB_PATH || 'server/data/govfin.db';

/** Каталог для вложений. Лежит рядом с БД и так же не попадает в git. */
export const UPLOAD_DIR = process.env.UPLOAD_DIR || join(dirname(DB_PATH), 'uploads');

mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Версия схемы. При несовпадении база пересоздаётся целиком —
 * прежняя схема госоргана (requests / ifp_data / integrations) несовместима.
 */
const SCHEMA_VERSION = 3;

// ── Пароли ──────────────────────────────────────────────────────────────────

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const hashBuf = scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(hash, 'hex');
  if (hashBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(hashBuf, expectedBuf);
}

// ── Даты ────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

export function nowTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Смещение от сегодняшнего дня в днях, в формате YYYY-MM-DD. */
function shiftDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function periodOf(date: string): string {
  return date.slice(0, 7);
}

// ── Аудит ───────────────────────────────────────────────────────────────────

export function logAudit(params: {
  entityType: string;
  entityId: number | string;
  action: string;
  userId: number | null;
  userName: string;
  details?: unknown;
}): void {
  db.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, user_id, user_name, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.entityType,
    String(params.entityId),
    params.action,
    params.userId,
    params.userName,
    params.details === undefined ? null : JSON.stringify(params.details),
    nowTimestamp()
  );
}

// ── Периоды ─────────────────────────────────────────────────────────────────

/**
 * Периоды заводятся лениво: при первом обращении к месяцу создаётся строка
 * и чек-лист из шаблона. Ответственный подставляется по участку задачи.
 */
export function ensurePeriod(period: string): void {
  const exists = db.prepare('SELECT period FROM periods WHERE period = ?').get(period);
  if (exists) return;

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO periods (period, status, created_at) VALUES (?, 'open', ?)`).run(
      period,
      nowTimestamp()
    );
    const insertTask = db.prepare(
      `INSERT INTO closing_tasks (period, sort, title, hint, responsible_user_id)
       VALUES (?, ?, ?, ?, ?)`
    );
    const bySection = db.prepare(
      `SELECT id FROM users WHERE section = ? AND role = 'accountant' ORDER BY id LIMIT 1`
    );
    const chief = db.prepare(`SELECT id FROM users WHERE role = 'chief_accountant' ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;

    CLOSING_TASK_TEMPLATE.forEach((task, index) => {
      const owner = task.section ? (bySection.get(task.section) as { id: number } | undefined) : undefined;
      insertTask.run(period, index, task.title, task.hint, owner?.id ?? chief?.id ?? null);
    });
  });
  tx();
}

export function isPeriodClosed(period: string): boolean {
  const row = db.prepare('SELECT status FROM periods WHERE period = ?').get(period) as
    | { status: string }
    | undefined;
  return row?.status === 'closed';
}

// ── Схема ───────────────────────────────────────────────────────────────────

function dropEverything(): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  db.pragma('foreign_keys = OFF');
  for (const t of tables) {
    if (t.name === 'schema_meta') continue;
    db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  }
  db.pragma('foreign_keys = ON');
}

function migrate(): boolean {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as
    | { value: string }
    | undefined;

  const isFresh = row?.value !== String(SCHEMA_VERSION);
  if (!isFresh) return false;

  if (row) {
    console.log(`Схема устарела (v${row.value} → v${SCHEMA_VERSION}), база пересоздаётся.`);
  }
  dropEverything();

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('initiator','accountant','chief_accountant','director')),
      section TEXT,
      department TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE counterparties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bin TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_vat_payer INTEGER NOT NULL DEFAULT 0,
      bank_name TEXT NOT NULL DEFAULT '',
      bank_bic TEXT NOT NULL DEFAULT '',
      iban TEXT NOT NULL DEFAULT '',
      responsible_user_id INTEGER REFERENCES users(id),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE expense_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT NOT NULL,
      contract_date TEXT NOT NULL,
      counterparty_id INTEGER NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
      subject TEXT NOT NULL DEFAULT '',
      amount_minor INTEGER NOT NULL DEFAULT 0,
      valid_until TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('invoice','act','waybill','contract','expense_report')),
      number TEXT NOT NULL,
      doc_date TEXT NOT NULL,
      due_date TEXT,
      period TEXT NOT NULL,
      counterparty_id INTEGER REFERENCES counterparties(id),
      contract_id INTEGER REFERENCES contracts(id),
      expense_item_id INTEGER REFERENCES expense_items(id),
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      vat_minor INTEGER NOT NULL DEFAULT 0,
      purpose TEXT NOT NULL DEFAULT '',
      section TEXT NOT NULL,
      responsible_user_id INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      approval_status TEXT NOT NULL CHECK(approval_status IN ('draft','review','approved','returned','rejected')),
      original_status TEXT NOT NULL CHECK(original_status IN ('none','scan','received','signed')),
      posting_status TEXT NOT NULL CHECK(posting_status IN ('not_posted','posted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      stored_name TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_date TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      bank_account TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE document_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      UNIQUE(document_id, payment_id)
    );

    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment',
      created_at TEXT NOT NULL
    );

    CREATE TABLE periods (
      period TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('open','closed')) DEFAULT 'open',
      closed_at TEXT,
      closed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE closing_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL REFERENCES periods(period) ON DELETE CASCADE,
      sort INTEGER NOT NULL,
      title TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
      responsible_user_id INTEGER REFERENCES users(id),
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      done_by INTEGER REFERENCES users(id),
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      user_id INTEGER,
      user_name TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_documents_approval ON documents(approval_status);
    CREATE INDEX idx_documents_section ON documents(section);
    CREATE INDEX idx_documents_counterparty ON documents(counterparty_id);
    CREATE INDEX idx_documents_due ON documents(due_date);
    CREATE INDEX idx_documents_period ON documents(period);
    CREATE INDEX idx_documents_responsible ON documents(responsible_user_id);
    CREATE INDEX idx_doc_payments_document ON document_payments(document_id);
    CREATE INDEX idx_doc_payments_payment ON document_payments(payment_id);
    CREATE INDEX idx_attachments_document ON attachments(document_id);
    CREATE INDEX idx_comments_document ON comments(document_id);
    CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX idx_closing_tasks_period ON closing_tasks(period);
    CREATE INDEX idx_sessions_expires ON sessions(expires_at);
  `);

  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));

  return true;
}

// ── Seed ────────────────────────────────────────────────────────────────────

const T = 100; // тиын в тенге — суммы в БД хранятся в тиынах

interface SeedDoc {
  type: DocType;
  number: string;
  docDate: string;
  dueDate: string | null;
  counterparty: number | null;
  expenseItem: number;
  tenge: number;
  vat: boolean;
  purpose: string;
  section: Section;
  responsible: number;
  createdBy: number;
  approval: ApprovalStatus;
  original: OriginalStatus;
  posting: PostingStatus;
  /** Сколько тенге уже оплачено — создаст платёж и разнесение. */
  paidTenge?: number;
  comments?: { user: number; body: string; kind?: string }[];
}

function seed(): void {
  const createdAt = nowTimestamp();

  // Пользователи -------------------------------------------------------------
  const insertUser = db.prepare(
    'INSERT INTO users (email, password_hash, name, role, section, department, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const pw = hashPassword('pass123');
  const uAnna = Number(
    insertUser.run('anna@company.kz', pw, 'Иванова Анна', 'accountant', 'suppliers', null, createdAt).lastInsertRowid
  );
  const uMarat = Number(
    insertUser.run('marat@company.kz', pw, 'Сергеев Марат', 'accountant', 'bank', null, createdAt).lastInsertRowid
  );
  const uOlga = Number(
    insertUser.run('olga@company.kz', pw, 'Ким Ольга', 'chief_accountant', null, null, createdAt).lastInsertRowid
  );
  const uIgor = Number(
    insertUser.run('igor@company.kz', pw, 'Петров Игорь', 'initiator', null, 'Отдел закупок', createdAt).lastInsertRowid
  );
  insertUser.run('erlan@company.kz', pw, 'Абдуллин Ерлан', 'director', null, null, createdAt);

  // Контрагенты --------------------------------------------------------------
  const insertCp = db.prepare(
    `INSERT INTO counterparties (bin, name, is_vat_payer, bank_name, bank_bic, iban, responsible_user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const cpAstana = Number(
    insertCp.run('050740004321', 'ТОО «Астана Строй Сервис»', 1, 'АО «Народный банк Казахстана»', 'HSBKKZKX', 'KZ226010111000123456', uAnna, '', createdAt).lastInsertRowid
  );
  const cpTelecom = Number(
    insertCp.run('991140000876', 'ТОО «Казтелеком Партнёр»', 1, 'АО «Kaspi Bank»', 'CASPKZKA', 'KZ7247010000123456789', uAnna, 'Ежемесячный счёт за связь, приходит 1-го числа', createdAt).lastInsertRowid
  );
  const cpAhmetov = Number(
    insertCp.run('820315300456', 'ИП «Ахметов А.»', 0, 'АО «ForteBank»', 'IRTYKZKA', 'KZ8496511F0007654321', uAnna, 'Не плательщик НДС', createdAt).lastInsertRowid
  );
  const cpOffice = Number(
    insertCp.run('140240012345', 'ТОО «Глобал Офис»', 1, 'АО «Bank CenterCredit»', 'KCJBKZKX', 'KZ1130117КZ0009988776', uAnna, '', createdAt).lastInsertRowid
  );
  const cpTrans = Number(
    insertCp.run('060540007890', 'АО «Транс Логистик»', 1, 'АО «Народный банк Казахстана»', 'HSBKKZKX', 'KZ556010222000445566', uMarat, '', createdAt).lastInsertRowid
  );

  // Статьи расходов ----------------------------------------------------------
  const insertItem = db.prepare('INSERT INTO expense_items (code, name, active) VALUES (?, ?, 1)');
  const items: Record<string, number> = {};
  const itemRows: [string, string][] = [
    ['ARND', 'Аренда помещений'],
    ['SVYZ', 'Связь и интернет'],
    ['KANC', 'Канцтовары и хозрасходы'],
    ['TRNS', 'Транспорт и логистика'],
    ['ITPO', 'ИТ и программное обеспечение'],
    ['OBOR', 'Оборудование'],
    ['KONS', 'Юридические и консалтинговые услуги'],
    ['REKL', 'Реклама и маркетинг'],
    ['KOMD', 'Командировочные расходы'],
  ];
  for (const [code, name] of itemRows) {
    items[code] = Number(insertItem.run(code, name).lastInsertRowid);
  }

  // Договоры -----------------------------------------------------------------
  const insertContract = db.prepare(
    `INSERT INTO contracts (number, contract_date, counterparty_id, subject, amount_minor, valid_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertContract.run('АР-2026/14', shiftDays(-220), cpAstana, 'Аренда офиса, 340 м²', 40_800_000 * T, shiftDays(145), createdAt);
  insertContract.run('СВ-118', shiftDays(-400), cpTelecom, 'Услуги связи и интернет', 4_200_000 * T, shiftDays(-35), createdAt);
  insertContract.run('ТЛ-2026/07', shiftDays(-90), cpTrans, 'Транспортно-экспедиторские услуги', 12_000_000 * T, shiftDays(275), createdAt);

  // Документы ----------------------------------------------------------------
  const docs: SeedDoc[] = [
    {
      type: 'invoice', number: 'СЧ-4471', docDate: shiftDays(-24), dueDate: shiftDays(-9),
      counterparty: cpAstana, expenseItem: items.ARND, tenge: 3_400_000, vat: true,
      purpose: 'Аренда офиса за текущий месяц по договору АР-2026/14',
      section: 'suppliers', responsible: uAnna, createdBy: uAnna,
      approval: 'approved', original: 'received', posting: 'posted',
    },
    {
      // Ключевое проблемное состояние: деньги ушли, закрывающих документов нет.
      type: 'invoice', number: 'СЧ-1180', docDate: shiftDays(-31), dueDate: shiftDays(-17),
      counterparty: cpTelecom, expenseItem: items.SVYZ, tenge: 348_000, vat: true,
      purpose: 'Услуги связи и интернет за прошлый месяц',
      section: 'suppliers', responsible: uAnna, createdBy: uAnna,
      approval: 'approved', original: 'none', posting: 'not_posted',
      paidTenge: 348_000,
      comments: [{ user: uAnna, body: 'Оплатили, оригинал счёта-фактуры до сих пор не прислали. Запросил повторно.' }],
    },
    {
      type: 'invoice', number: 'СЧ-9902', docDate: shiftDays(-12), dueDate: shiftDays(-2),
      counterparty: cpOffice, expenseItem: items.KANC, tenge: 189_500, vat: true,
      purpose: 'Канцтовары и расходные материалы для офиса',
      section: 'suppliers', responsible: uAnna, createdBy: uIgor,
      approval: 'approved', original: 'scan', posting: 'not_posted',
    },
    {
      type: 'invoice', number: 'СЧ-2026-556', docDate: shiftDays(-6), dueDate: shiftDays(1),
      counterparty: cpTrans, expenseItem: items.TRNS, tenge: 1_850_000, vat: true,
      purpose: 'Доставка груза Алматы — Астана, 3 рейса',
      section: 'suppliers', responsible: uAnna, createdBy: uIgor,
      approval: 'review', original: 'scan', posting: 'not_posted',
      comments: [{ user: uIgor, body: 'Срочно, перевозчик держит машины до конца недели.' }],
    },
    {
      type: 'invoice', number: 'INV-0042', docDate: shiftDays(-4), dueDate: shiftDays(4),
      counterparty: cpAhmetov, expenseItem: items.ITPO, tenge: 640_000, vat: false,
      purpose: 'Доработка сайта и настройка CRM',
      section: 'suppliers', responsible: uAnna, createdBy: uIgor,
      approval: 'returned', original: 'none', posting: 'not_posted',
      comments: [
        { user: uIgor, body: 'Счёт от подрядчика за доработки.' },
        { user: uAnna, body: 'Нет договора и акта. Приложите договор — без него на оплату не пропущу.', kind: 'return_reason' },
      ],
    },
    {
      type: 'invoice', number: 'СЧ-7734', docDate: shiftDays(-2), dueDate: shiftDays(9),
      counterparty: cpOffice, expenseItem: items.OBOR, tenge: 2_450_000, vat: true,
      purpose: 'Ноутбуки Lenovo ThinkPad, 5 шт.',
      section: 'suppliers', responsible: uAnna, createdBy: uIgor,
      approval: 'review', original: 'scan', posting: 'not_posted',
    },
    {
      type: 'invoice', number: 'СЧ-311', docDate: shiftDays(-1), dueDate: shiftDays(14),
      counterparty: cpAhmetov, expenseItem: items.KONS, tenge: 450_000, vat: false,
      purpose: 'Юридическое сопровождение, абонентская плата',
      section: 'suppliers', responsible: uAnna, createdBy: uIgor,
      approval: 'draft', original: 'none', posting: 'not_posted',
    },
    {
      type: 'invoice', number: 'СЧ-6120', docDate: shiftDays(-3), dueDate: shiftDays(3),
      counterparty: cpAstana, expenseItem: items.ARND, tenge: 3_400_000, vat: true,
      purpose: 'Аренда офиса за текущий месяц, второй платёж',
      section: 'suppliers', responsible: uAnna, createdBy: uAnna,
      approval: 'approved', original: 'received', posting: 'not_posted',
    },
    {
      type: 'act', number: 'АВР-215', docDate: shiftDays(-27), dueDate: null,
      counterparty: cpAstana, expenseItem: items.ARND, tenge: 3_400_000, vat: true,
      purpose: 'Акт об оказании услуг аренды за прошлый месяц',
      section: 'suppliers', responsible: uAnna, createdBy: uAnna,
      approval: 'approved', original: 'signed', posting: 'posted',
    },
    {
      type: 'act', number: 'АВР-2026/88', docDate: shiftDays(-15), dueDate: null,
      counterparty: cpTrans, expenseItem: items.TRNS, tenge: 1_200_000, vat: true,
      purpose: 'Акт выполненных работ по перевозкам',
      section: 'suppliers', responsible: uAnna, createdBy: uAnna,
      approval: 'approved', original: 'none', posting: 'not_posted',
      comments: [{ user: uAnna, body: 'Оригинал в пути, обещали курьером до конца недели.' }],
    },
    {
      type: 'waybill', number: 'НК-4521', docDate: shiftDays(-8), dueDate: null,
      counterparty: cpOffice, expenseItem: items.KANC, tenge: 189_500, vat: true,
      purpose: 'Накладная на канцтовары',
      section: 'inventory', responsible: uMarat, createdBy: uMarat,
      approval: 'review', original: 'received', posting: 'not_posted',
    },
    {
      type: 'expense_report', number: 'АО-56', docDate: shiftDays(-5), dueDate: shiftDays(2),
      counterparty: null, expenseItem: items.KOMD, tenge: 187_400, vat: false,
      purpose: 'Командировка Астана — Алматы, 3 дня: билеты, гостиница, суточные',
      section: 'bank', responsible: uMarat, createdBy: uIgor,
      approval: 'review', original: 'received', posting: 'not_posted',
      comments: [{ user: uIgor, body: 'Все чеки приложены, кроме такси из аэропорта — потерял.' }],
    },
    {
      type: 'invoice', number: 'СЧ-1104', docDate: shiftDays(-62), dueDate: shiftDays(-48),
      counterparty: cpTelecom, expenseItem: items.SVYZ, tenge: 341_000, vat: true,
      purpose: 'Услуги связи за позапрошлый месяц',
      section: 'suppliers', responsible: uAnna, createdBy: uAnna,
      approval: 'approved', original: 'signed', posting: 'posted',
      paidTenge: 341_000,
    },
    {
      type: 'invoice', number: 'СЧ-4402', docDate: shiftDays(-55), dueDate: shiftDays(-40),
      counterparty: cpAstana, expenseItem: items.ARND, tenge: 3_400_000, vat: true,
      purpose: 'Аренда офиса за позапрошлый месяц',
      section: 'suppliers', responsible: uAnna, createdBy: uAnna,
      approval: 'approved', original: 'signed', posting: 'posted',
      paidTenge: 3_400_000,
    },
    {
      // Частичная оплата — проверяет разнесение и статус «частично».
      type: 'invoice', number: 'СЧ-2026-499', docDate: shiftDays(-40), dueDate: shiftDays(-19),
      counterparty: cpTrans, expenseItem: items.TRNS, tenge: 2_000_000, vat: true,
      purpose: 'Транспортные услуги, предоплата 60%',
      section: 'suppliers', responsible: uAnna, createdBy: uAnna,
      approval: 'approved', original: 'received', posting: 'not_posted',
      paidTenge: 1_200_000,
    },
    {
      type: 'invoice', number: 'СЧ-8890', docDate: shiftDays(-19), dueDate: shiftDays(-5),
      counterparty: cpOffice, expenseItem: items.REKL, tenge: 780_000, vat: true,
      purpose: 'Печать раздаточных материалов к выставке',
      section: 'suppliers', responsible: uAnna, createdBy: uIgor,
      approval: 'rejected', original: 'scan', posting: 'not_posted',
      comments: [{ user: uOlga, body: 'Бюджет на маркетинг в этом квартале исчерпан. Переносим на следующий квартал.', kind: 'return_reason' }],
    },
  ];

  const insertDoc = db.prepare(
    `INSERT INTO documents
      (type, number, doc_date, due_date, period, counterparty_id, contract_id, expense_item_id,
       amount_minor, vat_minor, purpose, section, responsible_user_id, created_by,
       approval_status, original_status, posting_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertComment = db.prepare(
    'INSERT INTO comments (document_id, user_id, user_name, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertPayment = db.prepare(
    `INSERT INTO payments (payment_date, amount_minor, bank_account, reference, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAlloc = db.prepare(
    'INSERT INTO document_payments (document_id, payment_id, amount_minor) VALUES (?, ?, ?)'
  );
  const userNames = db.prepare('SELECT id, name FROM users').all() as { id: number; name: string }[];
  const nameById = new Map(userNames.map((u) => [u.id, u.name]));

  let paymentNo = 340;
  for (const d of docs) {
    // НДС в РК выделяется из суммы с налогом: 12/112.
    const amountMinor = d.tenge * T;
    const vatMinor = d.vat ? Math.round((amountMinor * 12) / 112) : 0;
    const ts = `${d.docDate} 09:00:00`;
    const docId = Number(
      insertDoc.run(
        d.type, d.number, d.docDate, d.dueDate, periodOf(d.docDate),
        d.counterparty ?? null, d.expenseItem,
        amountMinor, vatMinor, d.purpose, d.section, d.responsible, d.createdBy,
        d.approval, d.original, d.posting, ts, ts
      ).lastInsertRowid
    );

    for (const c of d.comments ?? []) {
      insertComment.run(docId, c.user, nameById.get(c.user) ?? '—', c.body, c.kind ?? 'comment', ts);
    }

    if (d.paidTenge) {
      const payMinor = d.paidTenge * T;
      const payDate = d.dueDate ?? d.docDate;
      const payId = Number(
        insertPayment.run(
          payDate, payMinor, 'KZ226010111000456789', `ПП-${paymentNo++}`, '', uMarat, `${payDate} 12:00:00`
        ).lastInsertRowid
      );
      insertAlloc.run(docId, payId, payMinor);
    }
  }

  // Периоды с чек-листами — по всем месяцам, в которые попали документы.
  const periods = db.prepare('SELECT DISTINCT period FROM documents ORDER BY period').all() as {
    period: string;
  }[];
  for (const p of periods) ensurePeriod(p.period);
  ensurePeriod(currentPeriod());

  logAudit({
    entityType: 'system',
    entityId: 0,
    action: 'seed',
    userId: null,
    userName: 'Система',
    details: { documents: docs.length, users: 5 },
  });

  console.log(`База создана: ${docs.length} документов, 5 пользователей, 5 контрагентов.`);
}

const created = migrate();
if (created) seed();
