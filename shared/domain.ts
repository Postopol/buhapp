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

export type TaxFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'yearly';

export const TAX_FREQUENCY_LABELS: Record<TaxFrequency, string> = {
  monthly: 'Ежемесячно',
  quarterly: 'Ежеквартально',
  semiannual: 'Раз в полгода',
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
   * Смещение бывает отрицательным: авансовые платежи и налог на транспорт
   * платятся ВНУТРИ своего отчётного года, до его окончания.
   */
  monthOffset: number;
  dueDay: number;
  section: Section;
  hint: string;
}

/**
 * Нерабочие праздничные дни РК. Нужны налоговому календарю: срок, выпавший
 * на нерабочий день, переносится на следующий рабочий (`server/taxCalendar.ts`).
 *
 * Список захардкожен и его придётся продлевать раз в год — это осознанная цена
 * отказа от внешнего справочника: онлайн-календаря праздников РК с внятным API
 * нет, а тянуть его через парсер значит поставить сроки уплаты налогов
 * в зависимость от чужой вёрстки. Один коммит в декабре дешевле.
 *
 * ВНИМАНИЕ: перенос выходных отдельным постановлением правительства
 * (те самые «рабочие субботы» вокруг длинных праздников) тут НЕ учтён —
 * постановление выходит в конце предыдущего года и меняется от года к году.
 * Не учтён и перенос выходного по ст. 84 ТК РК, когда праздник совпал
 * с субботой или воскресеньем. Оба случая двигают срок только вперёд,
 * поэтому календарь может показать срок на день-два раньше настоящего —
 * в безопасную сторону.
 */
export const KZ_HOLIDAYS: string[] = [
  // 2025
  '2025-01-01', '2025-01-02', // Новый год
  '2025-01-07', // Рождество
  '2025-03-08', // Международный женский день
  '2025-03-21', '2025-03-22', '2025-03-23', // Наурыз мейрамы
  '2025-05-01', // Праздник единства народа Казахстана
  '2025-05-07', // День защитника Отечества
  '2025-05-09', // День Победы
  '2025-07-06', // День столицы
  '2025-08-30', // День Конституции
  '2025-10-25', // День Республики
  '2025-12-16', // День Независимости
  // 2026
  '2026-01-01', '2026-01-02',
  '2026-01-07',
  '2026-03-08',
  '2026-03-21', '2026-03-22', '2026-03-23',
  '2026-05-01',
  '2026-05-07',
  '2026-05-09',
  '2026-07-06',
  '2026-08-30',
  '2026-10-25',
  '2026-12-16',
  // 2027
  '2027-01-01', '2027-01-02',
  '2027-01-07',
  '2027-03-08',
  '2027-03-21', '2027-03-22', '2027-03-23',
  '2027-05-01',
  '2027-05-07',
  '2027-05-09',
  '2027-07-06',
  '2027-08-30',
  '2027-10-25',
  '2027-12-16',
];

/**
 * Сроки по налоговому кодексу РК. Выпадающие на выходной или праздник
 * переносятся на следующий рабочий день — это делает `server/taxCalendar.ts`.
 */
