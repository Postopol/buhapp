import express from 'express';
import { corsMiddleware } from './auth';
import { authRouter } from './routes/auth';
import { documentsRouter } from './routes/documents';
import { counterpartiesRouter } from './routes/counterparties';
import { paymentsRouter } from './routes/payments';
import { workspaceRouter } from './routes/workspace';
import { attachmentsRouter } from './routes/attachments';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(corsMiddleware);
// Вложения приходят как base64 внутри JSON — лимит по умолчанию (100 КБ) мал.
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/counterparties', counterpartiesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/attachments', attachmentsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Маршрут не найден' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`API бухотдела запущен на http://localhost:${PORT}`);
});
