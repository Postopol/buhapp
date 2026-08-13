export type Role = 'accountant' | 'chief_accountant' | 'manager';

export type RequestStatus = 'draft' | 'finance_check' | 'chief_signature' | 'ready_treasury' | 'done';

export interface TimelineEntry {
  id: number;
  action: string;
  user: string;
  date: string;
  status: 'completed' | 'pending';
}

export interface PaymentRequest {
  id: string;
  initiator: string;
  expenseItem: string;
  amount: number;
  status: RequestStatus;
  date: string;
  timeline?: TimelineEntry[];
}

export type IntegrationStatus = 'connected' | 'error';

export interface Integration {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  lastSync: string;
  failureRate: number;
}

export interface SyncLog {
  id: number;
  time: string;
  system: string;
  status: 'success' | 'error';
  error: string;
}

export interface Kpis {
  totalBudget: number;
  spent: number;
  remaining: number;
  blocked: number;
}

export interface IfpItem {
  name: string;
  plan: number;
  fact: number;
}

export interface DashboardAlert {
  id: number;
  type: 'critical' | 'warning' | 'info';
  message: string;
  date: string;
}

export interface User {
  id: number;
  iin: string;
  name: string;
  role: Role;
}
