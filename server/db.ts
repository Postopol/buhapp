import Database from 'better-sqlite3';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  STATUS_ORDER,
  type RequestStatus,
} from './constants';

const DB_PATH = process.env.DB_PATH || 'server/data/govfin.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

export function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      iin TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('accountant','chief_accountant','manager')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      initiator TEXT NOT NULL,
      expense_item TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      status TEXT NOT NULL CHECK(status IN ('draft','finance_check','chief_signature','ready_treasury','done')),
      created_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS timeline_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      performer TEXT NOT NULL,
      performed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('connected','error')),
      last_sync TEXT NOT NULL,
      failure_rate REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      performed_at TEXT NOT NULL,
      system TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','error')),
      error TEXT NOT NULL DEFAULT '-'
    );

    CREATE TABLE IF NOT EXISTS ifp_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      plan INTEGER NOT NULL,
      fact INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('critical','warning','info')),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

interface SeedRequest {
  id: string;
  initiator: string;
  expenseItem: string;
  amount: number;
  status: RequestStatus;
  date: string;
}

const seedRequests: SeedRequest[] = [
  { id: 'REQ-2023-001', initiator: 'Отдел кадров', expenseItem: '111 (Оплата труда)', amount: 15000000, status: 'draft', date: '2023-10-25' },
  { id: 'REQ-2023-002', initiator: 'IT Отдел', expenseItem: '414 (Оборудование)', amount: 2500000, status: 'finance_check', date: '2023-10-24' },
  { id: 'REQ-2023-003', initiator: 'АХО', expenseItem: '159 (Прочие товары)', amount: 450000, status: 'chief_signature', date: '2023-10-23' },
  { id: 'REQ-2023-004', initiator: 'Отдел закупок', expenseItem: '149 (Прочие услуги)', amount: 1200000, status: 'ready_treasury', date: '2023-10-22' },
];

const seedTimelineTimes = ['10:00:00', '11:30:00', '09:15:00', '14:00:00', '16:30:00'];
const seedTimelinePerformers = [
  'Иванова А. (Инициатор)',
  'Иванова А. (Инициатор)',
  'Петров В. (Бухгалтер)',
  'Сидорова Е. (Главбух)',
  'Система',
];

function seed(): void {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  if (userCount.c > 0) return;

  const insertUser = db.prepare(
    'INSERT INTO users (iin, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertUser.run('111111111111', hashPassword('pass123'), 'Петров В.', 'accountant', '2023-01-01 00:00:00');
  insertUser.run('222222222222', hashPassword('pass123'), 'Сидорова Е.', 'chief_accountant', '2023-01-01 00:00:00');
  insertUser.run('333333333333', hashPassword('pass123'), 'Иванов И.', 'manager', '2023-01-01 00:00:00');

  const insertRequest = db.prepare(
    'INSERT INTO requests (id, initiator, expense_item, amount, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertTimeline = db.prepare(
    'INSERT INTO timeline_entries (request_id, step_index, performer, performed_at) VALUES (?, ?, ?, ?)'
  );

  for (const r of seedRequests) {
    insertRequest.run(r.id, r.initiator, r.expenseItem, r.amount, r.status, r.date, null);
    const completedCount = STATUS_ORDER.indexOf(r.status) + 1;
    for (let i = 0; i < completedCount; i++) {
      const ts = `${r.date} ${seedTimelineTimes[i]}`;
      insertTimeline.run(r.id, i, seedTimelinePerformers[i], ts);
    }
  }

  const insertIntegration = db.prepare(
    'INSERT INTO integrations (id, name, description, status, last_sync, failure_rate) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertIntegration.run('e-qyzmet', 'e-Qyzmet', 'Получение кадровых приказов и табелей', 'connected', '10 мин назад', 0);
  insertIntegration.run('treasury', 'Казначейство (ИС "Казначейство-клиент")', 'Выгрузка счетов к оплате, загрузка выписок', 'connected', '1 час назад', 0.15);
  insertIntegration.run('goszakup', 'Государственные закупки (OAG)', 'Статусы договоров, акты выполненных работ', 'error', 'Вчера, 18:00', 0.4);

  const insertLog = db.prepare(
    'INSERT INTO sync_logs (performed_at, system, status, error) VALUES (?, ?, ?, ?)'
  );
  insertLog.run('2023-10-25 10:15:00', 'e-Qyzmet', 'success', '-');
  insertLog.run('2023-10-25 09:30:00', 'Казначейство (ИС "Казначейство-клиент")', 'success', '-');
  insertLog.run('2023-10-24 18:00:00', 'Государственные закупки (OAG)', 'error', 'Timeout: Сервер OAG не ответил в течение 30с');
  insertLog.run('2023-10-24 14:00:00', 'e-Qyzmet', 'success', '-');
  insertLog.run('2023-10-24 12:00:00', 'Казначейство (ИС "Казначейство-клиент")', 'success', '-');

  const insertIfp = db.prepare(
    'INSERT INTO ifp_data (code, name, plan, fact) VALUES (?, ?, ?, ?)'
  );
  const ifpRows: [string, string, number, number][] = [
    ['111', '111 (Оплата труда)', 500000000, 450000000],
    ['112', '112 (Доп. выплаты)', 100000000, 90000000],
    ['121', '121 (Налоги)', 150000000, 140000000],
    ['149', '149 (Прочие услуги)', 200000000, 120000000],
    ['159', '159 (Прочие товары)', 300000000, 150000000],
    ['414', '414 (Оборудование)', 250000000, 50000000],
  ];
  for (const row of ifpRows) {
    insertIfp.run(...row);
  }

  const insertAlert = db.prepare(
    'INSERT INTO alerts (type, message, created_at) VALUES (?, ?, ?)'
  );
  insertAlert.run('critical', 'Риск неосвоения по специфике 414 (Оборудование) - 200 млн тг. Срок до 15 декабря.', '2025-08-13 08:00:00');
  insertAlert.run('warning', 'Заблокированы средства по договору №142 (отсутствует акт выполненных работ).', '2025-08-12 10:00:00');
  insertAlert.run('info', 'Ожидается поступление транша из республиканского бюджета.', '2025-08-11 14:00:00');
}

export function generateRequestId(): string {
  const year = new Date().getFullYear();
  const prefix = `REQ-${year}-`;
  const row = db.prepare(
    `SELECT id FROM requests WHERE id LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(`${prefix}%`) as { id: string } | undefined;
  let next = 1;
  if (row) {
    const m = row.id.match(/(\d+)$/);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(next).padStart(3, '0')}`;
}

migrate();
seed();
