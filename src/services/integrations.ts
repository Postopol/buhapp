import { request } from './api';
import type { Integration, SyncLog } from '@/types';

export function getIntegrations(): Promise<{ integrations: Integration[] }> {
  return request('/integrations');
}

export function getLogs(
  search?: string,
  system?: string,
  status?: string
): Promise<{ logs: SyncLog[] }> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (system && system !== 'all') params.set('system', system);
  if (status && status !== 'all') params.set('status', status);
  const qs = params.toString();
  return request(`/integrations/logs${qs ? '?' + qs : ''}`);
}

export function syncOne(id: string): Promise<{ integration: Integration }> {
  return request(`/integrations/${id}/sync`, { method: 'POST' });
}

export function syncAll(): Promise<{ integrations: Integration[] }> {
  return request('/integrations/sync-all', { method: 'POST' });
}
