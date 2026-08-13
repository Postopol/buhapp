import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Loader2, ArrowRight, FileText, AlertTriangle, Clock } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { getWorkspace } from '@/services/directory';
import { formatMoneyShort, formatPeriod, formatDateTime, plural } from '@/lib/format';
import { ApprovalChip } from '@/components/StatusChips';
import { DOC_TYPE_SHORT, SECTION_LABELS } from '@shared/domain';
import { cn } from '@/lib/utils';
import type { Workspace as WorkspaceData } from '@/types';

const TONE_STYLES = {
  urgent: {
    card: 'border-red-200 bg-red-50/40 hover:border-red-300',
    count: 'text-red-700',
    icon: 'text-red-500',
  },
  attention: {
    card: 'border-amber-200 bg-amber-50/40 hover:border-amber-300',
    count: 'text-amber-700',
    icon: 'text-amber-500',
  },
  normal: {
    card: 'border-slate-200 bg-white hover:border-slate-300',
    count: 'text-slate-900',
    icon: 'text-slate-400',
  },
} as const;

export function Workspace() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getWorkspace()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить данные');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Загрузка…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
        <p className="font-medium">Ошибка загрузки</p>
        <p className="mt-1 text-sm">{error}</p>
      </div>
    );
  }

  const firstName = user?.name.split(' ')[1] ?? user?.name ?? '';
  const openQueue = (filter: Record<string, string>) => {
    navigate(`/documents?${new URLSearchParams(filter).toString()}`);
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">
          {firstName ? `Здравствуйте, ${firstName}` : 'Рабочее место'}
        </h2>
        <p className="text-slate-500">
          {user?.section ? `Участок «${SECTION_LABELS[user.section]}»` : user?.department ?? 'Бухгалтерия'}
          {' · '}
          Период {formatPeriod(data.period.period)}
        </p>
      </div>

      {/* Очереди — то, что требует действия именно сейчас */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.queues.map((queue) => {
          const styles = TONE_STYLES[queue.tone];
          const empty = queue.count === 0;
          return (
            <button
              key={queue.key}
              onClick={() => openQueue(queue.filter)}
              className={cn(
                'group rounded-xl border p-5 text-left transition-colors',
                empty ? 'border-slate-200 bg-white hover:border-slate-300' : styles.card
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-semibold text-slate-700">{queue.title}</span>
                {queue.tone === 'urgent' && !empty && (
                  <AlertTriangle className={cn('h-4 w-4 shrink-0', styles.icon)} />
                )}
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className={cn('text-3xl font-bold tabular-nums', empty ? 'text-slate-300' : styles.count)}>
                  {queue.count}
                </span>
                {queue.amount > 0 && (
                  <span className="text-sm text-slate-500 tabular-nums">
                    {formatMoneyShort(queue.amount)}
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">{queue.hint}</p>
              {!empty && (
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-slate-600 group-hover:text-slate-900">
                  Открыть в реестре
                  <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Сводка по периоду */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Период {formatPeriod(data.period.period)}</CardTitle>
            <CardDescription>Что уже попало в текущий месяц</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Документов" value={String(data.period.documents)} />
            <Row label="Сумма" value={formatMoneyShort(data.period.amount)} />
            <Row label="в т.ч. НДС" value={formatMoneyShort(data.period.vat)} muted />
            <div className="border-t border-slate-100 pt-3">
              <Row
                label="Не проведено в учёте"
                value={String(data.period.notPosted)}
                alert={data.period.notPosted > 0}
              />
              <Row
                label="Без оригинала"
                value={String(data.period.missingOriginals)}
                alert={data.period.missingOriginals > 0}
              />
            </div>
            {(data.period.notPosted > 0 || data.period.missingOriginals > 0) && (
              <p className="rounded-md bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-800">
                Период нельзя закрыть, пока остаются непроведённые документы и недостающие оригиналы.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Недавние — вернуться к тому, с чем работал */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-slate-400" />
              Последние изменения
            </CardTitle>
            <CardDescription>Документы, которые двигались недавно</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">Пока ничего нет</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {data.recent.map((doc) => (
                  <Link
                    key={doc.id}
                    to={`/documents/${doc.id}`}
                    className="-mx-2 flex items-center gap-3 rounded px-2 py-2.5 hover:bg-slate-50"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-slate-300" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-900">
                        {DOC_TYPE_SHORT[doc.type]} {doc.number}
                        {doc.counterpartyName && (
                          <span className="font-normal text-slate-500"> · {doc.counterpartyName}</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400">{formatDateTime(doc.updatedAt)}</div>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-slate-700">
                      {formatMoneyShort(doc.amount)}
                    </span>
                    <ApprovalChip status={doc.approvalStatus} />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-slate-400">
        Всего в очередях{' '}
        {plural(
          data.queues.reduce((sum, q) => sum + q.count, 0),
          'документ',
          'документа',
          'документов'
        )}
        .
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  muted,
  alert,
}: {
  label: string;
  value: string;
  muted?: boolean;
  alert?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className={cn('text-slate-500', muted && 'text-xs')}>{label}</span>
      <span
        className={cn(
          'font-medium tabular-nums',
          alert ? 'text-amber-700' : muted ? 'text-xs text-slate-500' : 'text-slate-900'
        )}
      >
        {value}
      </span>
    </div>
  );
}
