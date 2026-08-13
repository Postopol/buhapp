import { request } from './api';
import type { User } from '@/types';

export interface LoginResponse {
  token: string;
  user: User;
}

export function login(iin: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ iin, password }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/auth/logout', { method: 'POST' });
}

export function me(): Promise<{ user: User }> {
  return request('/auth/me');
}
