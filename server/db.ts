import Database from 'better-sqlite3';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Циклический импорт: reconciliation.ts берёт отсюда `db`, но трогает его
// только внутри функций — к моменту вызова из seed() он уже создан. Считать
// снимок здесь своим SQL было бы шестой копией арифметики сальдо.
import { statement } from './reconciliation';
import {
  CLOSING_TASK_TEMPLATE,
  vatFromGross,
  type ApprovalStatus,
  type DocType,
  type OriginalStatus,
  type PostingStatus,
  type Section,
} from '../shared/domain';

/**
 * Пути считаются от расположения модуля, а не от текущего каталога. Раньше
 * запуск сервера из любого другого места молча заводил вторую пустую базу
 * рядом, и вся бухгалтерия выглядела стёртой, хотя лежала в первом файле.
 * Переменные окружения по-прежнему главнее — на них живут тесты.
 */
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(SERVER_DIR, 'data', 'govfin.db');
const DATA_DIR = dirname(DB_PATH);

/** Каталог для вложений. Лежит рядом с БД и так же не попадает в git. */
export const UPLOAD_DIR = process.env.UPLOAD_DIR || join(DATA_DIR, 'uploads');

/**
 * Копии базы лежат рядом с ней же. Это важно для тестов: они поднимают сервер
 * с базой во временном каталоге, и копии уезжают туда, а не в рабочее дерево.
 */
const BACKUP_DIR = process.env.BACKUP_DIR || join(DATA_DIR, 'backups');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Встроенный LOWER в SQLite знает только латиницу: LOWER('СЧ-4471') возвращает
 * строку без изменений, и поиск по кириллице не находит вообще ничего —
 * а в этом приложении по-русски написано всё. Своя функция считает через JS,
 * который умеет Unicode.
 */
db.function('rulower', { deterministic: true }, (value: unknown) =>
  typeof value === 'string' ? value.toLowerCase() : null
);

/**
 * Версия схемы. Поднимается вместе с новым шагом в MIGRATIONS: несовпадение
 * версии больше не повод стирать базу — недостающие шаги накатываются по
 * одному, с сохранением данных.
 */
const SCHEMA_VERSION = 7;

/**
 * Ниже этой версии инкрементальных шагов нет: там жила схема госоргана
 * (requests / ifp_data / integrations), от которой не осталось ни одной общей
 * таблицы. Такую базу можно только пересоздать вручную — RESET_DB=1.
 */
const OLDEST_UPGRADABLE = 6;

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

