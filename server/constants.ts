export type Role = 'accountant' | 'chief_accountant' | 'manager';

export type RequestStatus = 'draft' | 'finance_check' | 'chief_signature' | 'ready_treasury' | 'done';

export const STATUS_ORDER: RequestStatus[] = [
  'draft',
  'finance_check',
  'chief_signature',
  'ready_treasury',
  'done',
];

export const FLOW_STEPS: { action: string; defaultUser: string }[] = [
  { action: 'Создание черновика', defaultUser: 'Инициатор' },
  { action: 'Отправка на проверку', defaultUser: 'Инициатор' },
  { action: 'Проверка финотделом', defaultUser: 'Бухгалтер' },
  { action: 'Подпись Главбуха', defaultUser: 'Главбух' },
  { action: 'Отправка в Казначейство', defaultUser: 'Система' },
];

export const STATUS_ACTIONS: Partial<Record<RequestStatus, { label: string; nextStatus: RequestStatus; roles: Role[] }>> = {
  draft: { label: 'Отправить на проверку', nextStatus: 'finance_check', roles: ['accountant'] },
  finance_check: { label: 'Согласовать', nextStatus: 'chief_signature', roles: ['accountant'] },
  chief_signature: { label: 'Подписать ЭЦП', nextStatus: 'ready_treasury', roles: ['chief_accountant'] },
  ready_treasury: { label: 'Отправить в Казначейство', nextStatus: 'done', roles: ['chief_accountant'] },
};

export const EXPENSE_ITEMS = [
  '111 (Оплата труда)',
  '112 (Доп. выплаты)',
  '121 (Налоги)',
  '149 (Прочие услуги)',
  '159 (Прочие товары)',
  '414 (Оборудование)',
];

export const ROLE_LABELS: Record<Role, string> = {
  accountant: 'Бухгалтер',
  chief_accountant: 'Главбух',
  manager: 'Руководитель',
};

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
