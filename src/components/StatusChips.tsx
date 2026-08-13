import { cn } from '@/lib/utils';
import {
  APPROVAL_LABELS,
  ORIGINAL_LABELS,
  PAYMENT_LABELS,
  POSTING_LABELS,
  type ApprovalStatus,
  type OriginalStatus,
  type PaymentState,
  type PostingStatus,
} from '@shared/domain';

type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
  info: 'bg-sky-50 text-sky-700 border-sky-200',
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  bad: 'bg-red-50 text-red-700 border-red-200',
};

export function Chip({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

// Четыре статуса живут независимо, поэтому у каждого своя шкала цвета.

const APPROVAL_TONE: Record<ApprovalStatus, Tone> = {
  draft: 'neutral',
  review: 'warn',
  approved: 'good',
  returned: 'bad',
  rejected: 'bad',
};

export function ApprovalChip({ status }: { status: ApprovalStatus }) {
  return (
    <Chip tone={APPROVAL_TONE[status]} title="Статус согласования">
      {APPROVAL_LABELS[status]}
    </Chip>
  );
}

const ORIGINAL_TONE: Record<OriginalStatus, Tone> = {
  none: 'bad',
  scan: 'warn',
  received: 'info',
  signed: 'good',
};

const ORIGINAL_SHORT: Record<OriginalStatus, string> = {
  none: 'Нет оригинала',
  scan: 'Скан',
  received: 'Оригинал',
  signed: 'Подписан',
};

export function OriginalChip({ status }: { status: OriginalStatus }) {
  return (
    <Chip tone={ORIGINAL_TONE[status]} title={`Оригинал: ${ORIGINAL_LABELS[status]}`}>
      {ORIGINAL_SHORT[status]}
    </Chip>
  );
}

const PAYMENT_TONE: Record<PaymentState, Tone> = {
  unpaid: 'neutral',
  partial: 'warn',
  paid: 'good',
};

export function PaymentChip({ state }: { state: PaymentState }) {
  return (
    <Chip tone={PAYMENT_TONE[state]} title="Статус оплаты">
      {PAYMENT_LABELS[state]}
    </Chip>
  );
}

export function PostingChip({ status }: { status: PostingStatus }) {
  return (
    <Chip tone={status === 'posted' ? 'good' : 'neutral'} title="Статус учёта">
      {POSTING_LABELS[status]}
    </Chip>
  );
}