/** Границы месяца, отстоящего на `back` месяцев назад: с 1-го по последнее число. */
function monthRange(back: number): { from: string; to: string; period: string } {
  const d = new Date();
  const first = new Date(d.getFullYear(), d.getMonth() - back, 1);
  const last = new Date(d.getFullYear(), d.getMonth() - back + 1, 0);
  const iso = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  return { from: iso(first), to: iso(last), period: iso(first).slice(0, 7) };
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

// ── Бэкапы ──────────────────────────────────────────────────────────────────

/**
 * Вся бухгалтерия компании — один файл SQLite. Пока копий не было, внедрять
 * портал было нельзя: любая ошибка обновления, диска или оператора стоила бы
 * всего учёта разом. Держим последние семь копий — недели хватает, чтобы
 * заметить порчу данных и откатиться.
 */
const BACKUP_KEEP = 7;
const BACKUP_SUFFIX = '.bak';

function backupName(reason: string): string {
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${basename(DB_PATH)}.${stamp}.${reason}${BACKUP_SUFFIX}`;
}

/**
 * Убирает копии за пределами BACKUP_KEEP. Метка времени в имени фиксированной
 * ширины, поэтому сортировка по имени — это сортировка по дате.
 */
function rotateBackups(): void {
  const prefix = `${basename(DB_PATH)}.`;
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(BACKUP_SUFFIX))
    .sort();
  for (const stale of files.slice(0, Math.max(files.length - BACKUP_KEEP, 0))) {
    unlinkSync(join(BACKUP_DIR, stale));
  }
}

/**
 * Копия базы «на живую», без остановки сервера. Асинхронная, потому что
 * better-sqlite3 копирует страницами — это и нужно для регулярного бэкапа.
 */
export async function backupDatabase(reason = 'daily'): Promise<string | null> {
  if (!existsSync(DB_PATH)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = join(BACKUP_DIR, backupName(reason));
  await db.backup(dest);
  rotateBackups();
  console.log(`Копия базы: ${dest}`);
  return dest;
}

/**
 * Синхронная копия для момента запуска: перед миграцией и перед RESET_DB
 * дождаться промиса негде — модуль поднимается верхнеуровневым кодом, а
 * данные обязаны быть сохранены ДО первого ALTER или DROP.
 *
 * Копировать один .db-файл при journal_mode = WAL нельзя: свежие транзакции
 * лежат в отдельном файле и в копию не попали бы. Поэтому сначала сливаем WAL
 * в основной файл, и только потом копируем.
 */
function backupSync(reason: string): string | null {
  if (!existsSync(DB_PATH)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  db.pragma('wal_checkpoint(TRUNCATE)');
  const dest = join(BACKUP_DIR, backupName(reason));
  copyFileSync(DB_PATH, dest);
  rotateBackups();
  return dest;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const backupTimer = setInterval(() => {
  backupDatabase('daily').catch((err) => console.error('Не удалось снять копию базы:', err));
}, DAY_MS);
// Бэкап — не повод держать процесс живым: без unref() не завершились бы ни
// тесты, ни разовые скрипты, дёргающие этот модуль.
backupTimer.unref();

// ── Схема ───────────────────────────────────────────────────────────────────

/**
 * Снос всех таблиц. Вызывается только по явной команде RESET_DB=1 и только
 * после копии. schema_meta очищается тоже: иначе после сноса версия осталась
 * бы «актуальной» и приложение подняло бы пустую базу без пользователей.
 */
function dropEverything(): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  // PRAGMA foreign_keys внутри транзакции — no-op, поэтому снос идёт без неё.
  db.pragma('foreign_keys = OFF');
  for (const t of tables) {
    if (t.name === 'schema_meta') continue;
    db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  }
  db.exec('DELETE FROM schema_meta');
  db.pragma('foreign_keys = ON');
}

function createSchema(): void {
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
      -- «Этот акт или накладная закрывает вот этот счёт». Счёт на оплату сам
      -- по себе обязательства не создаёт — начисление создаёт закрывающий
      -- документ. Поэтому счёт, на который ссылается не отклонённый акт или
      -- накладная, выпадает из начислений, но остаётся носителем оплаты:
      -- платежи разносятся именно на него. Без этой ссылки поток
      -- «счёт → оплата → акт» задваивал сальдо по контрагенту.
      closes_document_id INTEGER REFERENCES documents(id),
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

    CREATE TABLE tax_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      period TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      done_by INTEGER REFERENCES users(id),
      amount_minor INTEGER,
      note TEXT NOT NULL DEFAULT '',
      responsible_user_id INTEGER REFERENCES users(id),
      UNIQUE(code, period)
    );

    CREATE TABLE saved_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT NOT NULL UNIQUE,
      counterparty_id INTEGER NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('draft','sent','signed','disputed','cancelled')) DEFAULT 'draft',
      -- Снимок расчёта на момент формирования. Пересчитывать акт задним числом
      -- нельзя: подписанный документ обязан показывать те же цифры, что ушли
      -- контрагенту, даже если первичку потом поправили. CHECK(>0) здесь
      -- нарочно нет — сальдо уходит в минус при переплате.
      opening_minor INTEGER NOT NULL,
      accrued_minor INTEGER NOT NULL,
      paid_minor INTEGER NOT NULL,
      closing_minor INTEGER NOT NULL,
      -- Справочные величины снимка. В сальдо не входят, но бухгалтер обязан
      -- их видеть: несогласованное в акт попало, аванс — нет.
      unapproved_minor INTEGER NOT NULL DEFAULT 0,
      unapproved_count INTEGER NOT NULL DEFAULT 0,
      unallocated_minor INTEGER NOT NULL DEFAULT 0,
      excluded_minor INTEGER NOT NULL DEFAULT 0,
      excluded_count INTEGER NOT NULL DEFAULT 0,
      -- Оплаты по отклонённым документам: отсекаются по дате платежа, а не
      -- документа, поэтому живут отдельной парой колонок.
      excluded_paid_minor INTEGER NOT NULL DEFAULT 0,
      excluded_paid_count INTEGER NOT NULL DEFAULT 0,
      -- Сальдо со слов контрагента. NULL — ответа ещё нет.
      their_closing_minor INTEGER,
      note TEXT NOT NULL DEFAULT '',
      responsible_user_id INTEGER REFERENCES users(id),
      built_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      signed_at TEXT,
      signed_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE reconciliation_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
      sort INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('document','payment','their')),
      -- Ссылки нужны для перехода в карточку; сумма и название всё равно
      -- лежат снимком рядом, поэтому удаление первички акт не ломает.
      document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
      line_date TEXT NOT NULL,
      title TEXT NOT NULL,
      -- Расшифровка и НДС лежат снимком, а не подтягиваются JOIN-ом: иначе
      -- подсказка «расхождение равно НДС» отваливается ровно тогда, когда
      -- документ удалён, — то есть когда она нужнее всего.
      purpose TEXT NOT NULL DEFAULT '',
      vat_minor INTEGER NOT NULL DEFAULT 0,
      accrued_minor INTEGER NOT NULL DEFAULT 0,
      paid_minor INTEGER NOT NULL DEFAULT 0,
      -- Что по этой строке у контрагента. NULL — не сверяли, 0 — у него её нет.
      their_amount_minor INTEGER,
      -- Исходная строка вставки — чтобы было видно, что именно разобрали.
      their_raw TEXT NOT NULL DEFAULT '',
      match TEXT NOT NULL DEFAULT 'unknown'
        CHECK(match IN ('unknown','match','amount_diff','only_ours','only_theirs')),
      -- Расхождение разобрано: акт нельзя подписать, пока есть неразобранные.
      resolved INTEGER NOT NULL DEFAULT 0,
      comment TEXT NOT NULL DEFAULT ''
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

    -- Реестр почти никогда не фильтрует по одному полю: типовые сочетания —
    -- «на проверке по моему участку», «этот контрагент за период», «мои
    -- документы в работе». Составной индекс закрывает и сочетание, и запрос
    -- по одному первому полю, поэтому отдельных индексов на approval_status,
    -- counterparty_id и responsible_user_id больше нет.
    CREATE INDEX idx_documents_approval_section ON documents(approval_status, section);
    CREATE INDEX idx_documents_counterparty_date ON documents(counterparty_id, doc_date);
    CREATE INDEX idx_documents_responsible_approval ON documents(responsible_user_id, approval_status);
    CREATE INDEX idx_documents_section ON documents(section);
    CREATE INDEX idx_documents_due ON documents(due_date);
    CREATE INDEX idx_documents_period ON documents(period);
    -- Сортировка реестра по умолчанию и отсечение оборотов по дате документа.
    CREATE INDEX idx_documents_date ON documents(doc_date);
    CREATE INDEX idx_documents_closes ON documents(closes_document_id);
    CREATE INDEX idx_doc_payments_document ON document_payments(document_id);
    CREATE INDEX idx_doc_payments_payment ON document_payments(payment_id);
    CREATE INDEX idx_attachments_document ON attachments(document_id);
    CREATE INDEX idx_comments_document ON comments(document_id);
    CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX idx_closing_tasks_period ON closing_tasks(period);
    CREATE INDEX idx_saved_views_user ON saved_views(user_id);
    CREATE INDEX idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX idx_reconciliations_counterparty ON reconciliations(counterparty_id);
    CREATE INDEX idx_reconciliations_status ON reconciliations(status);
    CREATE INDEX idx_reconciliation_lines_act ON reconciliation_lines(reconciliation_id);
    -- Сверка режет платежи по дате, а индекса на payment_date в проекте не было:
    -- без него каждый акт и каждый пересчёт дрейфа сканируют payments целиком.
    CREATE INDEX idx_payments_date ON payments(payment_date);
  `);
}

