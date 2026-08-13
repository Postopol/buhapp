/**
 * Единый домен для сервера и клиента.
 * Только типы и чистые константы — никаких node-зависимостей,
 * файл попадает и в бандл Vite, и в рантайм Express.
 */

// ── Роли ────────────────────────────────────────────────────────────────────

export type Role = 'initiator' | 'accountant' | 'chief_accountant' | 'director';

export const ROLE_LABELS: Record<Role, string> = {
  initiator: 'Инициатор',
  accountant: 'Бухгалтер',
  chief_accountant: 'Главный бухгалтер',
  director: 'Руководитель',
};

/** Роли, которые входят в бухотдел (видят чужие документы и участки). */
export const ACCOUNTING_ROLES: Role[] = ['accountant', 'chief_accountant'];

// ── Участки бухгалтерии ─────────────────────────────────────────────────────

export type Section = 'suppliers' | 'bank' | 'payroll' | 'inventory' | 'sales' | 'tax';

export const SECTION_LABELS: Record<Section, string> = {
  suppliers: 'Поставщики',
  bank: 'Банк и касса',
  payroll: 'Зарплата',
  inventory: 'ТМЗ и склад',
  sales: 'Реализация',
  tax: 'Налоги и отчётность',
};

export const SECTIONS = Object.keys(SECTION_LABELS) as Section[];

// ── Типы документов ─────────────────────────────────────────────────────────

export type DocType = 'invoice' | 'act' | 'waybill' | 'contract' | 'expense_report';

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  invoice: 'Счёт на оплату',
  act: 'Акт выполненных работ',
  waybill: 'Накладная',
  contract: 'Договор',
  expense_report: 'Авансовый отчёт',
};

export const DOC_TYPES = Object.keys(DOC_TYPE_LABELS) as DocType[];

/** Короткая метка для плотной таблицы реестра. */
export const DOC_TYPE_SHORT: Record<DocType, string> = {
  invoice: 'Счёт',
  act: 'Акт',
  waybill: 'Накладная',
  contract: 'Договор',
  expense_report: 'Авансовый',
};

/** Типы, по которым уходят деньги — только они попадают в реестр на оплату. */
export const PAYABLE_TYPES: DocType[] = ['invoice', 'expense_report'];

// ── Четыре независимых статуса ──────────────────────────────────────────────

/** 1. Согласование — движется по маршруту, может вернуться назад. */
export type ApprovalStatus = 'draft' | 'review' | 'approved' | 'returned' | 'rejected';

export const APPROVAL_LABELS: Record<ApprovalStatus, string> = {
  draft: 'Черновик',
  review: 'На проверке',
  approved: 'Согласован',
  returned: 'Возвращён',
  rejected: 'Отклонён',
};

/** 2. Оригинал — где физически лежит бумага. */
export type OriginalStatus = 'none' | 'scan' | 'received' | 'signed';

export const ORIGINAL_LABELS: Record<OriginalStatus, string> = {
  none: 'Нет',
  scan: 'Только скан',
  received: 'Оригинал получен',
  signed: 'Подписан обеими сторонами',
};

export const ORIGINAL_STATUSES = Object.keys(ORIGINAL_LABELS) as OriginalStatus[];

/** 3. Оплата — вычисляется из разнесённых платежей, не хранится. */
export type PaymentState = 'unpaid' | 'partial' | 'paid';

export const PAYMENT_LABELS: Record<PaymentState, string> = {
  unpaid: 'Не оплачен',
  partial: 'Частично',
  paid: 'Оплачен',
};

/** 4. Учёт — передан ли документ в учётную систему. */
export type PostingStatus = 'not_posted' | 'posted';

export const POSTING_LABELS: Record<PostingStatus, string> = {
  not_posted: 'Не проведён',
  posted: 'Проведён',
};

// ── Маршрут согласования ────────────────────────────────────────────────────

export interface ApprovalTransition {
  /** Что написано на кнопке. */
  label: string;
  to: ApprovalStatus;
  roles: Role[];
  /** Требует комментария (причины). */
  requiresComment?: boolean;
}

/**
 * Маршрут не линейный: из «на проверке» есть три выхода, и это главное
 * отличие от прежней схемы, где документ мог только двигаться вперёд.
 */
export const TRANSITIONS: Record<ApprovalStatus, ApprovalTransition[]> = {
  draft: [
    { label: 'Отправить на проверку', to: 'review', roles: ['initiator', 'accountant', 'chief_accountant'] },
  ],
  returned: [
    { label: 'Отправить повторно', to: 'review', roles: ['initiator', 'accountant', 'chief_accountant'] },
  ],
  review: [
    { label: 'Согласовать', to: 'approved', roles: ['accountant', 'chief_accountant'] },
    { label: 'Вернуть на доработку', to: 'returned', roles: ['accountant', 'chief_accountant'], requiresComment: true },
    { label: 'Отклонить', to: 'rejected', roles: ['chief_accountant'], requiresComment: true },
  ],
  approved: [
    { label: 'Отозвать согласование', to: 'review', roles: ['chief_accountant'], requiresComment: true },
  ],
  rejected: [],
};

/**
 * Сумма, от которой согласование требует главбуха: 1 000 000 ₸.
 * Обычный бухгалтер такой документ согласовать не может.
 * ВНИМАНИЕ: все суммы в системе — в тиынах, отсюда множитель.
 */
export const CHIEF_APPROVAL_THRESHOLD = 1_000_000 * 100;

// ── Прочее ──────────────────────────────────────────────────────────────────

export const VAT_RATE = 0.12;

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const PAGE_SIZE = 50;

/** Максимальный размер вложения (байт) до base64-обёртки. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
