import { request } from './api';
import type { PaymentRequest, RequestStatus } from '@/types';

export function getRequests(
  search?: string,
  status?: RequestStatus | 'all'
): Promise<{ requests: PaymentRequest[] }> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status && status !== 'all') params.set('status', status);
  const qs = params.toString();
  return request(`/requests${qs ? '?' + qs : ''}`);
}

export function getRequest(id: string): Promise<{ request: PaymentRequest }> {
  return request(`/requests/${id}`);
}

export function createRequest(data: {
  initiator: string;
  expenseItem: string;
  amount: number;
}): Promise<{ request: PaymentRequest }> {
  return request('/requests', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function advanceRequest(id: string): Promise<{ request: PaymentRequest }> {
  return request(`/requests/${id}/advance`, { method: 'POST' });
}
