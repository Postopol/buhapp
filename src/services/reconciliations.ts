import { request, buildQuery, downloadUrl } from './api';
import type {
  Reconciliation,
  ReconciliationDetail,
  ReconciliationStatement,
  ReconciliationStatus,
  ReconciliationSummary,
} from '@/types';

interface ListResponse {
  acts: Reconciliation[];
  total: number;
  disputed: number;
  signed: number;
}

export function listReconciliations(filters: {
  counterparty?: string;
  status?: string;
  period?: string;
}): Promise<ListResponse> {
  return request(`/reconciliations${buildQuery(filters)}`);
}

export function getReconciliation(id: number): Promise<{ act: ReconciliationDetail }> {
  return request(`/reconciliations/${id}`);
}

/** Расчёт без сохранения — до того, как заводить акт. */
export function previewReconciliation(
  counterparty: number,
  from: string,
  to: string
): Promise<{ statement: ReconciliationStatement }> {
  return request(`/reconciliations/preview${buildQuery({ counterparty, from, to })}`);
}

export function createReconciliation(data: {
  counterpartyId: number;
  from: string;
  to: string;
}): Promise<{ act: ReconciliationDetail }> {
  return request('/reconciliations', { method: 'POST', body: JSON.stringify(data) });
}

export function rebuildReconciliation(id: number): Promise<{ act: ReconciliationDetail }> {
  return request(`/reconciliations/${id}/rebuild`, { method: 'POST' });
}

export function patchReconciliation(
  id: number,
  data: { theirClosing?: number | null; note?: string }
): Promise<{ act: ReconciliationDetail }> {
  return request(`/reconciliations/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function patchReconciliationLine(
  id: number,
  lineId: number,
  data: { theirAmount?: number | null; comment?: string }
): Promise<{ act: ReconciliationDetail }> {
  return request(`/reconciliations/${id}/lines/${lineId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function resolveReconciliationLine(
  id: number,
  lineId: number,
  data: { comment?: string; resolved?: boolean }
): Promise<{ act: ReconciliationDetail }> {
  return request(`/reconciliations/${id}/lines/${lineId}/resolve`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function addReconciliationLine(
  id: number,
  data: { date: string; title: string; theirAmount: number; comment?: string }
): Promise<{ act: ReconciliationDetail; lineId: number }> {
  return request(`/reconciliations/${id}/lines`, { method: 'POST', body: JSON.stringify(data) });
}

export function deleteReconciliationLine(
  id: number,
  lineId: number
): Promise<{ act: ReconciliationDetail }> {
  return request(`/reconciliations/${id}/lines/${lineId}`, { method: 'DELETE' });
}

export interface ImportResult {
  act: ReconciliationDetail;
  parsed: { rows: number; skipped: { raw: string; reason: string }[] };
}

export function importReconciliation(
  id: number,
  text: string,
  defaultKind: 'accrued' | 'paid' = 'accrued'
): Promise<ImportResult> {
  return request(`/reconciliations/${id}/import`, {
    method: 'POST',
    body: JSON.stringify({ text, defaultKind }),
  });
}

export function transitionReconciliation(
  id: number,
  to: ReconciliationStatus,
  comment?: string
): Promise<{ act: ReconciliationDetail }> {
  return request(`/reconciliations/${id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ to, comment }),
  });
}

export function deleteReconciliation(id: number): Promise<{ ok: boolean }> {
  return request(`/reconciliations/${id}`, { method: 'DELETE' });
}

export function getReconciliationSummary(period: string): Promise<{ summary: ReconciliationSummary }> {
  return request(`/reconciliations/summary${buildQuery({ period })}`);
}

/** Печатная форма: ссылка не умеет слать заголовок, токен уходит в query. */
export function reconciliationExportUrl(id: number): string {
  return downloadUrl(`/reconciliations/${id}/export.csv`);
}
