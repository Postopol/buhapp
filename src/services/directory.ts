import { request, buildQuery } from './api';
import type {
  Counterparty,
  CounterpartyDetail,
  Dictionaries,
  PayableDocument,
  Payment,
  PeriodDetail,
  PeriodSummaryRow,
  TaxCalendar,
  Workspace,
} from '@/types';

// ── Рабочее место и справочники ─────────────────────────────────────────────

export function getWorkspace(): Promise<Workspace> {
  return request('/workspace');
}

export function getDictionaries(): Promise<Dictionaries> {
  return request('/workspace/dictionaries');
}

// ── Закрытие периода ────────────────────────────────────────────────────────

export function listPeriods(): Promise<{ periods: PeriodSummaryRow[]; current: string }> {
  return request('/periods');
}

export function getPeriod(period: string): Promise<{ period: PeriodDetail }> {
  return request(`/periods/${period}`);
}

export function toggleClosingTask(period: string, taskId: number): Promise<{ period: PeriodDetail }> {
  return request(`/periods/${period}/tasks/${taskId}/toggle`, { method: 'POST' });
}

export function closePeriod(period: string): Promise<{ period: PeriodDetail }> {
  return request(`/periods/${period}/close`, { method: 'POST' });
}

export function reopenPeriod(period: string, reason: string): Promise<{ period: PeriodDetail }> {
  return request(`/periods/${period}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) });
}

// ── Налоговый календарь ─────────────────────────────────────────────────────

export function getTaxCalendar(from?: string, to?: string): Promise<TaxCalendar> {
  return request(`/taxes${buildQuery({ from, to })}`);
}

export function toggleTaxEvent(code: string, period: string): Promise<{ event: { done: boolean } }> {
  return request(`/taxes/${code}/${period}/toggle`, { method: 'POST' });
}

export function saveTaxDetails(
  code: string,
  period: string,
  data: { amount?: number | null; note?: string }
): Promise<{ ok: boolean }> {
  return request(`/taxes/${code}/${period}/details`, { method: 'POST', body: JSON.stringify(data) });
}

// ── Контрагенты ─────────────────────────────────────────────────────────────

export function listCounterparties(search?: string): Promise<{ counterparties: Counterparty[] }> {
  return request(`/counterparties${buildQuery({ search })}`);
}

export function getCounterparty(id: number): Promise<{ counterparty: CounterpartyDetail }> {
  return request(`/counterparties/${id}`);
}

export interface CounterpartyInput {
  bin: string;
  name: string;
  isVatPayer?: boolean;
  bankName?: string;
  bankBic?: string;
  iban?: string;
  responsibleId?: number | null;
  note?: string;
}

export function createCounterparty(data: CounterpartyInput): Promise<{ counterparty: Counterparty }> {
  return request('/counterparties', { method: 'POST', body: JSON.stringify(data) });
}

export function updateCounterparty(
  id: number,
  data: Partial<CounterpartyInput>
): Promise<{ counterparty: Counterparty }> {
  return request(`/counterparties/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

// ── Оплаты ──────────────────────────────────────────────────────────────────

export function listPayments(search?: string): Promise<{ payments: Payment[] }> {
  return request(`/payments${buildQuery({ search })}`);
}

export function getPayable(): Promise<{ payable: PayableDocument[] }> {
  return request('/payments/payable');
}

export interface PaymentInput {
  paymentDate: string;
  amount: number;
  bankAccount?: string;
  reference?: string;
  note?: string;
  allocations: { documentId: number; amount: number }[];
}

export function createPayment(data: PaymentInput): Promise<{ payment: Payment }> {
  return request('/payments', { method: 'POST', body: JSON.stringify(data) });
}

export function deletePayment(id: number): Promise<{ ok: boolean }> {
  return request(`/payments/${id}`, { method: 'DELETE' });
}
