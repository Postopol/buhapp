import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, verifyPassword, nowTimestamp } from './db';
import { SESSION_TTL_MS, type Role } from './constants';

export interface AuthUser {
  id: number;
  iin: string;
  name: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function createSession(userId: number): string {
  const token = randomUUID();
  const now = new Date();
  const created = nowTimestamp();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  const expiresAt = `${expires.getFullYear()}-${String(expires.getMonth() + 1).padStart(2, '0')}-${String(expires.getDate()).padStart(2, '0')} ${String(expires.getHours()).padStart(2, '0')}:${String(expires.getMinutes()).padStart(2, '0')}:${String(expires.getSeconds()).padStart(2, '0')}`;
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    created,
    expiresAt
  );
  return token;
}

export function deleteSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

export function getUserByCredentials(iin: string, password: string): AuthUser | null {
  const row = db.prepare('SELECT id, iin, password_hash, name, role FROM users WHERE iin = ?').get(iin) as
    | { id: number; iin: string; password_hash: string; name: string; role: Role }
    | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, iin: row.iin, name: row.name, role: row.role };
}

export function getUserByToken(token: string): AuthUser | null {
  const row = db.prepare(`
    SELECT u.id, u.iin, u.name, u.role, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(token) as { id: number; iin: string; name: string; role: Role; expires_at: string } | undefined;
  if (!row) return null;
  const now = nowTimestamp();
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    return null;
  }
  return { id: row.id, iin: row.iin, name: row.name, role: row.role };
}

export function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
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

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 60 * 1000;

const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

export function checkLoginBlocked(iin: string): number | null {
  const rec = loginAttempts.get(iin);
  if (!rec) return null;
  const now = Date.now();
  if (rec.lockedUntil > now) return Math.ceil((rec.lockedUntil - now) / 1000);
  return null;
}

export function recordLoginFailure(iin: string): void {
  const now = Date.now();
  const rec = loginAttempts.get(iin) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
    rec.count = 0;
  }
  loginAttempts.set(iin, rec);
}

export function resetLoginAttempts(iin: string): void {
  loginAttempts.delete(iin);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of loginAttempts) {
    if (rec.lockedUntil < now && rec.count === 0) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
