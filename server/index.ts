import express from 'express';
import { corsMiddleware } from './auth';
import { authRouter } from './routes/auth';
import { requestsRouter } from './routes/requests';
import { integrationsRouter } from './routes/integrations';
import { dashboardRouter } from './routes/dashboard';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(corsMiddleware);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/dashboard', dashboardRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Маршрут не найден' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`GovFin API запущен на http://localhost:${PORT}`);
});
