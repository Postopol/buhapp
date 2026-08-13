import type {
  ApprovalStatus,
  DocType,
  OriginalStatus,
  PaymentState,
  PostingStatus,
  Role,
  Section,
} from '@shared/domain';

export type { ApprovalStatus, DocType, OriginalStatus, PaymentState, PostingStatus, Role, Section };

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  section: Section | null;
  department: string | null;
}

/** Все денежные поля приходят в тиынах — форматирует `formatMoney`. */
export interface Document {
  id: number;
  type: DocType;
  number: string;
  docDate: string;
  dueDate: string | null;
  period: string;
  counterpartyId: number | null;
  counterpartyName: string | null;
  counterpartyBin: string | null;
  contractId: number | null;
  contractNumber: string | null;
  expenseItemId: number | null;
  expenseItemName: string | null;
  expenseItemCode: string | null;
  amount: number;
  vat: number;
  paid: number;
  paymentState: PaymentState;
  purpose: string;
  section: Section;
  responsibleId: number | null;
  responsibleName: string | null;
  createdById: number | null;
  createdByName: string | null;
  approvalStatus: ApprovalStatus;
  originalStatus: OriginalStatus;
  postingStatus: PostingStatus;
  createdAt: string;
  updatedAt: string;
  attachmentsCount: number;
  commentsCount: number;
  overdue: boolean;
  periodClosed: boolean;
}

export interface Attachment {
  id: number;
  filename: string;
  mime: string;
  size: number;
  uploadedAt: string;
  uploadedByName: string | null;
}

export interface Comment {
  id: number;
  userName: string;
  body: string;
  kind: string;
  createdAt: string;
}

export interface HistoryEntry {
  id: number;
  action: string;
  userName: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface DocumentPayment {
  id: number;
  paymentDate: string;
  reference: string;
  bankAccount: string;
  amount: number;
}

export interface ClosingBlocker {
  key: string;
  title: string;
  hint: string;
  count: number;
  amount: number;
  filter: Record<string, string>;
}

export interface ClosingTask {
  id: number;
  title: string;
  hint: string;
  responsibleId: number | null;
  responsibleName: string | null;
  done: boolean;
  doneAt: string | null;
  doneByName: string | null;
  note: string;
}

export interface PeriodDetail {
  period: string;
  status: 'open' | 'closed';
  statusLabel: string;
  closedAt: string | null;
  closedByName: string | null;
  documents: number;
  amount: number;
  vat: number;
  blockers: ClosingBlocker[];
  blockingCount: number;
  tasks: ClosingTask[];
  tasksDone: number;
  tasksTotal: number;
  canClose: boolean;
}

export interface PeriodSummaryRow {
  period: string;
  status: 'open' | 'closed';
  closedAt: string | null;
  documents: number;
  tasksDone: number;
  tasksTotal: number;
}

export interface DocumentDetail extends Document {
  attachments: Attachment[];
  comments: Comment[];
  history: HistoryEntry[];
  payments: DocumentPayment[];
}

export interface DocumentTotals {
  amount: number;
  vat: number;
  paid: number;
  unpaid: number;
}

export interface DocumentListResponse {
  documents: Document[];
  total: number;
  totals: DocumentTotals;
  limit: number;
  offset: number;
}

export interface Counterparty {
  id: number;
  bin: string;
  name: string;
  isVatPayer: boolean;
  bankName: string;
  bankBic: string;
  iban: string;
  responsibleId: number | null;
  responsibleName: string | null;
  note: string;
  createdAt: string;
  accrued?: number;
  paid?: number;
  debt?: number;
  documentsCount?: number;
  missingOriginals?: number;
}

export interface CounterpartyContract {
  id: number;
  number: string;
  date: string;
  subject: string;
  amount: number;
  validUntil: string | null;
  expired: boolean;
}

export interface CounterpartyDetail extends Counterparty {
  accrued: number;
  paid: number;
  debt: number;
  documentsCount: number;
  missingOriginals: number;
  contracts: CounterpartyContract[];
}

export interface Queue {
  key: string;
  title: string;
  hint: string;
  tone: 'urgent' | 'attention' | 'normal';
  count: number;
  amount: number;
  filter: Record<string, string>;
}

export interface PeriodSummary {
  period: string;
  documents: number;
  amount: number;
  vat: number;
  notPosted: number;
  missingOriginals: number;
}

export interface RecentDocument {
  id: number;
  type: DocType;
  number: string;
  docDate: string;
  amount: number;
  approvalStatus: ApprovalStatus;
  updatedAt: string;
  counterpartyName: string | null;
}

export interface TaxEvent {
  code: string;
  title: string;
  kind: 'declaration' | 'payment';
  frequency: 'monthly' | 'quarterly' | 'yearly';
  section: Section;
  hint: string;
  period: string;
  periodLabel: string;
  dueDate: string;
  shifted: boolean;
  done: boolean;
  doneAt: string | null;
  doneByName: string | null;
  amount: number | null;
  note: string;
  responsibleName: string | null;
  daysLeft: number;
  overdue: boolean;
}

export interface TaxCalendar {
  events: TaxEvent[];
  from: string;
  to: string;
  today: string;
  summary: { total: number; done: number; overdue: number; soon: number };
}

export interface Workspace {
  queues: Queue[];
  deadlines: TaxEvent[];
  period: PeriodSummary;
  recent: RecentDocument[];
}

export interface Dictionaries {
  expenseItems: { id: number; code: string; name: string }[];
  counterparties: { id: number; bin: string; name: string; iban: string; isVatPayer: boolean }[];
  users: { id: number; name: string; role: Role; section: Section | null }[];
  periods: string[];
  contracts: { id: number; number: string; counterpartyId: number; subject: string }[];
}

export interface PayableDocument {
  id: number;
  number: string;
  type: DocType;
  docDate: string;
  dueDate: string | null;
  amount: number;
  paid: number;
  outstanding: number;
  purpose: string;
  counterpartyName: string | null;
  iban: string | null;
  bin: string | null;
  expenseItemName: string | null;
}

export interface PaymentAllocation {
  documentId: number;
  documentNumber: string;
  documentType: DocType;
  counterpartyName: string | null;
  amount: number;
}

export interface Payment {
  id: number;
  paymentDate: string;
  amount: number;
  allocated: number;
  unallocated: number;
  bankAccount: string;
  reference: string;
  note: string;
  createdAt: string;
  createdByName: string | null;
  allocations: PaymentAllocation[];
}

export interface BulkResult {
  applied: number[];
  skipped: { id: number; number: string; reason: string }[];
}
