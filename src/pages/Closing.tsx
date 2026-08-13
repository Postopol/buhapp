import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader2, Lock, LockOpen, CheckCircle2, Circle, AlertTriangle, ArrowRight, X, CalendarCheck,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { listPeriods, getPeriod, toggleClosingTask, closePeriod, reopenPeriod } from '@/services/directory';
import { ApiError } from '@/services/api';
import { formatMoneyShort, formatPeriod, formatDateTime, plural } from '@/lib/format';
import { Chip } from '@/components/StatusChips';
import { cn } from '@/lib/utils';
import type { PeriodDetail, PeriodSummaryRow } from '@/types';

export function Closing() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [periods, setPeriods] = useState<PeriodSummaryRow[]>([]);
  const [detail, setDetail] = useState<PeriodDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showReopen, setShowReopen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  const selected = params.get('period');

  useEffect(() => {
    listPeriods()
      .then((res) => {
        setPeriods(res.periods);
        if (!selected) {
          setParams({ period: res.current }, { replace: true });
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить периоды'));
  }, [selected, setParams]);

  const load = useCallback(() => {
    if (!selected) return;
    setLoading(true);
    setError('');
    getPeriod(selected)
      .then((res) => setDetail(res.period))
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить период'))
      .finally(() => setLoading(false));
  }, [selected]);

  useEffect(() => {
    load();
  }, [load]);

  const isChief = role === 'chief_accountant';
  const canEdit = role === 'accountant' || role === 'chief_accountant';

  const runToggle = async (taskId: number) => {
    if (!detail) return;
    setActionError('');
    try {
      const res = await toggleClosingTask(detail.period, taskId);
      setDetail(res.period);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось изменить пункт');
    }
  };

  const runClose = async () => {
    if (!detail) return;
    setActionError('');
    setBusy(true);
    try {
      const res = await closePeriod(detail.period);
      setDetail(res.period);
      setPeriods((prev) =>
        prev.map((p) => (p.period === res.period.period ? { ...p, status: 'closed' } : p))
      );
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось закрыть период');
    } finally {
      setBusy(false);
    }
  };

  const runReopen = async () => {
    if (!detail || !reopenReason.trim()) return;
    setActionError('');
    setBusy(true);
    try {
      const res = await reopenPeriod(detail.period, reopenReason);
      setDetail(res.period);
      setPeriods((prev) =>
        prev.map((p) => (p.period === res.period.period ? { ...p, status: 'open' } : p))
      );
      setShowReopen(false);
      setReopenReason('');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось открыть период');
    } finally {
      setBusy(false);
    }
  };

  const openBlocker = (filter: Record<string, string>) => {
    navigate(`/documents?${new URLSearchParams(filter).toString()}`);
  };

  if (loading && !detail) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Загрузка…
      </div>
    );
  }

  if (error && !detail) {
    return <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">{error}</div>;
  }

  if (!detail) return null;

  const closed = detail.status === 'closed';
  const blocking = detail.blockers.filter((b) => b.count > 0);
  const progress = detail.tasksTotal > 0 ? Math.round((detail.tasksDone / detail.tasksTotal) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Закрытие месяца</h2>
          <p className="text-slate-500">Что мешает закрыть период и что осталось сделать</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
            value={detail.period}
            onChange={(e) => setParams({ period: e.target.value })}
          >
            {periods.map((p) => (
              <option key={p.period} value={p.period}>
                {formatPeriod(p.period)}
                {p.status === 'closed' ? ' — закрыт' : ''}
              </option>
            ))}
          </select>

          {closed ? (
            isChief && (
              <Button variant="outline" className="gap-2" onClick={() => setShowReopen(true)}>
                <LockOpen className="h-4 w-4" />
                Открыть заново
              </Button>
            )
          ) : (
            isChief && (
              <Button className="gap-2" disabled={busy || !detail.canClose} onClick={runClose}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                Закрыть {formatPeriod(detail.period)}
              </Button>
            )
          )}
        </div>
      </div>

      {closed && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
          <Lock className="h-5 w-5 shrink-0 text-emerald-600" />
          <div className="text-sm text-emerald-900">
            <span className="font-medium">Период закрыт.</span> {detail.closedByName},{' '}
            {formatDateTime(detail.closedAt)}. Документы этого месяца изменить нельзя.
          </div>
        </div>
      )}

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</div>
      )}

      {/* Сводка */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Документов в периоде" value={String(detail.documents)} />
        <Metric label="Сумма" value={formatMoneyShort(detail.amount)} />
        <Metric label="в т.ч. НДС" value={formatMoneyShort(detail.vat)} />
        <Metric
          label="Блокировок"
          value={String(detail.blockingCount)}
          tone={detail.blockingCount > 0 ? 'urgent' : 'good'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Блокировки — считаются автоматически, галочкой не убираются */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className={cn('h-4 w-4', blocking.length ? 'text-red-500' : 'text-emerald-500')} />
              Блокировки
            </CardTitle>
            <CardDescription>
              Считаются из документов. Пропадают, только когда исчезает причина
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {detail.blockers.map((blocker) => {
              const clean = blocker.count === 0;
              return (
                <button
                  key={blocker.key}
                  disabled={clean}
                  onClick={() => openBlocker(blocker.filter)}
                  className={cn(
                    'group flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                    clean
                      ? 'border-slate-100 bg-slate-50/50'
                      : 'border-red-200 bg-red-50/50 hover:border-red-300'
                  )}
                >
                  {clean ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-sm font-medium', clean ? 'text-slate-400' : 'text-slate-900')}>
                      {blocker.title}
                    </div>
                    <div className="text-xs text-slate-500">{clean ? 'Чисто' : blocker.hint}</div>
                  </div>
                  {!clean && (
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-bold tabular-nums text-red-700">{blocker.count}</div>
                      {blocker.amount > 0 && (
                        <div className="text-xs tabular-nums text-slate-500">
                          {formatMoneyShort(blocker.amount)}
                        </div>
                      )}
                    </div>
                  )}
                  {!clean && (
                    <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500" />
                  )}
                </button>
              );
            })}
          </CardContent>
        </Card>

        {/* Чек-лист — ручные пункты */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarCheck className="h-4 w-4 text-slate-400" />
                  Чек-лист
                </CardTitle>
                <CardDescription>
                  {detail.tasksDone} из {detail.tasksTotal} выполнено
                </CardDescription>
              </div>
              <span className="text-2xl font-bold tabular-nums text-slate-900">{progress}%</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={cn('h-full rounded-full transition-all', progress === 100 ? 'bg-emerald-500' : 'bg-slate-900')}
                style={{ width: `${progress}%` }}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {detail.tasks.map((task) => (
              <button
                key={task.id}
                disabled={!canEdit || closed}
                onClick={() => runToggle(task.id)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                  canEdit && !closed && 'hover:bg-slate-50',
                  (!canEdit || closed) && 'cursor-default'
                )}
              >
                {task.done ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                )}
                <div className="min-w-0 flex-1">
                  <div className={cn('text-sm', task.done ? 'text-slate-400 line-through' : 'font-medium text-slate-900')}>
                    {task.title}
                  </div>
                  <div className="text-xs text-slate-400">
                    {task.done && task.doneByName
                      ? `${task.doneByName}, ${formatDateTime(task.doneAt)}`
                      : task.hint}
                  </div>
                </div>
                {!task.done && task.responsibleName && (
                  <Chip tone="neutral" className="shrink-0">
                    {task.responsibleName.split(' ')[0]}
                  </Chip>
                )}
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      {!closed && (
        <div
          className={cn(
            'rounded-lg border px-4 py-3 text-sm',
            detail.canClose
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-slate-200 bg-slate-50 text-slate-600'
          )}
        >
          {detail.canClose ? (
            <>
              <span className="font-medium">Период готов к закрытию.</span>{' '}
              {isChief ? 'Нажмите «Закрыть» вверху.' : 'Закрывает главный бухгалтер.'}
            </>
          ) : (
            <>
              Осталось: {blocking.length > 0 && `${plural(detail.blockingCount, 'документ', 'документа', 'документов')} с блокировками`}
              {blocking.length > 0 && detail.tasksDone < detail.tasksTotal && ', '}
              {detail.tasksDone < detail.tasksTotal &&
                `${plural(detail.tasksTotal - detail.tasksDone, 'пункт', 'пункта', 'пунктов')} чек-листа`}
              .
            </>
          )}
        </div>
      )}

      {showReopen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-900">
                Открыть {formatPeriod(detail.period)} заново
              </h3>
              <button onClick={() => setShowReopen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              Повторное открытие закрытого месяца попадёт в аудит с указанием причины.
            </p>
            <textarea
              className="mt-4 min-h-[90px] w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
              placeholder="Например: поставщик прислал корректировочный счёт-фактуру"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowReopen(false)}>
                Отмена
              </Button>
              <Button disabled={busy || !reopenReason.trim()} onClick={runReopen}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Открыть период
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'urgent' | 'good';
}) {
  const styles =
    tone === 'urgent'
      ? 'border-red-200 bg-red-50/40 text-red-700'
      : tone === 'good'
        ? 'border-emerald-200 bg-emerald-50/40 text-emerald-700'
        : 'border-slate-200 bg-white text-slate-900';
  return (
    <div className={cn('rounded-xl border p-4', styles)}>
      <div className="text-sm font-medium text-slate-600">{label}</div>
      <div className="mt-1.5 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