function setVersion(version: number): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(version));
}

interface Migration {
  /** Версия, до которой поднимает шаг. */
  to: number;
  /** Что меняется — уходит в лог обновления. */
  what: string;
  run: () => void;
}

/**
 * Пошаговое обновление уже работающей базы. Ни один шаг не имеет права терять
 * данные: в файле лежит вся первичка компании, а вложения к ней — на диске
 * рядом, и пересоздание базы оставляло бы их сиротами.
 */
const MIGRATIONS: Migration[] = [
  {
    to: 7,
    what: 'ссылка на закрывающий документ и составные индексы реестра',
    run: () => {
      // ADD COLUMN с REFERENCES разрешён, пока значение по умолчанию — NULL:
      // старые строки просто остаются без закрывающего документа.
      db.exec(`
        ALTER TABLE documents ADD COLUMN closes_document_id INTEGER REFERENCES documents(id);
        CREATE INDEX IF NOT EXISTS idx_documents_closes ON documents(closes_document_id);
        CREATE INDEX IF NOT EXISTS idx_documents_approval_section ON documents(approval_status, section);
        CREATE INDEX IF NOT EXISTS idx_documents_counterparty_date ON documents(counterparty_id, doc_date);
        CREATE INDEX IF NOT EXISTS idx_documents_responsible_approval ON documents(responsible_user_id, approval_status);
        CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(doc_date);
        DROP INDEX IF EXISTS idx_documents_approval;
        DROP INDEX IF EXISTS idx_documents_counterparty;
        DROP INDEX IF EXISTS idx_documents_responsible;
      `);
    },
  },
];

