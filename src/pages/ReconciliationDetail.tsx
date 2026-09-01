import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, Download, RefreshCw } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import {
  getReconciliation, patchReconciliation, patchReconciliationLine, resolveReconciliationLine,
  addReconciliationLine, deleteReconciliationLine, importReconciliation, transitionReconciliation,
  rebuildReconciliation, reconciliationExportUrl,
} from '@/services/reconciliations';
import { ApiError } from '@/services/api';
import { formatMoney, formatDate } from '@/lib/format';
import { ReconciliationChip, Chip } from '@/components/StatusChips';
import { Metric } from '@/components/reconciliation/Metric';
import { BalanceCard } from '@/components/reconciliation/BalanceCard';
import { Warnings } from '@/components/reconciliation/Warnings';
import { LinesCard } from '@/components/reconciliation/LinesCard';
import { History } from '@/components/reconciliation/History';
import { ImportModal } from '@/components/reconciliation/ImportModal';
import { AddLineModal } from '@/components/reconciliation/AddLineModal';
import { ReasonModal } from '@/components/reconciliation/ReasonModal';
import type { ReconciliationDetail as ActDetail } from '@/types';

export function ReconciliationDetail() {
  const { id } = useParams<{ id: string }>();
  const actId = Number(id);
  const navigate = useNavigate();
  const { role } = useAuth();

  const [act, setAct] = useState<ActDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [askReason, setAskReason] = useState<{ to: ActDetail['status']; label: string } | null>(null);

  // Признак занятости нужен и в замыкании обработчика, а не только на кнопке:
  // два клика подряд успевают попасть в один рендер, и второй переход падал бы
  // на проверке таблицы переходов, показывая бухгалтеру ложную ошибку.
  const busyRef = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    getReconciliation(actId)
      .then((res) => {
        setAct(res.act);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Акт не найден'))
      .finally(() => setLoading(false));
  }, [actId]);

  useEffect(() => {
    load();
  }, [load]);

  // Право на правку приходит с сервера: там оно складывается из роли, участка
  // (акт ведёт ответственный за контрагента, автор или главбух) и статуса.
  // Повторять эту логику здесь значило бы рано или поздно с ней разойтись.
  const editable = act?.permissions.edit ?? false;

  /** true — действие прошло. Ответ нужен вызывающему: модалку с причиной
   *  закрывает только успех, иначе набранный текст пропадает вместе с окном. */
  const run = async (fn: () => Promise<{ act: ActDetail }>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setActionError('');
    try {
      const res = await fn();
      setAct(res.act);
      return true;
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (loading && !act) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Загрузка акта…
      </div>
    );
  }

  if (error || !act) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-2" onClick={() => navigate('/reconciliations')}>
          <ArrowLeft className="h-4 w-4" />
          К списку
        </Button>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">{error || 'Акт не найден'}</div>
      </div>
    );
  }

  const transitions = act.transitions.filter((t) => role && t.roles.includes(role));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/reconciliations')} title="Назад">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold tracking-tight text-slate-900">{act.number}</h2>
              <ReconciliationChip status={act.status} />
              {act.final && <Chip tone="neutral" title="Все месяцы периода закрыты">окончательный</Chip>}
            </div>
            <p className="text-slate-500">
              <Link to={`/counterparties/${act.counterpartyId}`} className="hover:underline">
                {act.counterpartyName}
              </Link>
              {' · '}
              {/* Годы пишем явно: акт за прошлый год иначе читается как за этот. */}
              с {formatDate(act.from, true)} по {formatDate(act.to, true)}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editable && act.status === 'draft' && (
            <Button
              variant="outline"
              className="gap-2"
              disabled={busy}
              onClick={() => run(() => rebuildReconciliation(act.id))}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Пересобрать
            </Button>
          )}
          <a href={reconciliationExportUrl(act.id)}>
            <Button variant="outline" className="gap-2">
              <Download className="h-4 w-4" />
              В Excel
            </Button>
          </a>
          {transitions.map((t) => (
            <Button
              key={t.to}
              variant={t.to === 'signed' ? 'default' : 'outline'}
              disabled={busy}
              onClick={() => {
                if (t.requiresComment) {
                  // Плашка ошибки уедет в модалку, старую показывать там незачем.
                  setActionError('');
                  setAskReason({ to: t.to, label: t.label });
                } else {
                  run(() => transitionReconciliation(act.id, t.to));
                }
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {actionError && !askReason && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</div>
      )}

      {!editable && act.permissions.editDenied && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          {act.permissions.editDenied}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Сальдо на начало" value={formatMoney(act.opening)} />
        <Metric label="Начислено за период" value={formatMoney(act.accrued)} />
        <Metric label="Оплачено за период" value={formatMoney(act.paid)} />
        <Metric label="Сальдо на конец" value={formatMoney(act.closing)} strong />
      </div>

      <BalanceCard
        act={act}
        editable={editable}
        disabled={busy}
        onSave={(value) => run(() => patchReconciliation(act.id, { theirClosing: value }))}
      />

      <Warnings act={act} />

      <LinesCard
        act={act}
        editable={editable}
        disabled={busy}
        onImportClick={() => setShowImport(true)}
        onAddClick={() => setShowAdd(true)}
        onPatchLine={(lineId, data) => run(() => patchReconciliationLine(act.id, lineId, data))}
        onResolveLine={(lineId, data) => run(() => resolveReconciliationLine(act.id, lineId, data))}
        onDeleteLine={(lineId) => run(() => deleteReconciliationLine(act.id, lineId))}
      />

      <History act={act} />

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImport={(text, kind) => importReconciliation(act.id, text, kind)}
          onDone={(next) => setAct(next)}
        />
      )}
      {showAdd && (
        <AddLineModal
          defaultDate={act.to}
          onClose={() => setShowAdd(false)}
          onSave={async (data) => {
            const res = await addReconciliationLine(act.id, data);
            setAct(res.act);
            setShowAdd(false);
          }}
        />
      )}
      {askReason && (
        <ReasonModal
          title={askReason.label}
          error={actionError}
          onClose={() => setAskReason(null)}
          onSubmit={async (comment) => {
            const ok = await run(() => transitionReconciliation(act.id, askReason.to, comment));
            if (ok) setAskReason(null);
          }}
        />
      )}
    </div>
  );
}
