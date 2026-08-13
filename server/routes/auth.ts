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

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { iin, password } = req.body as { iin?: string; password?: string };
  if (!iin || !password) {
    res.status(400).json({ error: 'Укажите ИИН и пароль' });
    return;
  }
  const cleanIin = iin.trim();

  const blockedFor = checkLoginBlocked(cleanIin);
  if (blockedFor !== null) {
    res.status(429).json({ error: `Слишком много попыток. Повторите через ${blockedFor} сек` });
    return;
  }

  const user = getUserByCredentials(cleanIin, password);
  if (!user) {
    recordLoginFailure(cleanIin);
    res.status(401).json({ error: 'Неверный ИИН или пароль' });
    return;
  }
  resetLoginAttempts(cleanIin);
  const token = createSession(user.id);
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