/**
 * Приводит базу к SCHEMA_VERSION. Три разных случая, и путать их нельзя:
 * базы нет — собираем целиком, база старее — накатываем шаги, база новее —
 * останавливаемся с ошибкой. Прежняя версия при любом несовпадении сносила
 * всё подряд, то есть теряла бухгалтерию на первом же обновлении кода.
 */
function migrate(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  if (process.env.RESET_DB === '1') {
    console.warn('RESET_DB=1 — база пересоздаётся, все данные будут стёрты.');
    const copy = backupSync('reset');
    if (copy) console.warn(`Копия прежней базы: ${copy}`);
    dropEverything();
  }

  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  if (row && !Number.isInteger(current)) {
    throw new Error(`schema_meta.version = «${row.value}» — не число. Разберитесь с файлом ${DB_PATH} вручную.`);
  }

  if (current === 0) {
    // Базы ещё нет: схема, демо-данные и версия — одной транзакцией. Раньше
    // версия писалась до seed, и падение seed посередине оставляло базу
    // навсегда «актуальной», но полупустой — без пользователей войти в неё
    // было уже нельзя, а повторный запуск ничего не исправлял.
    const build = db.transaction(() => {
      createSchema();
      seed();
      setVersion(SCHEMA_VERSION);
    });
    build();
    return;
  }

  if (current === SCHEMA_VERSION) return;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `База версии ${current}, а код рассчитан на ${SCHEMA_VERSION}. Похоже на откат кода назад. ` +
        'Верните подходящую версию приложения: стирать данные из-за отката нельзя.'
    );
  }

  if (current < OLDEST_UPGRADABLE) {
    throw new Error(
      `База версии ${current} несовместима: общих таблиц с текущей схемой нет. ` +
        'Перенесите данные вручную или пересоздайте базу явно: RESET_DB=1 (копия снимется автоматически).'
    );
  }

  // Версия записана, а таблиц нет — половинчатое состояние после ручного
  // вмешательства. Молча пересобирать нельзя: именно так и теряются данные.
  const hasCore = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'`)
    .get();
  if (!hasCore) {
    throw new Error(
      `В базе записана версия ${current}, но таблицы documents нет. ` +
        'База повреждена — восстановите её из копии или пересоздайте явно: RESET_DB=1.'
    );
  }

  const steps = MIGRATIONS.filter((m) => m.to > current).sort((a, b) => a.to - b.to);
  if (steps.length === 0) {
    throw new Error(`Нет шага обновления с версии ${current} на ${SCHEMA_VERSION} — обновите MIGRATIONS.`);
  }

  const copy = backupSync('migrate');
  console.log(
    `Обновление схемы: v${current} → v${SCHEMA_VERSION}${copy ? `. Копия до обновления: ${copy}` : ''}`
  );
  for (const step of steps) {
    // Шаг и запись версии — в одной транзакции: если ALTER упадёт, версия
    // останется прежней и следующий запуск повторит ровно этот шаг.
    const apply = db.transaction(() => {
      step.run();
      setVersion(step.to);
    });
    apply();
    console.log(`  v${step.to}: ${step.what}`);
  }
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
  /** Номер счёта, который закрывает этот акт или накладная. */
  closes?: string;
  comments?: { user: number; body: string; kind?: string }[];
}

