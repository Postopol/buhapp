import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Wallet, X, Banknote, AlertTriangle } from 'lucide-react';
import { getPayable, listPayments, createPayment } from '@/services/directory';
import { ApiError } from '@/services/api';
import {
  formatMoney, formatMoneyShort, formatAmount, formatDate, dueLabel, todayIso, parseMoney, plural,
} from '@/lib/format';
import { DOC_TYPE_SHORT } from '@shared/domain';
import { cn } from '@/lib/utils';
import type { PayableDocument, Payment } from '@/types';

export function Payments() {
  const [tab, setTab] = useState<'payable' | 'history'>('payable');
  const [payable, setPayable] = useState<PayableDocument[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showPayModal, setShowPayModal] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    return Promise.all([getPayable(), listPayments()])
      .then(([p, h]) => {
        setPayable(p.payable);
        setPayments(h.payments);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить данные'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectedDocs = payable.filter((d) => selected.has(d.id));
  const selectedSum = selectedDocs.reduce((sum, d) => sum + d.outstanding, 0);
  const overdueCount = payable.filter((d) => d.dueDate && dueLabel(d.dueDate)?.overdue).length;

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = payable.length > 0 && payable.every((d) => selected.has(d.id));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">Оплаты</h2>
        <p className="text-slate-500">Что платим и что уже заплатили</p>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        <TabButton active={tab === 'payable'} onClick={() => setTab('payable')}>
          К оплате
          {payable.length > 0 && (
            <span className="ml-1.5 rounded bg-slate-900 px-1.5 text-xs text-white">{payable.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
          История платежей
        </TabButton>
      </div>

      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice('')} className="text-emerald-500 hover:text-emerald-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Загрузка…
        </div>
      ) : tab === 'payable' ? (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Реестр на оплату</CardTitle>
                <CardDescription>
                  Согласованные счета и авансовые отчёты с непогашенным остатком
                  {overdueCount > 0 && (
                    <span className="ml-1 font-medium text-red-600">
                      · {plural(overdueCount, 'просрочен', 'просрочено', 'просрочено')}
                    </span>
                  )}
                </CardDescription>
              </div>
              {selected.size > 0 && (
                <Button className="gap-2" onClick={() => setShowPayModal(true)}>
                  <Banknote className="h-4 w-4" />
                  Оплатить {formatMoneyShort(selectedSum)}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {payable.length === 0 ? (
              <div className="py-12 text-center">
                <Wallet className="mx-auto h-8 w-8 text-slate-200" />
                <p className="mt-2 text-sm text-slate-400">Всё оплачено — к оплате ничего нет</p>
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8 px-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer rounded border-slate-300"
                          checked={allSelected}
                          onChange={() =>
                            setSelected(allSelected ? new Set() : new Set(payable.map((d) => d.id)))
                          }
                          aria-label="Выделить все"
                        />
                      </TableHead>
                      <TableHead className="px-2">Срок</TableHead>
                      <TableHead className="px-2">Документ</TableHead>
                      <TableHead className="px-2">Контрагент</TableHead>
                      <TableHead className="px-2">Статья</TableHead>
                      <TableHead className="px-2 text-right">К оплате</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payable.map((doc) => {
                      const due = dueLabel(doc.dueDate);
                      return (
                        <TableRow key={doc.id} className={cn(selected.has(doc.id) && 'bg-slate-50')}>
                          <TableCell className="px-2 py-2">
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer rounded border-slate-300"
                              checked={selected.has(doc.id)}
                              onChange={() => toggle(doc.id)}
                              aria-label={`Выделить ${doc.number}`}
                            />
                          </TableCell>
                          <TableCell className="whitespace-nowrap px-2 py-2">
                            {due ? (
                              <div className={cn('text-xs', due.overdue ? 'font-medium text-red-600' : 'text-slate-600')}>
                                <div>{formatDate(doc.dueDate)}</div>
                                <div className={due.overdue ? 'text-red-500' : 'text-slate-400'}>{due.text}</div>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-300">без срока</span>
                            )}
                          </TableCell>
                          <TableCell className="px-2 py-2">
                            <Link to={`/documents/${doc.id}`} className="font-medium text-slate-900 hover:underline">
                              {doc.number}
                            </Link>
                            <div className="text-xs text-slate-400">{DOC_TYPE_SHORT[doc.type]}</div>
                          </TableCell>
                          <TableCell className="max-w-[220px] px-2 py-2">
                            <div className="truncate text-slate-700">{doc.counterpartyName ?? '—'}</div>
                            <div className="truncate font-mono text-xs text-slate-400">{doc.iban || doc.bin || ''}</div>
                          </TableCell>
                          <TableCell className="px-2 py-2 text-xs text-slate-500">
                            {doc.expenseItemName ?? '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap px-2 py-2 text-right">
                            <div className="font-medium tabular-nums text-slate-900">{formatAmount(doc.outstanding)}</div>
                            {doc.paid > 0 && (
                              <div className="text-xs text-slate-400">из {formatAmount(doc.amount)}</div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3 text-sm">
                  <span className="text-slate-500">
                    Всего к оплате{' '}
                    <span className="font-semibold text-slate-900">
                      {formatMoneyShort(payable.reduce((s, d) => s + d.outstanding, 0))}
                    </span>
                  </span>
                  {selected.size > 0 && (
                    <span className="text-slate-500">
                      Выбрано {selected.size} на{' '}
                      <span className="font-semibold text-slate-900">{formatMoneyShort(selectedSum)}</span>
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">История платежей</CardTitle>
            <CardDescription>Каждый платёж разнесён по документам</CardDescription>
          </CardHeader>
          <CardContent>
            {payments.length === 0 ? (
              <p className="py-12 text-center text-sm text-slate-400">Платежей ещё не было</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {payments.map((p) => (
                  <div key={p.id} className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <span className="font-medium text-slate-900">{p.reference || `Платёж #${p.id}`}</span>
                        <span className="ml-2 text-sm text-slate-500">{formatDate(p.paymentDate)}</span>
                      </div>
                      <span className="font-semibold tabular-nums text-slate-900">{formatMoney(p.amount)}</span>
                    </div>
                    <div className="mt-1.5 space-y-1">
                      {p.allocations.map((a) => (
                        <div key={a.documentId} className="flex items-baseline justify-between gap-3 text-sm">
                          <Link to={`/documents/${a.documentId}`} className="text-slate-600 hover:underline">
                            {DOC_TYPE_SHORT[a.documentType]} {a.documentNumber}
                            {a.counterpartyName && <span className="text-slate-400"> · {a.counterpartyName}</span>}
                          </Link>
                          <span className="tabular-nums text-slate-500">{formatAmount(a.amount)}</span>
                        </div>
                      ))}
                    </div>
                    {p.unallocated > 0 && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-700">
                        <AlertTriangle className="h-3 w-3" />
                        Не разнесено {formatMoney(p.unallocated)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {showPayModal && (
        <PaymentModal
          documents={selectedDocs}
          onClose={() => setShowPayModal(false)}
          onSaved={(sum, count) => {
            setShowPayModal(false);
            setSelected(new Set());
            setNotice(
              `Платёж на ${formatMoney(sum)} проведён и разнесён на ${plural(count, 'документ', 'документа', 'документов')}.`
            );
            load();
          }}
        />
      )}
    </div>
  );
}

function PaymentModal({
  documents,
  onClose,
  onSaved,
}: {
  documents: PayableDocument[];
  onClose: () => void;
  onSaved: (sum: number, count: number) => void;
}) {
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [amounts, setAmounts] = useState<Record<number, string>>(() =>
    Object.fromEntries(documents.map((d) => [d.id, (d.outstanding / 100).toFixed(2)]))
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Сумма платежа = сумме разнесений: платёжка формируется из реестра, а не наоборот.
  const allocations = documents.map((d) => ({
    documentId: d.id,
    minor: parseMoney(amounts[d.id] ?? '') ?? 0,
    max: d.outstanding,
    doc: d,
  }));
  const total = allocations.reduce((sum, a) => sum + a.minor, 0);
  const invalid = allocations.find((a) => a.minor <= 0 || a.minor > a.max);

  const submit = async () => {
    setError('');
    if (invalid) {
      setError(
        invalid.minor <= 0
          ? `По документу ${invalid.doc.number} укажите положительную сумму`
          : `По документу ${invalid.doc.number} нельзя заплатить больше ${formatMoney(invalid.max)}`
      );
      return;
    }
    setSaving(true);
    try {
      await createPayment({
        paymentDate,
        amount: total,
        reference: reference.trim(),
        bankAccount: bankAccount.trim(),
        allocations: allocations.map((a) => ({ documentId: a.documentId, amount: a.minor })),
      });
      onSaved(total, allocations.length);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось провести платёж');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 py-10">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">Провести оплату</h3>
          <Button variant="ghost" size="icon" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Дата платежа</span>
              <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Номер платёжки</span>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ПП-341" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Счёт списания</span>
              <Input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} placeholder="KZ…" />
            </label>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium text-slate-700">Разнесение по документам</div>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {allocations.map((a) => (
                <div key={a.documentId} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900">
                      {DOC_TYPE_SHORT[a.doc.type]} {a.doc.number}
                    </div>
                    <div className="truncate text-xs text-slate-400">
                      {a.doc.counterpartyName} · остаток {formatMoney(a.max)}
                    </div>
                  </div>
                  <Input
                    className={cn('w-40 text-right tabular-nums', a.minor > a.max && 'border-red-300')}
                    value={amounts[a.documentId] ?? ''}
                    onChange={(e) => setAmounts((prev) => ({ ...prev, [a.documentId]: e.target.value }))}
                    inputMode="decimal"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-baseline justify-between rounded-lg bg-slate-900 px-4 py-3 text-white">
            <span className="text-sm">Сумма платежа</span>
            <span className="text-xl font-bold tabular-nums">{formatMoney(total)}</span>
          </div>

          {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <Button variant="outline" onClick={onClose}>Отмена</Button>
            <Button onClick={submit} disabled={saving || total <= 0}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Провести платёж
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'border-slate-900 text-slate-900'
          : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
      )}
    >
      {children}
    </button>
  );
}
