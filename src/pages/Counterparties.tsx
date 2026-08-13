import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Plus, Loader2, X, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { listCounterparties, createCounterparty } from '@/services/directory';
import { ApiError } from '@/services/api';
import { formatMoneyShort, plural } from '@/lib/format';
import { Chip } from '@/components/StatusChips';
import type { Counterparty } from '@/types';

export function Counterparties() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const [items, setItems] = useState<Counterparty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    setLoading(true);
    listCounterparties(debounced)
      .then(({ counterparties }) => setItems(counterparties))
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить список'))
      .finally(() => setLoading(false));
  }, [debounced]);

  useEffect(() => {
    load();
  }, [load]);

  const canCreate = role === 'accountant' || role === 'chief_accountant';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Контрагенты</h2>
          <p className="text-slate-500">Реквизиты, долг и полнота документов по каждому</p>
        </div>
        {canCreate && (
          <Button className="gap-2" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            Новый контрагент
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <Input
              placeholder="Наименование или БИН…"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          ) : loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Загрузка…
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-2">Наименование</TableHead>
                  <TableHead className="px-2">БИН / ИИН</TableHead>
                  <TableHead className="px-2 text-right">Начислено</TableHead>
                  <TableHead className="px-2 text-right">Оплачено</TableHead>
                  <TableHead className="px-2 text-right">Долг</TableHead>
                  <TableHead className="px-2">Документы</TableHead>
                  <TableHead className="px-2">Ответственный</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center text-slate-400">
                      Ничего не найдено
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((cp) => (
                    <TableRow
                      key={cp.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/counterparties/${cp.id}`)}
                    >
                      <TableCell className="px-2 py-2.5">
                        <div className="font-medium text-slate-900">{cp.name}</div>
                        {!cp.isVatPayer && <div className="text-xs text-slate-400">не плательщик НДС</div>}
                      </TableCell>
                      <TableCell className="px-2 py-2.5 font-mono text-xs text-slate-500">{cp.bin}</TableCell>
                      <TableCell className="px-2 py-2.5 text-right tabular-nums text-slate-700">
                        {formatMoneyShort(cp.accrued ?? 0)}
                      </TableCell>
                      <TableCell className="px-2 py-2.5 text-right tabular-nums text-slate-500">
                        {formatMoneyShort(cp.paid ?? 0)}
                      </TableCell>
                      <TableCell className="px-2 py-2.5 text-right">
                        <span
                          className={
                            (cp.debt ?? 0) > 0
                              ? 'font-semibold tabular-nums text-slate-900'
                              : 'tabular-nums text-slate-400'
                          }
                        >
                          {formatMoneyShort(cp.debt ?? 0)}
                        </span>
                      </TableCell>
                      <TableCell className="px-2 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-600">{cp.documentsCount ?? 0}</span>
                          {(cp.missingOriginals ?? 0) > 0 && (
                            <Chip tone="bad" title="Документы без оригинала">
                              <AlertTriangle className="h-3 w-3" />
                              {cp.missingOriginals}
                            </Chip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="px-2 py-2.5 text-sm text-slate-500">
                        {cp.responsibleName ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}

          {items.length > 0 && (
            <p className="border-t border-slate-200 pt-3 text-sm text-slate-500">
              {plural(items.length, 'контрагент', 'контрагента', 'контрагентов')} · общий долг{' '}
              <span className="font-semibold text-slate-900">
                {formatMoneyShort(items.reduce((sum, c) => sum + (c.debt ?? 0), 0))}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      {showCreate && (
        <CounterpartyModal
          onClose={() => setShowCreate(false)}
          onSaved={(cp) => {
            setShowCreate(false);
            navigate(`/counterparties/${cp.id}`);
          }}
        />
      )}
    </div>
  );
}

function CounterpartyModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (cp: Counterparty) => void;
}) {
  const [form, setForm] = useState({
    bin: '',
    name: '',
    isVatPayer: true,
    bankName: '',
    bankBic: '',
    iban: '',
    note: '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^\d{12}$/.test(form.bin.trim())) {
      setError('БИН/ИИН должен состоять из 12 цифр');
      return;
    }
    setSaving(true);
    try {
      const { counterparty } = await createCounterparty({ ...form, bin: form.bin.trim() });
      onSaved(counterparty);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 py-10">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">Новый контрагент</h3>
          <Button variant="ghost" size="icon" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <form onSubmit={submit} className="space-y-4 px-6 py-5">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Наименование</span>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="ТОО «Ромашка»" required autoFocus />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">БИН / ИИН</span>
            <Input
              value={form.bin}
              onChange={(e) => set('bin', e.target.value.replace(/\D/g, '').slice(0, 12))}
              placeholder="12 цифр"
              inputMode="numeric"
              required
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={form.isVatPayer}
              onChange={(e) => set('isVatPayer', e.target.checked)}
            />
            <span className="text-sm text-slate-700">Плательщик НДС</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Банк</span>
              <Input value={form.bankName} onChange={(e) => set('bankName', e.target.value)} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">БИК</span>
              <Input value={form.bankBic} onChange={(e) => set('bankBic', e.target.value)} />
            </label>
          </div>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">IBAN</span>
            <Input
              value={form.iban}
              onChange={(e) => set('iban', e.target.value.toUpperCase())}
              placeholder="KZ00000000000000000"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Заметка</span>
            <Input value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Например: счёт приходит 1-го числа" />
          </label>

          {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>Отмена</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Создать
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