/**
 * Демо-данные. Вызывается только при сборке новой базы и только внутри
 * транзакции migrate(): своих транзакций здесь нет, а те, что приходят из
 * ensurePeriod(), better-sqlite3 вкладывает через SAVEPOINT — откат внешней
 * транзакции снимет и их.
 */
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
      // Закрывает счёт СЧ-9902 на ту же сумму: поставка одна, а документов
      // два. Начисление создаёт накладная, счёт остаётся носителем оплаты —
      // без связи 189 500 ₸ сидели в сальдо «Глобал Офис» дважды.
      type: 'waybill', number: 'НК-4521', docDate: shiftDays(-8), dueDate: null,
      counterparty: cpOffice, expenseItem: items.KANC, tenge: 189_500, vat: true,
      purpose: 'Накладная на канцтовары по счёту СЧ-9902',
      section: 'inventory', responsible: uMarat, createdBy: uMarat,
      approval: 'review', original: 'received', posting: 'not_posted',
      closes: 'СЧ-9902',
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
       approval_status, original_status, posting_status, closes_document_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  // Закрывающий документ ссылается на счёт по номеру, а id счёта известен
  // только после вставки — поэтому номера копятся по ходу цикла, а закрываемый
  // счёт в списке всегда стоит раньше своего акта или накладной.
  const idByNumber = new Map<string, number>();
  for (const d of docs) {
    // НДС выделяется из суммы с налогом по ставке на дату документа: с
    // 2026-01-01 в РК 16 %, до неё 12 %. Захардкоженные 12/112 после Нового
    // года занижали бы зачётный НДС по каждому счёту.
    const amountMinor = d.tenge * T;
    const vatMinor = d.vat ? vatFromGross(amountMinor, d.docDate) : 0;
    const ts = `${d.docDate} 09:00:00`;

    let closesId: number | null = null;
    if (d.closes) {
      closesId = idByNumber.get(d.closes) ?? null;
      // Молча оставить связь пустой нельзя: демо тогда выглядит рабочим,
      // а задвоение сальдо возвращается незаметно.
      if (closesId === null) {
        throw new Error(`Документ ${d.number} закрывает ${d.closes}, но такого счёта в seed нет или он идёт позже`);
      }
    }

    const docId = Number(
      insertDoc.run(
        d.type, d.number, d.docDate, d.dueDate, periodOf(d.docDate),
        d.counterparty ?? null, d.expenseItem,
        amountMinor, vatMinor, d.purpose, d.section, d.responsible, d.createdBy,
        d.approval, d.original, d.posting, closesId, ts, ts
      ).lastInsertRowid
    );
    idByNumber.set(d.number, docId);

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

  // Общие пресеты реестра. Заводит их главбух — они видны всей бухгалтерии.
  const insertView = db.prepare(
    'INSERT INTO saved_views (user_id, name, query, shared, sort, created_at) VALUES (?, ?, ?, 1, ?, ?)'
  );
  const sharedViews: [string, Record<string, string>][] = [
    ['Ждут проверки', { approval: 'review' }],
    ['Просроченные', { overdue: 'true' }],
    ['Нет оригинала', { original: 'none' }],
    ['Оплачено без оригинала', { payment: 'paid', original: 'none' }],
    ['Не проведены в учёте', { approval: 'approved', posting: 'not_posted' }],
  ];
  sharedViews.forEach(([name, query], index) => {
    insertView.run(uOlga, name, JSON.stringify(query), index, createdAt);
  });

  // Периоды с чек-листами — по всем месяцам, в которые попали документы.
  const periods = db.prepare('SELECT DISTINCT period FROM documents ORDER BY period').all() as {
    period: string;
  }[];
  for (const p of periods) ensurePeriod(p.period);
  ensurePeriod(currentPeriod());

  seedReconciliations({ cpAstana, cpTelecom, cpTrans, uAnna, uOlga, createdAt });

  logAudit({
    entityType: 'system',
    entityId: 0,
    action: 'seed',
    userId: null,
    userName: 'Система',
    details: { documents: docs.length, users: 5 },
  });

  console.log(
    `База создана: ${docs.length} документов, 5 пользователей, 5 контрагентов, 3 акта сверки.`
  );
}

