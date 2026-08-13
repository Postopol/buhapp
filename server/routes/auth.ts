import { Router } from 'express';
import {
  createSession,
  deleteSession,
  getUserByCredentials,
  requireAuth,
  extractToken,
  checkLoginBlocked,
  recordLoginFailure,
  resetLoginAttempts,
} from '../auth';
import { logAudit } from '../db';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Укажите почту и пароль' });
    return;
  }
  const key = email.trim().toLowerCase();

  const blockedFor = checkLoginBlocked(key);
  if (blockedFor !== null) {
    res.status(429).json({ error: `Слишком много попыток. Повторите через ${blockedFor} сек` });
    return;
  }

  const user = getUserByCredentials(key, password);
  if (!user) {
    recordLoginFailure(key);
    res.status(401).json({ error: 'Неверная почта или пароль' });
    return;
  }
  resetLoginAttempts(key);
  const token = createSession(user.id);
  logAudit({
    entityType: 'user',
    entityId: user.id,
    action: 'login',
    userId: user.id,
    userName: user.name,
  });
  res.json({ token, user });
});

authRouter.post('/logout', requireAuth, (req, res) => {
  const token = extractToken(req);
  if (token) deleteSession(token);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
