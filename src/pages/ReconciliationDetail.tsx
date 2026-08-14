import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  ArrowLeft, Loader2, Download, AlertTriangle, RefreshCw, Check, X, Plus, Clipboard,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import {
  getReconciliation, patchReconciliation, patchReconciliationLine, resolveReconciliationLine,
  addReconciliationLine, deleteReconciliationLine, importReconciliation, transitionReconciliation,
  rebuildReconciliation, reconciliationExportUrl,
} from '@/services/reconciliations';
import { ApiError } from '@/services/api';
import { formatMoney, formatAmount, formatDateTime, parseMoney, plural } from '@/lib/format';
import { ReconciliationChip, MatchChip, Chip } from '@/components/StatusChips';
import { cn } from '@/lib/utils';
import type { ReconciliationDetail as ActDetail, ReconciliationLine } from '@/types';

export function ReconciliationDetail() {
  const { id } = useParams<{ id: string }>();
  const actId = Number(id);
  const navigate = useNavigate();
  const { role } = useAuth();

  const [act, setAct] = useState<ActDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [askReason, setAskReason] = useState<{ to: ActDetail['status']; label: string } | null>(null);

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

  const run = async (fn: () => Promise<{ act: ActDetail }>) => {
    setActionError('');
    try {
      const res = await fn();
      setAct(res.act);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
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
  const unresolved = act.warnings.unresolved;
  // Когда разобрана последняя строка, фильтр «только расхождения» оставил бы
  // пустую таблицу, а кнопка возврата к тому моменту уже исчезла.
  const showOnlyDiff = onlyDiff && unresolved > 0;
  const visible = showOnlyDiff ? act.lines.filter((l) => l.needsWork) : act.lines;

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
              с {act.from} по {act.to}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editable && act.status === 'draft' && (
            <Button variant="outline" className="gap-2" onClick={() => run(() => rebuildReconciliation(act.id))}>
              <RefreshCw className="h-4 w-4" />
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
              onClick={() =>
                t.requiresComment
                  ? setAskReason({ to: t.to, label: t.label })
                  : run(() => transitionReconciliation(act.id, t.to))
              }
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {actionError && (
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

      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4 p-4">
          <TheirBalance act={act} editable={editable} onSave={(value) => run(() => patchReconciliation(act.id, { theirClosing: value }))} />
          <div className="text-right">
            <div className="text-sm text-slate-500">Расхождение</div>
            <div
              className={cn(
                'text-2xl font-bold tabular-nums',
                act.diff === null ? 'text-slate-300' : act.diff === 0 ? 'text-emerald-600' : 'text-red-700'
              )}
            >
              {act.diff === null ? '—' : act.diff === 0 ? 'сходится' : formatMoney(act.diff)}
            </div>
          </div>
        </CardContent>
      </Card>

      <Warnings act={act} />

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">Обороты за период</CardTitle>
            <CardDescription>{act.basis}</CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {unresolved > 0 && (
              <Button
                variant={showOnlyDiff ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setOnlyDiff((v) => !v)}
              >
                {showOnlyDiff ? 'Показать все' : `Только расхождения (${unresolved})`}
              </Button>
            )}
            {editable && (
              <>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowImport(true)}>
                  <Clipboard className="h-3.5 w-3.5" />
                  Вставить выписку
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowAdd(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  Строка контрагента
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">
              {showOnlyDiff ? 'Расхождений не осталось' : 'За период движений не было'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-2">Дата</TableHead>
                  <TableHead className="px-2">Документ</TableHead>
                  <TableHead className="px-2 text-right">Начислено</TableHead>
                  <TableHead className="px-2 text-right">Оплачено</TableHead>
                  <TableHead className="px-2 text-right">У контрагента</TableHead>
                  <TableHead className="px-2 text-right">Δ</TableHead>
                  <TableHead className="px-2">Диагноз</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((line) => (
                  <LineRow
                    key={line.id}
                    line={line}
                    editable={editable}
                    canResolve={
                      act.permissions.isChief ||
                      Math.abs(line.delta ?? line.ourAmount - (line.theirAmount ?? 0)) <
                        act.permissions.resolveThreshold
                    }
                    onPatch={(data) => run(() => patchReconciliationLine(act.id, line.id, data))}
                    onResolve={(data) => run(() => resolveReconciliationLine(act.id, line.id, data))}
                    onDelete={() => run(() => deleteReconciliationLine(act.id, line.id))}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
          onClose={() => setAskReason(null)}
          onSubmit={async (comment) => {
            await run(() => transitionReconciliation(act.id, askReason.to, comment));
            setAskReason(null);
          }}
        />
      )}
    </div>
  );
}

/** Сальдо со слов контрагента. Подписано словами, а не «дебет/кредит»:
 *  у контрагента это зеркальная дебиторка, и знак путают постоянно. */
function TheirBalance({
  act,
  editable,
  onSave,
}: {
  act: ActDetail;
  editable: boolean;
  onSave: (value: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(act.theirClosing === null ? '' : (act.theirClosing / 100).toFixed(2));
  const [error, setError] = useState('');

  if (!editing) {
    return (
      <div>
        <div className="text-sm text-slate-500">Сколько мы должны по данным контрагента</div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-2xl font-bold tabular-nums text-slate-900">
            {act.theirClosing === null ? 'ответа нет' : formatMoney(act.theirClosing)}
          </span>
          {editable && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Внести
            </Button>
          )}
        </div>
      </div>
    );
  }

  const submit = () => {
    if (!value.trim()) {
      onSave(null);
      setEditing(false);
      return;
    }
    const minor = parseMoney(value);
    if (minor === null) {
      setError('Некорректная сумма');
      return;
    }
    onSave(minor);
    setEditing(false);
  };

  return (
    <div className="space-y-1.5">
      <span className="text-sm text-slate-500">Сколько мы должны по данным контрагента</span>
      <div className="flex items-center gap-2">
        <Input
          className="w-44"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0,00"
          inputMode="decimal"
          autoFocus
        />
        <Button size="sm" onClick={submit}>
          <Check className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function Warnings({ act }: { act: ActDetail }) {
  const w = act.warnings;
  const items: { text: string; tone: 'amber' | 'red' }[] = [];

  if (act.drift.changed) {
    items.push({
      tone: 'red',
      text: `Данные изменились после формирования: в снимке ${formatMoney(act.closing)}, сейчас ${formatMoney(act.drift.closingNow)}. Акт показывает то, что ушло контрагенту.`,
    });
  }
  if (!act.final) {
    items.push({
      tone: 'amber',
      text: 'Не все месяцы периода закрыты — цифры под актом ещё могут измениться.',
    });
  }
  if (w.unapprovedCount > 0) {
    items.push({
      tone: 'amber',
      text: `В акт вошло ${plural(w.unapprovedCount, 'несогласованный документ', 'несогласованных документа', 'несогласованных документов')} на ${formatMoney(w.unapproved)}.`,
    });
  }
  if (w.unallocated > 0) {
    items.push({
      tone: 'amber',
      text: `Есть неразнесённый остаток платежей на ${formatMoney(w.unallocated)} — похоже на аванс, в сальдо он не вошёл.`,
    });
  }
  if (w.excludedCount > 0) {
    items.push({
      tone: 'amber',
      text: `Отклонённые документы в акт не вошли: ${w.excludedCount} на ${formatMoney(w.excluded)}.`,
    });
  }
  if (w.excludedPaidCount > 0) {
    // Отдельная строка, а не слагаемое к предыдущей: оплаты отсекаются по
    // дате платежа, поэтому попадают в другой период, чем сам документ.
    items.push({
      tone: 'amber',
      text: `Оплаты по отклонённым документам в акт не вошли: ${w.excludedPaidCount} на ${formatMoney(w.excludedPaid)}. Деньги со счёта ушли, и контрагент их у себя покажет.`,
    });
  }
  for (const dup of w.duplicates) {
    items.push({
      tone: 'amber',
      text: `Счёт и акт на одну сумму ${formatMoney(dup.amount)} — ${dup.numbers}. Похоже на двойной счёт одной услуги.`,
    });
  }

  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
          className={cn(
            'flex items-start gap-2 rounded-lg border px-4 py-3 text-sm',
            item.tone === 'red' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'
          )}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

function LineRow({
  line,
  editable,
  canResolve,
  onPatch,
  onResolve,
  onDelete,
}: {
  line: ReconciliationLine;
  editable: boolean;
  canResolve: boolean;
  onPatch: (data: { theirAmount?: number | null; comment?: string }) => void;
  onResolve: (data: { comment?: string; resolved?: boolean }) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [theirs, setTheirs] = useState(line.theirAmount === null ? '' : (line.theirAmount / 100).toFixed(2));
  const [comment, setComment] = useState(line.comment);
  const [lineError, setLineError] = useState('');

  // После сохранения, импорта или пересборки сервер отдаёт акт целиком, а id
  // строки не меняется — React сохранил бы старый ввод. Подтягиваем значения
  // из пропса, иначе в поле висит цифра, которой в акте уже нет.
  useEffect(() => {
    setTheirs(line.theirAmount === null ? '' : (line.theirAmount / 100).toFixed(2));
    setComment(line.comment);
    setLineError('');
  }, [line.theirAmount, line.comment]);

  return (
    <>
      <TableRow className={cn(line.needsWork && 'bg-red-50/30')}>
        <TableCell className="whitespace-nowrap px-2 py-2 text-slate-500">{line.date}</TableCell>
        <TableCell className="px-2 py-2">
          {line.documentId ? (
            <Link to={`/documents/${line.documentId}`} className="font-medium text-slate-900 hover:underline">
              {line.title}
            </Link>
          ) : (
            <span className="font-medium text-slate-900">{line.title}</span>
          )}
          {line.purpose && <div className="truncate text-xs text-slate-400">{line.purpose}</div>}
        </TableCell>
        <TableCell className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
          {line.accrued ? formatAmount(line.accrued) : <span className="text-slate-300">—</span>}
        </TableCell>
        <TableCell className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
          {line.paid ? formatAmount(line.paid) : <span className="text-slate-300">—</span>}
        </TableCell>
        <TableCell className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-slate-600">
          {line.theirAmount === null ? <span className="text-slate-300">не сверяли</span> : formatAmount(line.theirAmount)}
        </TableCell>
        <TableCell
          className={cn(
            'whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums',
            line.delta ? 'text-red-700' : 'text-slate-300'
          )}
        >
          {line.delta === null || line.delta === 0 ? '—' : formatAmount(line.delta)}
        </TableCell>
        <TableCell className="px-2 py-2">
          <button
            className="flex items-center gap-1.5 text-left"
            onClick={() => setOpen((v) => !v)}
            title="Подробнее"
          >
            <MatchChip match={line.match} resolved={line.resolved} />
          </button>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow>
          <TableCell colSpan={7} className="bg-slate-50 px-4 py-3">
            <div className="space-y-3">
              {line.hint && <p className="text-sm text-slate-600">{line.hint}</p>}
              {lineError && <p className="text-sm text-red-600">{lineError}</p>}
              {line.theirRaw && (
                <p className="font-mono text-xs text-slate-400">Из выписки: {line.theirRaw}</p>
              )}
              {line.comment && !editable && <p className="text-sm text-slate-700">{line.comment}</p>}

              {editable && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="space-y-1">
                    <span className="block text-xs font-medium text-slate-600">Сумма у контрагента</span>
                    <Input
                      className="w-40"
                      value={theirs}
                      onChange={(e) => setTheirs(e.target.value)}
                      placeholder="0,00"
                      inputMode="decimal"
                    />
                  </label>
                  <label className="flex-1 space-y-1">
                    <span className="block text-xs font-medium text-slate-600">Что решили</span>
                    <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Например: их накладная по другому договору" />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      // Пустое поле — это «стереть сумму контрагента», а вот
                      // неразобранный ввод стирать молча нельзя.
                      const minor = theirs.trim() ? parseMoney(theirs) : null;
                      if (theirs.trim() && minor === null) {
                        setLineError('Некорректная сумма');
                        return;
                      }
                      setLineError('');
                      onPatch({ theirAmount: minor, comment });
                    }}
                  >
                    Сохранить
                  </Button>
                  {line.needsWork && (
                    <Button
                      size="sm"
                      onClick={() => onResolve({ comment })}
                      // Крупное расхождение закрывает только главбух — это же
                      // правило стоит на сервере, здесь оно лишь видимое.
                      disabled={!canResolve}
                      title={canResolve ? undefined : 'Такое расхождение закрывает главный бухгалтер'}
                    >
                      Разобрано
                    </Button>
                  )}
                  {line.resolved && (
                    <Button size="sm" variant="ghost" onClick={() => onResolve({ resolved: false })}>
                      Вернуть в работу
                    </Button>
                  )}
                  {line.kind === 'their' && (
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={onDelete}>
                      Удалить строку
                    </Button>
                  )}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ImportModal({
  onClose,
  onImport,
  onDone,
}: {
  onClose: () => void;
  onImport: (text: string, kind: 'accrued' | 'paid') => Promise<{ act: ActDetail; parsed: { rows: number; skipped: { raw: string; reason: string }[] } }>;
  onDone: (act: ActDetail) => void;
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'accrued' | 'paid'>('accrued');
  const [result, setResult] = useState<{ rows: number; skipped: { raw: string; reason: string }[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await onImport(text, kind);
      setResult(res.parsed);
      onDone(res.act);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось разобрать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Выписка контрагента</h3>
            <p className="text-sm text-slate-500">
              Вставьте как есть — из письма или Excel. Колонки: дата, номер, начислено, оплачено
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <textarea
            className="min-h-[180px] w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'01.07.2026\tСЧ-4471\t3 400 000,00\t0\n15.07.2026\tПП-341\t0\t3 400 000,00'}
          />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Если колонка суммы одна, считать её:
            <select
              className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'accrued' | 'paid')}
            >
              <option value="accrued">начислением</option>
              <option value="paid">оплатой</option>
            </select>
          </label>

          {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          {result && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="font-medium text-slate-900">
                Разобрано строк: {result.rows}
                {result.skipped.length > 0 && `, пропущено: ${result.skipped.length}`}
              </p>
              {result.skipped.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {result.skipped.map((s, i) => (
                    <li key={i} className="font-mono text-xs text-slate-500">
                      {s.raw} — {s.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {result ? 'Закрыть' : 'Отмена'}
            </Button>
            <Button onClick={submit} disabled={busy || !text.trim()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Разобрать и сопоставить
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddLineModal({
  defaultDate,
  onClose,
  onSave,
}: {
  defaultDate: string;
  onClose: () => void;
  onSave: (data: { date: string; title: string; theirAmount: number; comment?: string }) => Promise<void>;
}) {
  const [date, setDate] = useState(defaultDate);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    const minor = parseMoney(amount);
    if (!title.trim()) {
      setError('Укажите документ контрагента');
      return;
    }
    if (minor === null || minor <= 0) {
      setError('Некорректная сумма');
      return;
    }
    setBusy(true);
    try {
      await onSave({ date, title, theirAmount: minor, comment });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить строку');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Строка контрагента</h3>
            <p className="text-sm text-slate-500">Документ, который есть у него и которого нет у нас</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Дата</span>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Документ</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="НК-7781" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Сумма по его данным, ₸</span>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" inputMode="decimal" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Комментарий</span>
            <Input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Добавить
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReasonModal({
  title,
  onClose,
  onSubmit,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (comment: string) => Promise<void>;
}) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
        <p className="mt-1 text-sm text-slate-500">Причина попадёт в историю акта</p>
        <textarea
          className="mt-4 min-h-[80px] w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          autoFocus
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={busy || !comment.trim()}
            onClick={async () => {
              setBusy(true);
              await onSubmit(comment);
              setBusy(false);
            }}
          >
            Подтвердить
          </Button>
        </div>
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  created: 'Акт сформирован',
  rebuilt: 'Снимок пересобран',
  their_balance: 'Внесено сальдо контрагента',
  line_matched: 'Сверена строка',
  line_resolved: 'Расхождение разобрано',
  line_reopened: 'Расхождение возвращено в работу',
  line_added: 'Добавлена строка контрагента',
  line_deleted: 'Удалена строка контрагента',
  imported: 'Загружена выписка контрагента',
  transition: 'Смена статуса',
};

function History({ act }: { act: ActDetail }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">История</CardTitle>
        <CardDescription>Сформирован {formatDateTime(act.builtAt)}</CardDescription>
      </CardHeader>
      <CardContent>
        {act.history.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Пока пусто</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {act.history.map((entry) => {
              const details = entry.details as Record<string, unknown> | null;
              const comment = details && typeof details.comment === 'string' ? details.comment : '';
              return (
                <div key={entry.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="text-slate-900">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                    <span className="text-slate-400"> · {entry.userName}</span>
                    {comment && <div className="text-xs italic text-slate-500">{comment}</div>}
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">{formatDateTime(entry.createdAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('rounded-xl border p-4', strong ? 'border-slate-900 bg-white' : 'border-slate-200 bg-white')}>
      <div className="text-sm font-medium text-slate-600">{label}</div>
      <div className="mt-1.5 text-xl font-bold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