/**
 * Три демо-акта на готовых кейсах сида: сошедшийся, ждущий ответа и с
 * расхождением. Снимок считается тем же модулем, что и боевой, — иначе
 * демо разъедется с продуктом на первой же правке правил.
 */
function seedReconciliations(ids: {
  cpAstana: number;
  cpTelecom: number;
  cpTrans: number;
  uAnna: number;
  uOlga: number;
  createdAt: string;
}): void {
  const insertAct = db.prepare(
    `INSERT INTO reconciliations
       (number, counterparty_id, date_from, date_to, status,
        opening_minor, accrued_minor, paid_minor, closing_minor,
        unapproved_minor, unapproved_count, unallocated_minor,
        excluded_minor, excluded_count, excluded_paid_minor, excluded_paid_count,
        their_closing_minor, note, responsible_user_id, built_at,
        created_by, created_at, updated_at, sent_at, signed_at, signed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertLine = db.prepare(
    `INSERT INTO reconciliation_lines
       (reconciliation_id, sort, kind, document_id, payment_id, line_date, title,
        purpose, vat_minor, accrued_minor, paid_minor, their_amount_minor, match, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const make = (
    number: string,
    counterparty: number,
    back: number,
    monthsWide: number,
    status: string,
    opts: { theirClosing?: number | null; note?: string; signedBy?: number | null } = {}
  ) => {
    const end = monthRange(back);
    const start = monthRange(back + monthsWide - 1);
    const snap = statement(counterparty, start.from, end.to);
    // Сошедшийся акт: сальдо контрагента равно нашему, если не сказано иначе.
    const theirs = opts.theirClosing === undefined ? snap.closing : opts.theirClosing;

    const actId = Number(
      insertAct.run(
        number, counterparty, start.from, end.to, status,
        snap.opening, snap.accrued, snap.paid, snap.closing,
        snap.unapproved, snap.unapprovedCount, snap.unallocated,
        snap.excluded, snap.excludedCount, snap.excludedPaid, snap.excludedPaidCount,
        theirs, opts.note ?? '', ids.uAnna, ids.createdAt,
        ids.uAnna, ids.createdAt, ids.createdAt,
        status === 'draft' ? null : ids.createdAt,
        status === 'signed' ? ids.createdAt : null,
        status === 'signed' ? (opts.signedBy ?? ids.uOlga) : null
      ).lastInsertRowid
    );

    snap.lines.forEach((line, index) => {
      const ours = line.accrued + line.paid;
      // У сошедшегося акта контрагент подтвердил каждую строку; у спорного
      // строки остаются несверенными, кроме той, из-за которой спор.
      const confirmed = theirs === snap.closing;
      insertLine.run(
        actId, index, line.kind, line.documentId, line.paymentId,
        line.date, line.title, line.purpose, line.vat, line.accrued, line.paid,
        confirmed ? ours : null, confirmed ? 'match' : 'unknown', ''
      );
    });
    return { actId, snap, sort: snap.lines.length };
  };

  make('АС-' + monthRange(2).period.slice(0, 4) + '-001', ids.cpAstana, 2, 1, 'signed');
  // Отправлен и ждёт ответа: сальдо контрагента ещё не известно.
  make('АС-' + monthRange(1).period.slice(0, 4) + '-002', ids.cpTelecom, 1, 1, 'sent', {
    theirClosing: null,
  });

  // Спорный: контрагент не увидел нашу частичную предоплату по СЧ-2026-499
  // и вдобавок прислал накладную, которой у нас нет.
  const disputed = make('АС-' + monthRange(0).period.slice(0, 4) + '-003', ids.cpTrans, 0, 2, 'disputed', {
    theirClosing: null,
    note: 'Контрагент не разнёс предоплату и прислал накладную, которой у нас нет',
  });
  const theirClosing = disputed.snap.closing + 1_200_000 * T + 340_000 * T;
  db.prepare('UPDATE reconciliations SET their_closing_minor = ? WHERE id = ?').run(
    theirClosing,
    disputed.actId
  );
  insertLine.run(
    disputed.actId, disputed.sort, 'their', null, null,
    monthRange(0).from, 'НК-7781 (накладная контрагента)',
    'Из выписки контрагента', 0, 0, 0, 340_000 * T, 'only_theirs', ''
  );
}

migrate();