export const TAX_RULES: TaxRule[] = [
  {
    code: 'pay-ipn-soc',
    // Перечислены все платежи, идущие 25 числа: раньше в заголовке не было
    // соцналога и ОПВР, и бухгалтер по нему занижал сумму к уплате.
    title: 'Уплата ИПН, ОПВ, ОПВР, СО, СН и ВОСМС',
    kind: 'payment',
    frequency: 'monthly',
    monthOffset: 1,
    dueDay: 25,
    section: 'payroll',
    hint: 'Одной датой с зарплаты за отчётный месяц: ИПН, ОПВ, ОПВР (взносы работодателя, с 2024), соцотчисления, социальный налог, ВОСМС и ООСМС',
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
  {
    code: 'fno-700',
    title: 'ФНО 700.00 — имущество, земля и транспорт',
    kind: 'declaration',
    frequency: 'yearly',
    monthOffset: 3,
    dueDay: 31,
    section: 'tax',
    hint: 'Годовая декларация сразу по трём налогам на объекты: здания и сооружения, земельные участки, транспортные средства',
  },
  {
    code: 'pay-700',
    title: 'Уплата налогов по декларации 700.00',
    kind: 'payment',
    frequency: 'yearly',
    monthOffset: 4,
    dueDay: 10,
    section: 'tax',
    hint: 'Окончательный расчёт по имуществу и земле за минусом уплаченных за год авансов',
  },
  {
    // Авансы платятся ВНУТРИ отчётного года, отсюда отрицательное смещение:
    // конец I квартала (март) минус месяц = 25 февраля, и так по всем кварталам.
    code: 'pay-property-advance',
    title: 'Авансовый платёж по налогу на имущество и земельному',
    kind: 'payment',
    frequency: 'quarterly',
    monthOffset: -1,
    dueDay: 25,
    section: 'tax',
    hint: 'Равными долями от расчётной суммы за год: 25 февраля, 25 мая, 25 августа и 25 ноября текущего года',
  },
  {
    // Тоже платёж внутри своего года: декабрь минус пять месяцев = июль.
    code: 'pay-transport',
    title: 'Уплата налога на транспортные средства',
    kind: 'payment',
    frequency: 'yearly',
    monthOffset: -5,
    dueDay: 5,
    section: 'tax',
    hint: 'За текущий год — до 5 июля этого же года, по всем машинам, числящимся за компанией',
  },
  {
    code: 'fno-910',
    title: 'ФНО 910.00 — упрощённая декларация',
    kind: 'declaration',
    frequency: 'semiannual',
    monthOffset: 2,
    dueDay: 15,
    section: 'tax',
    hint: 'Только для СНР на основе упрощённой декларации: за I полугодие — до 15 августа, за II — до 15 февраля следующего года',
  },
];

// ── НДС ─────────────────────────────────────────────────────────────────────

/**
 * Ставка НДС — функция от даты документа, а не константа.
 * С 01.01.2026 новый Налоговый кодекс РК поднял базовую ставку с 12 % до 16 %,
 * но документы прошлых лет обязаны навсегда сохранить свою ставку: счёт от
 * декабря 2025 года содержит 12 % и в 2027 году, иначе при перепроведении,
 * акте сверки или уточнёнке по ФНО 300.00 суммы разойдутся с уже сданной
 * отчётностью. Одна константа этого не умеет — отсюда таблица периодов.
 *
 * Отсортировано по УБЫВАНИЮ `from`: подходит первая же строка сверху.
 */
export const VAT_RATES: { from: string; rate: number }[] = [
  { from: '2026-01-01', rate: 0.16 },
  { from: '1900-01-01', rate: 0.12 },
];

/** Ставка НДС, действовавшая на дату документа (ISO `YYYY-MM-DD`). */
export function vatRateOn(docDate: string): number {
  const found = VAT_RATES.find((r) => docDate >= r.from);
  // Дата раньше самой ранней строки — берём самую старую ставку, а не 0:
  // нулевая ставка молча обнулила бы НДС и прошла бы незамеченной.
  return (found ?? VAT_RATES[VAT_RATES.length - 1]).rate;
}

/**
 * Выделение НДС из суммы С налогом: в первичке РК сумма указывается с НДС,
 * а хранится у нас именно она. Округление до тиына делается ровно один раз,
 * иначе «сумма без НДС + НДС» перестаёт сходиться с итогом документа.
 */
export function vatFromGross(amountMinor: number, docDate: string): number {
  const rate = vatRateOn(docDate);
  return Math.round((amountMinor * rate) / (1 + rate));
}

// ── Маски ввода ─────────────────────────────────────────────────────────────

/**
 * Отчётный месяц `YYYY-MM`. Месяц строго 01–12: ленивая маска `\d{2}`
 * пропускала «2026-13» и «2026-99», и такой период спокойно создавался
 * в базе, а потом навсегда висел в реестре мусорной строкой.
 */
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Дата в ISO `YYYY-MM-DD`. Тоже строгая: `\d{2}-\d{2}` принимала «2026-02-31»
 * и «2026-99-99», после чего сравнение дат строками давало бессмыслицу.
 * Существование числа в конкретном месяце маской не проверить — 31 февраля
 * она пропустит, это остаётся на разборе даты.
 */
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Период налогового календаря: год, месяц, квартал или полугодие —
 * `2026`, `2026-07`, `2026-Q3`, `2026-H1`. Форма периода задаётся
 * частотой правила (`TaxFrequency`), поэтому маска шире `PERIOD_RE`.
 */
export const TAX_PERIOD_RE = /^\d{4}(-(0[1-9]|1[0-2]|Q[1-4]|H[12]))?$/;

// ── Прочее ──────────────────────────────────────────────────────────────────

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
