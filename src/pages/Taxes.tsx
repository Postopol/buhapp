import { useState, useEffect, useCallback, Fragment } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Loader2, CheckCircle2, Circle, CalendarClock, X, FileText, Banknote,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { getTaxCalendar, toggleTaxEvent, saveTaxDetails } from '@/services/directory';
import { ApiError } from '@/services/api';
import { formatMoney, formatDate, parseMoney, plural } from '@/lib/format';
import { Chip } from '@/components/StatusChips';
import { TAX_KIND_LABELS } from '@shared/domain';
import { cn } from '@/lib/utils';
import type { TaxCalendar as Calendar, TaxEvent } from '@/types';

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

function monthKey(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function Taxes() {
  const { role } = useAuth();
  const [data, setData] = useState<Calendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [hideDone, setHideDone] = useState(false);
  const [editing, setEditing] = useState<TaxEvent | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getTaxCalendar()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить календарь'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const canEdit = role === 'accountant' || role === 'chief_accountant';

  const toggle = async (event: TaxEvent) => {
    if (!canEdit || !data) return;
    setActionError('');
    // Оптимистично: галочка должна отзываться мгновенно.
    setData({
      ...data,
      events: data.events.map((e) =>
        e.code === event.code && e.period === event.period ? { ...e, done: !e.done, overdue: false } : e
      ),
    });
    try {
      await toggleTaxEvent(event.code, event.period);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось отметить срок');
      load();
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Загрузка календаря…
      </div>
    );
  }

  if (error || !data) {
    return <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">{error}</div>;
  }

  const visible = hideDone ? data.events.filter((e) => !e.done) : data.events;

  // Группировка по месяцу срока — так календарь читается сверху вниз.
  const groups: { key: string; events: TaxEvent[] }[] = [];
  for (const event of visible) {
    const key = monthKey(event.dueDate);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, events: [event] });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Налоговый календарь</h2>
          <p className="text-slate-500">
            Сроки отчётности и уплаты с {formatDate(data.from)} по {formatDate(data.to)}
          </p>
        </div>
        <Button variant={hideDone ? 'secondary' : 'outline'} onClick={() => setHideDone((v) => !v)}>
          {hideDone ? 'Показывать сданные' : 'Скрыть сданные'}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Всего сроков в окне" value={String(data.summary.total)} />
        <Metric label="Отмечено сданными" value={String(data.summary.done)} tone="good" />
        <Metric label="Просрочено" value={String(data.summary.overdue)} tone={data.summary.overdue ? 'urgent' : 'normal'} />
        <Metric label="В ближайшие 2 недели" value={String(data.summary.soon)} tone={data.summary.soon ? 'attention' : 'normal'} />
      </div>

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-slate-400" />
            Сроки
          </CardTitle>
          <CardDescription>
            Даты, выпавшие на выходной, перенесены на понедельник. Праздники не учитываются
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {groups.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">Ничего не найдено</p>
          ) : (
            groups.map((group) => (
              <Fragment key={group.key}>
                <div className="sticky top-0 z-10 -mx-2 bg-white px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {group.key}
                </div>
                {group.events.map((event) => (
                  <div
                    key={`${event.code}:${event.period}`}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                      event.done
                        ? 'border-slate-100 bg-slate-50/50'
                        : event.overdue
                          ? 'border-red-200 bg-red-50/50'
                          : event.daysLeft <= 14
                            ? 'border-amber-200 bg-amber-50/40'
                            : 'border-slate-200 bg-white'
                    )}
                  >
                    <button
                      onClick={() => toggle(event)}
                      disabled={!canEdit}
                      className={cn('mt-0.5 shrink-0', canEdit ? 'cursor-pointer' : 'cursor-default')}
                      title={event.done ? 'Снять отметку' : 'Отметить сданным'}
                    >
                      {event.done ? (
                        <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                      ) : (
                        <Circle className="h-5 w-5 text-slate-300 hover:text-slate-400" />
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            'text-sm',
                            event.done ? 'text-slate-400 line-through' : 'font-medium text-slate-900'
                          )}
                        >
                          {event.title}
                        </span>
                        <Chip tone={event.kind === 'payment' ? 'info' : 'neutral'}>
                          {event.kind === 'payment' ? (
                            <Banknote className="h-3 w-3" />
                          ) : (
                            <FileText className="h-3 w-3" />
                          )}
                          {TAX_KIND_LABELS[event.kind]}
                        </Chip>
                        {event.shifted && (
                          <Chip tone="neutral" title="Срок выпал на выходной и перенесён">
                            перенесён
                          </Chip>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        за {event.periodLabel}
                        {event.responsibleName && ` · ${event.responsibleName}`}
                        {event.done && event.doneByName && ` · отметил ${event.doneByName}`}
                      </div>
                      {event.note && <div className="mt-1 text-xs italic text-slate-500">{event.note}</div>}
                    </div>

                    <div className="shrink-0 text-right">
                      <div
                        className={cn(
                          'text-sm font-medium tabular-nums',
                          event.done ? 'text-slate-400' : event.overdue ? 'text-red-700' : 'text-slate-900'
                        )}
                      >
                        {formatDate(event.dueDate)}
                      </div>
                      <div
                        className={cn(
                          'text-xs',
                          event.done ? 'text-slate-400' : event.overdue ? 'text-red-500' : 'text-slate-400'
                        )}
                      >
                        {event.done
                          ? 'сдано'
                          : event.overdue
                            ? `просрочен на ${plural(-event.daysLeft, 'день', 'дня', 'дней')}`
                            : event.daysLeft === 0
                              ? 'сегодня'
                              : `через ${plural(event.daysLeft, 'день', 'дня', 'дней')}`}
                      </div>
                      {event.amount !== null && (
                        <div className="mt-0.5 text-xs font-medium tabular-nums text-slate-600">
                          {formatMoney(event.amount)}
                        </div>
                      )}
                    </div>

                    {canEdit && (
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setEditing(event)}>
                        Сумма
                      </Button>
                    )}
                  </div>
                ))}
              </Fragment>
            ))
          )}
        </CardContent>
      </Card>

      {editing && (
        <DetailsModal
          event={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function DetailsModal({
  event,
  onClose,
  onSaved,
}: {
  event: TaxEvent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(event.amount !== null ? (event.amount / 100).toFixed(2) : '');
  const [note, setNote] = useState(event.note);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    let minor: number | null = null;
    if (amount.trim()) {
      minor = parseMoney(amount);
      if (minor === null) {
        setError('Некорректная сумма');
        return;
      }
    }
    setSaving(true);
    try {
      await saveTaxDetails(event.code, event.period, { amount: minor, note });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">{event.title}</h3>
            <p className="text-sm text-slate-500">за {event.periodLabel}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Сумма к уплате, ₸</span>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" inputMode="decimal" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Заметка</span>
            <textarea
              className="min-h-[70px] w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Например: платёжка ПП-412 от 24.08"
            />
          </label>
          {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Сохранить
            </Button>
          </div>
        </div>
      </div>
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
  tone?: 'normal' | 'urgent' | 'attention' | 'good';
}) {
  const styles =
    tone === 'urgent'
      ? 'border-red-200 bg-red-50/40 text-red-700'
      : tone === 'attention'
        ? 'border-amber-200 bg-amber-50/40 text-amber-700'
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
