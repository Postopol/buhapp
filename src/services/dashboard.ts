import { request } from './api';
import type { Kpis, IfpItem, DashboardAlert } from '@/types';

export function getKpis(): Promise<{ kpis: Kpis }> {
  return request('/dashboard/kpis');
}

export function getIfp(): Promise<{ ifp: IfpItem[] }> {
  return request('/dashboard/ifp');
}

export function getAlerts(): Promise<{ alerts: DashboardAlert[] }> {
  return request('/dashboard/alerts');
}
