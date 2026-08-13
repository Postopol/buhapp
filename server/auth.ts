import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, verifyPassword, nowTimestamp } from './db';
import { SESSION_TTL_MS, type Role, type Section } from '../shared/domain';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  section: Section | null;
  department: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const USER_COLUMNS = 'id, email, name, role, section, department';

export function createSession(userId: number): string {
  const token = randomUUID();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  const expiresAt = `${expires.getFullYear()}-${pad(expires.getMonth() + 1)}-${pad(expires.getDate())} ${pad(expires.getHours())}:${pad(expires.getMinutes())}:${pad(expires.getSeconds())}`;
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    nowTimestamp(),
    expiresAt
  );
  return token;
}

export function deleteSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

export function getUserByCredentials(email: string, password: string): AuthUser | null {
  const row = db
    .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`)
    .get(email.toLowerCase()) as (AuthUser & { password_hash: string }) | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  const { password_hash: _ignored, ...user } = row;
  return user;
}

export function getUserByToken(token: string): AuthUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.section, u.department, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(token) as (AuthUser & { expires_at: string }) | undefined;
  if (!row) return null;
  if (row.expires_at < nowTimestamp()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    return null;
  }
  const { expires_at: _ignored, ...user } = row;
  return user;
}

export function extractToken(req: Request): string | null {
  // Скачивание файлов идёт обычной ссылкой, заголовок туда не поставить —
  // поэтому для GET разрешён также токен в query.
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (req.method === 'GET' && typeof req.query.token === 'string') return req.query.token;
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Требуется авторизация' });
    return;
  }
  const user = getUserByToken(token);
  if (!user) {
    res.status(401).json({ error: 'Недействительный или истёкший токен' });
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Требуется авторизация' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Недостаточно прав' });
      return;
    }
    next();
  };
}

// ── Чистка протухших сессий ─────────────────────────────────────────────────

function sweepSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowTimestamp());
}

sweepSessions();
setInterval(sweepSessions, 60 * 60 * 1000).unref();

// ── Защита логина от перебора ───────────────────────────────────────────────

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 60 * 1000;

const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

export function checkLoginBlocked(key: string): number | null {
  const rec = loginAttempts.get(key);
  if (!rec) return null;
  const now = Date.now();
  if (rec.lockedUntil > now) return Math.ceil((rec.lockedUntil - now) / 1000);
  return null;
}

export function recordLoginFailure(key: string): void {
  const rec = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    rec.count = 0;
  }
  loginAttempts.set(key, rec);
}

export function resetLoginAttempts(key: string): void {
  loginAttempts.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of loginAttempts) {
    if (rec.lockedUntil < now && rec.count === 0) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
