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

/** Переход по маршруту. Параметризован статусом: маршрут есть и у документа, и у акта сверки. */
export interface Transition<S extends string> {
  /** Что написано на кнопке. */
  label: string;
  to: S;
  roles: Role[];
  /** Требует комментария (причины). */
  requiresComment?: boolean;
}

export type ApprovalTransition = Transition<ApprovalStatus>;

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

// ── Закрытие периода ────────────────────────────────────────────────────────

export type PeriodStatus = 'open' | 'closed';

export const PERIOD_STATUS_LABELS: Record<PeriodStatus, string> = {
  open: 'Открыт',
  closed: 'Закрыт',
};

/**
 * Чек-лист закрытия месяца. Создаётся для каждого периода при первом открытии,
 * ответственный подставляется по участку.
 */
export const CLOSING_TASK_TEMPLATE: { title: string; hint: string; section: Section | null }[] = [
  {
    title: 'Вся первичка получена и заведена',
    hint: 'Счета, акты и накладные за период есть в системе',
    section: 'suppliers',
  },
  {
    title: 'Банковские выписки загружены и разнесены',
    hint: 'Каждое движение по счёту привязано к документу',
    section: 'bank',
  },
  {
    title: 'Расчёты с подотчётными лицами закрыты',
    hint: 'Авансовые отчёты сданы, остатки возвращены',
    section: 'bank',
  },
  {
    title: 'Зарплата начислена и проведена',
    hint: 'ИПН, ОПВ, СО и ВОСМС рассчитаны',
    section: 'payroll',
  },
  {
    title: 'Амортизация начислена',
    hint: 'По всем основным средствам и НМА',
    section: 'inventory',
  },
  {
    title: 'Движение ТМЗ проведено',
    hint: 'Поступление и списание материалов закрыты',
    section: 'inventory',
  },
  {
    title: 'Акты сверки с ключевыми контрагентами',
    hint: 'Расхождения найдены и разобраны',
    section: 'suppliers',
  },
  {
    title: 'НДС проверен, реестр счетов-фактур сверен',
    hint: 'Зачётный и начисленный НДС сходятся',
    section: 'tax',
  },
];

// ── Акты сверки ─────────────────────────────────────────────────────────────

export type ReconciliationStatus = 'draft' | 'sent' | 'signed' | 'disputed' | 'cancelled';

export const RECONCILIATION_STATUS_LABELS: Record<ReconciliationStatus, string> = {
  draft: 'Черновик',
  sent: 'Отправлен контрагенту',
  signed: 'Подписан',
  disputed: 'Расхождения',
  cancelled: 'Аннулирован',
};

export type ReconciliationLineKind = 'document' | 'payment' | 'their';

export const RECONCILIATION_LINE_LABELS: Record<ReconciliationLineKind, string> = {
  document: 'Документ',
  payment: 'Оплата',
  their: 'Данные контрагента',
};

/** Диагноз по строке после сопоставления с данными контрагента. */
export type LineMatch = 'unknown' | 'match' | 'amount_diff' | 'only_ours' | 'only_theirs';

export const LINE_MATCH_LABELS: Record<LineMatch, string> = {
  unknown: 'Не сверяли',
  match: 'Сходится',
  amount_diff: 'Разные суммы',
  only_ours: 'Нет у контрагента',
  only_theirs: 'Нет у нас',
};

/**
 * Жизненный цикл акта. Таблица объявлена так же, как маршрут документа:
 * права и обязательность причины живут в данных, а не в ветвлениях кода.
 */
export type ReconciliationTransition = Transition<ReconciliationStatus>;

export const RECONCILIATION_TRANSITIONS: Record<ReconciliationStatus, ReconciliationTransition[]> = {
  draft: [
    { label: 'Отправить контрагенту', to: 'sent', roles: ['accountant', 'chief_accountant'] },
    { label: 'Аннулировать', to: 'cancelled', roles: ['chief_accountant'], requiresComment: true },
  ],
  sent: [
    { label: 'Подписан обеими сторонами', to: 'signed', roles: ['chief_accountant'] },
    { label: 'Зафиксировать расхождения', to: 'disputed', roles: ['accountant', 'chief_accountant'], requiresComment: true },
    { label: 'Аннулировать', to: 'cancelled', roles: ['chief_accountant'], requiresComment: true },
  ],
  disputed: [
    { label: 'Отправить исправленный', to: 'sent', roles: ['accountant', 'chief_accountant'] },
    { label: 'Подписан с протоколом', to: 'signed', roles: ['chief_accountant'], requiresComment: true },
    { label: 'Аннулировать', to: 'cancelled', roles: ['chief_accountant'], requiresComment: true },
  ],
  signed: [
    // Зеркало «отозвать согласование» у документа: подпись снимает только главбух.
    { label: 'Отозвать подпись', to: 'sent', roles: ['chief_accountant'], requiresComment: true },
  ],
  cancelled: [],
};

