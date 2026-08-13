import { Router } from 'express';
import { db, nowTimestamp } from '../db';
import { requireAuth, requireRole } from '../auth';

export const integrationsRouter = Router();

integrationsRouter.use(requireAuth);
integrationsRouter.use(requireRole('accountant', 'chief_accountant'));

interface IntegrationRow {
  id: string;
  name: string;
  description: string;
  status: 'connected' | 'error';
  last_sync: string;
  failure_rate: number;
}

interface SyncLogRow {
  id: number;
  performed_at: string;
  system: string;
  status: 'success' | 'error';
  error: string;
}

function mapIntegration(row: IntegrationRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    lastSync: row.last_sync,
    failureRate: row.failure_rate,
  };
}

function mapLog(row: SyncLogRow) {
  return {
    id: row.id,
    time: row.performed_at,
    system: row.system,
    status: row.status,
    error: row.error,
  };
}

function simulateSync(failureRate: number): Promise<boolean> {
  return new Promise((resolve) => {
    const delay = 800 + Math.random() * 1200;
    setTimeout(() => resolve(Math.random() >= failureRate), delay);
  });
}

function performSync(integrationId: string): Promise<{ success: boolean; logId: number }> {
  return new Promise((resolve) => {
    const integration = db.prepare(
      'SELECT id, name, failure_rate FROM integrations WHERE id = ?'
    ).get(integrationId) as { id: string; name: string; failure_rate: number } | undefined;
    if (!integration) {
      resolve({ success: false, logId: -1 });
      return;
    }
    simulateSync(integration.failure_rate)
      .then((success) => {
        const ts = nowTimestamp();
        const error = success ? '-' : 'Timeout: Внешний сервис не ответил в течение 30с';
        const tx = db.transaction(() => {
          db.prepare('UPDATE integrations SET status = ?, last_sync = ? WHERE id = ?').run(
            success ? 'connected' : 'error',
            success ? 'Только что' : 'Ошибка синхронизации',
            integration.id
          );
          return db.prepare(
            'INSERT INTO sync_logs (performed_at, system, status, error) VALUES (?, ?, ?, ?)'
          ).run(ts, integration.name, success ? 'success' : 'error', error);
        });
        const result = tx();
        resolve({ success, logId: Number(result.lastInsertRowid) });
      })
      .catch(() => {
        const ts = nowTimestamp();
        const tx = db.transaction(() => {
          db.prepare('UPDATE integrations SET status = ?, last_sync = ? WHERE id = ?').run(
            'error',
            'Ошибка синхронизации',
            integration.id
          );
          return db.prepare(
            'INSERT INTO sync_logs (performed_at, system, status, error) VALUES (?, ?, ?, ?)'
          ).run(ts, integration.name, 'error', 'Внутренняя ошибка при синхронизации');
        });
        const result = tx();
        resolve({ success: false, logId: Number(result.lastInsertRowid) });
      });
  });
}

integrationsRouter.get('/', (_req, res) => {
  const rows = db.prepare(
    'SELECT id, name, description, status, last_sync, failure_rate FROM integrations ORDER BY id'
  ).all() as IntegrationRow[];
  res.json({ integrations: rows.map(mapIntegration) });
});

integrationsRouter.post('/sync-all', async (_req, res) => {
  const rows = db.prepare('SELECT id FROM integrations ORDER BY id').all() as { id: string }[];
  for (const row of rows) {
    await performSync(row.id);
  }
  const updated = db.prepare(
    'SELECT id, name, description, status, last_sync, failure_rate FROM integrations ORDER BY id'
  ).all() as IntegrationRow[];
  res.json({ integrations: updated.map(mapIntegration) });
});

integrationsRouter.post('/:id/sync', async (req, res) => {
  const exists = db.prepare('SELECT id FROM integrations WHERE id = ?').get(req.params.id);
  if (!exists) {
    res.status(404).json({ error: 'Интеграция не найдена' });
    return;
  }
  await performSync(req.params.id);
  const row = db.prepare(
    'SELECT id, name, description, status, last_sync, failure_rate FROM integrations WHERE id = ?'
  ).get(req.params.id) as IntegrationRow;
  res.json({ integration: mapIntegration(row) });
});

integrationsRouter.get('/logs', (req, res) => {
  const { search, system, status } = req.query as {
    search?: string;
    system?: string;
    status?: string;
  };
  let query = 'SELECT id, performed_at, system, status, error FROM sync_logs';
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (system && system !== 'all') {
    conditions.push('system = ?');
    params.push(system);
  }
  if (status && status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (search && search.trim()) {
    conditions.push('(LOWER(performed_at) LIKE ? OR LOWER(system) LIKE ? OR LOWER(error) LIKE ?)');
    const q = `%${search.trim().toLowerCase()}%`;
    params.push(q, q, q);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY id DESC LIMIT 200';
  const rows = db.prepare(query).all(...params) as SyncLogRow[];
  res.json({ logs: rows.map(mapLog) });
});
