import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Loader2, X, Scale } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { listReconciliations, createReconciliation, previewReconciliation } from '@/services/reconciliations';
import { getDictionaries } from '@/services/directory';
import { ApiError } from '@/services/api';
import { formatMoney, formatAmount } from '@/lib/format';
import { ReconciliationChip } from '@/components/StatusChips';
import { RECONCILIATION_STATUS_LABELS, type ReconciliationStatus } from '@shared/domain';
import { cn } from '@/lib/utils';
import type { Dictionaries, Reconciliation, ReconciliationStatement } from '@/types';

/** Что вообще живёт в URL. Ссылка на выборку должна пересылаться как есть. */
const FILTER_KEYS = ['counterparty', 'status', 'period'] as const;

/** Прошлый месяц целиком — период, за который сверяются в подавляющем большинстве случаев. */
function lastMonthRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last) };
}

export function Reconciliations() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const [params, setParams] = useSearchParams();

  const [acts, setActs] = useState<Reconciliation[]>([]);
  const [stats, setStats] = useState({ total: 0, disputed: 0, signed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const filters = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, params.get(key) ?? ''])
  ) as Record<(typeof FILTER_KEYS)[number], string>;

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    // Фильтры меняются быстрее, чем отвечает сервер: без отсечки ответ на
    // прошлый запрос перезапишет список и счётчики уже под новым фильтром.
    let cancelled = false;
    setLoading(true);
    listReconciliations({
      counterparty: params.get('counterparty') ?? undefined,
      status: params.get('status') ?? undefined,
      period: params.get('period') ?? undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setActs(res.acts);
        setStats({ total: res.total, disputed: res.disputed, signed: res.signed });
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить акты');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params]);

  const canCreate = role === 'accountant' || role === 'chief_accountant';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Акты сверки</h2>
          <p className="text-slate-500">Расчёты с контрагентами: обороты, сальдо и разбор расхождений</p>
        </div>
        {canCreate && (
          <Button className="gap-2" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            Сформировать акт
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="Всего актов" value={String(stats.total)} />
        <Metric label="Подписано" value={String(stats.signed)} tone={stats.signed ? 'good' : 'normal'} />
        <Metric
          label="С расхождениями"
          value={String(stats.disputed)}
          tone={stats.disputed ? 'urgent' : 'normal'}
        />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm"
              value={filters.status || 'all'}
              onChange={(e) => setFilter('status', e.target.value)}
            >
              <option value="all">Все статусы</option>
              {(Object.keys(RECONCILIATION_STATUS_LABELS) as ReconciliationStatus[]).map((s) => (
                <option key={s} value={s}>
                  {RECONCILIATION_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <Input
              type="month"
              className="h-9 w-44"
              value={filters.period}
              onChange={(e) => setFilter('period', e.target.value)}
              title="Акты, пересекающиеся с этим месяцем"
            />
            {(filters.status || filters.period || filters.counterparty) && (
              <Button variant="ghost" size="sm" className="gap-1" onClick={() => setParams({}, { replace: true })}>
                <X className="h-3.5 w-3.5" />
                Сбросить
              </Button>
            )}
          </div>

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          ) : loading && acts.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Загрузка…
            </div>
          ) : acts.length === 0 ? (
            <div className="py-14 text-center">
              <Scale className="mx-auto h-8 w-8 text-slate-200" />
              <p className="mt-3 text-sm text-slate-400">Актов пока нет</p>
            </div>
          ) : (
            <div className={cn('transition-opacity', loading && 'opacity-50')}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-2">Акт</TableHead>
                    <TableHead className="px-2">Контрагент</TableHead>
                    <TableHead className="px-2">Период</TableHead>
                    <TableHead className="px-2 text-right">Наше сальдо</TableHead>
                    <TableHead className="px-2 text-right">По данным контрагента</TableHead>
                    <TableHead className="px-2 text-right">Расхождение</TableHead>
                    <TableHead className="px-2">Статус</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {acts.map((act) => (
                    <TableRow
                      key={act.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/reconciliations/${act.id}`)}
                    >
                      <TableCell className="whitespace-nowrap px-2 py-2 font-medium text-slate-900">
                        {act.number}
                      </TableCell>
                      <TableCell className="px-2 py-2">
                        <div className="text-slate-900">{act.counterpartyName}</div>
                        <div className="font-mono text-xs text-slate-400">{act.counterpartyBin}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap px-2 py-2 text-sm text-slate-500">
                        {act.from} — {act.to}
                      </TableCell>
                      <TableCell className="whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums">
                        {formatAmount(act.closing)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-slate-500">
                        {act.theirClosing === null ? '—' : formatAmount(act.theirClosing)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums',
                          act.diff ? 'text-red-700' : 'text-slate-400'
                        )}
                      >
                        {act.diff === null ? '—' : act.diff === 0 ? 'сходится' : formatAmount(act.diff)}
                      </TableCell>
                      <TableCell className="px-2 py-2">
                        <ReconciliationChip status={act.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => navigate(`/reconciliations/${id}`)}
        />
      )}
    </div>
  );
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const range = lastMonthRange();
  const [dictionaries, setDictionaries] = useState<Dictionaries | null>(null);
  const [counterpartyId, setCounterpartyId] = useState('');
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [preview, setPreview] = useState<ReconciliationStatement | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getDictionaries().then(setDictionaries).catch(() => setError('Не удалось загрузить справочники'));
  }, []);

  // Показываем расчёт до создания: акт заводят, когда цифры уже понятны.
  useEffect(() => {
    if (!counterpartyId || !from || !to || from > to) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    previewReconciliation(Number(counterpartyId), from, to)
      .then((res) => !cancelled && setPreview(res.statement))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [counterpartyId, from, to]);

  const submit = async () => {
    setError('');
    if (!counterpartyId) {
      setError('Выберите контрагента');
      return;
    }
    if (from > to) {
      setError('Начало периода позже конца');
      return;
    }
    setSaving(true);
    try {
      const res = await createReconciliation({ counterpartyId: Number(counterpartyId), from, to });
      onCreated(res.act.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сформировать акт');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-slate-900">Сформировать акт сверки</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Контрагент</span>
            <select
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm"
              value={counterpartyId}
              onChange={(e) => setCounterpartyId(e.target.value)}
            >
              <option value="">Выберите…</option>
              {dictionaries?.counterparties.map((cp) => (
                <option key={cp.id} value={cp.id}>
                  {cp.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">С</span>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">По</span>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>

          {preview && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Сальдо на начало</span>
                <span className="tabular-nums">{formatMoney(preview.opening)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Начислено за период</span>
                <span className="tabular-nums">{formatMoney(preview.accrued)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Оплачено за период</span>
                <span className="tabular-nums">{formatMoney(preview.paid)}</span>
              </div>
              <div className="mt-1.5 flex justify-between border-t border-slate-200 pt-1.5 font-medium">
                <span>Сальдо на конец</span>
                <span className="tabular-nums">{formatMoney(preview.closing)}</span>
              </div>
              <div className="mt-1 text-xs text-slate-400">{preview.lines.length} строк оборотов</div>
            </div>
          )}

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Сформировать
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