/**
 * Расхождение крупнее этого закрывает как «разобрано» только главбух —
 * перекличка с порогом согласования документа.
 * ВНИМАНИЕ: в тиынах, как и все суммы в системе.
 */
export const RECON_ACCEPT_THRESHOLD = 50_000 * 100;

/** Больше строк за раз из письма не принимаем — это уже выгрузка, а не сверка. */
export const MAX_IMPORT_LINES = 500;

/**
 * Реквизиты своей стороны для печатной формы. В системе одна организация,
 * отдельного справочника под неё нет — при внедрении он появится, и акт
 * станет первым его потребителем.
 */
export const OUR_COMPANY = {
  name: 'ТОО «Компания»',
  bin: '000000000000',
};

// ── Налоговый календарь ─────────────────────────────────────────────────────

export type TaxKind = 'declaration' | 'payment';

export const TAX_KIND_LABELS: Record<TaxKind, string> = {
  declaration: 'Отчётность',
  payment: 'Уплата',
};

export type TaxFrequency = 'monthly' | 'quarterly' | 'yearly';

export const TAX_FREQUENCY_LABELS: Record<TaxFrequency, string> = {
  monthly: 'Ежемесячно',
  quarterly: 'Ежеквартально',
  yearly: 'Раз в год',
};

export interface TaxRule {
  code: string;
  title: string;
  kind: TaxKind;
  frequency: TaxFrequency;
  /**
   * Срок = `dueDay` числа месяца, отстоящего на `monthOffset` от последнего
   * месяца отчётного периода. Для года последний месяц — декабрь, поэтому
   * смещение 3 даёт 31 марта следующего года.
   */
  monthOffset: number;
  dueDay: number;
  section: Section;
  hint: string;
}

/**
 * Сроки по налоговому кодексу РК. Выпадающие на выходной переносятся
 * на следующий рабочий день — это делает `server/taxCalendar.ts`.
 */
export const TAX_RULES: TaxRule[] = [
  {
    code: 'pay-ipn-soc',
    title: 'Уплата ИПН, ОПВ, СО и ВОСМС',
    kind: 'payment',
    frequency: 'monthly',
    monthOffset: 1,
    dueDay: 25,
    section: 'payroll',
    hint: 'Налоги и социальные платежи с зарплаты за отчётный месяц',
  },
  {
    code: 'fno-200',
    title: 'ФНО 200.00 — ИПН и социальные платежи',
    kind: 'declaration',
    frequency: 'quarterly',
    monthOffset: 2,
    dueDay: 15,
    section: 'payroll',
    hint: 'Квартальная декларация по доходам работников',
  },
  {
    code: 'fno-300',
    title: 'ФНО 300.00 — НДС',
    kind: 'declaration',
    frequency: 'quarterly',
    monthOffset: 2,
    dueDay: 15,
    section: 'tax',
    hint: 'Декларация по налогу на добавленную стоимость',
  },
  {
    code: 'pay-nds',
    title: 'Уплата НДС',
    kind: 'payment',
    frequency: 'quarterly',
    monthOffset: 2,
    dueDay: 25,
    section: 'tax',
    hint: 'НДС за отчётный квартал',
  },
  {
    code: 'fno-870',
    title: 'ФНО 870.00 — плата за эмиссии в окружающую среду',
    kind: 'declaration',
    frequency: 'quarterly',
    monthOffset: 2,
    dueDay: 15,
    section: 'tax',
    hint: 'Если есть объекты эмиссий',
  },
  {
    code: 'fno-100',
    title: 'ФНО 100.00 — КПН',
    kind: 'declaration',
    frequency: 'yearly',
    monthOffset: 3,
    dueDay: 31,
    section: 'tax',
    hint: 'Годовая декларация по корпоративному подоходному налогу',
  },
  {
    code: 'pay-kpn',
    title: 'Уплата КПН по декларации',
    kind: 'payment',
    frequency: 'yearly',
    monthOffset: 4,
    dueDay: 10,
    section: 'tax',
    hint: 'Доплата налога по итогам года',
  },
];

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
