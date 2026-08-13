import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X, Loader2 } from 'lucide-react';
import { formatMoney, parseMoney, todayIso } from '@/lib/format';
import { createDocument, updateDocument, type DocumentInput } from '@/services/documents';
import { ApiError } from '@/services/api';
import {
  DOC_TYPE_LABELS,
  DOC_TYPES,
  SECTIONS,
  SECTION_LABELS,
  VAT_RATE,
} from '@shared/domain';
import type { Dictionaries, Document, DocType, Section } from '@/types';

interface Props {
  dictionaries: Dictionaries;
  /** Передан — режим правки, иначе создание. */
  document?: Document;
  onClose: () => void;
  onSaved: (doc: Document) => void;
}

interface FormState {
  type: DocType;
  number: string;
  docDate: string;
  dueDate: string;
  counterpartyId: string;
  contractId: string;
  expenseItemId: string;
  amount: string;
  vat: string;
  purpose: string;
  section: Section;
  responsibleId: string;
}

function initialState(doc?: Document): FormState {
  if (doc) {
    return {
      type: doc.type,
      number: doc.number,
      docDate: doc.docDate,
      dueDate: doc.dueDate ?? '',
      counterpartyId: doc.counterpartyId ? String(doc.counterpartyId) : '',
      contractId: doc.contractId ? String(doc.contractId) : '',
      expenseItemId: doc.expenseItemId ? String(doc.expenseItemId) : '',
      amount: (doc.amount / 100).toFixed(2),
      vat: (doc.vat / 100).toFixed(2),
      purpose: doc.purpose,
      section: doc.section,
      responsibleId: doc.responsibleId ? String(doc.responsibleId) : '',
    };
  }
  return {
    type: 'invoice',
    number: '',
    docDate: todayIso(),
    dueDate: '',
    counterpartyId: '',
    contractId: '',
    expenseItemId: '',
    amount: '',
    vat: '',
    purpose: '',
    section: 'suppliers',
    responsibleId: '',
  };
}

export function DocumentFormModal({ dictionaries, document, onClose, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(() => initialState(document));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  /** НДС считается сам, пока пользователь не тронул поле руками. */
  const [vatTouched, setVatTouched] = useState(!!document);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const counterparty = useMemo(
    () => dictionaries.counterparties.find((c) => String(c.id) === form.counterpartyId),
    [dictionaries.counterparties, form.counterpartyId]
  );

  const contracts = useMemo(
    () => dictionaries.contracts.filter((c) => String(c.counterpartyId) === form.counterpartyId),
    [dictionaries.contracts, form.counterpartyId]
  );

  // Плательщик НДС → выделяем 12/112 автоматически. Ручной ввод это отменяет.
  useEffect(() => {
    if (vatTouched) return;
    const amountMinor = parseMoney(form.amount);
    if (amountMinor === null || !counterparty?.isVatPayer) {
      set('vat', '');
      return;
    }
    const vatMinor = Math.round((amountMinor * VAT_RATE) / (1 + VAT_RATE));
    set('vat', (vatMinor / 100).toFixed(2));
  }, [form.amount, counterparty?.isVatPayer, vatTouched]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    const amountMinor = parseMoney(form.amount);
    if (amountMinor === null || amountMinor <= 0) {
      setError('Сумма должна быть положительным числом');
      return;
    }
    const vatMinor = form.vat ? parseMoney(form.vat) : 0;
    if (vatMinor === null) {
      setError('Некорректная сумма НДС');
      return;
    }
    if (vatMinor > amountMinor) {
      setError('НДС не может превышать сумму документа');
      return;
    }
    if (!form.number.trim()) {
      setError('Укажите номер документа');
      return;
    }
    if (form.dueDate && form.dueDate < form.docDate) {
      setError('Срок оплаты не может быть раньше даты документа');
      return;
    }

    const payload: DocumentInput = {
      type: form.type,
      number: form.number.trim(),
      docDate: form.docDate,
      dueDate: form.dueDate || null,
      counterpartyId: form.counterpartyId ? Number(form.counterpartyId) : null,
      contractId: form.contractId ? Number(form.contractId) : null,
      expenseItemId: form.expenseItemId ? Number(form.expenseItemId) : null,
      amount: amountMinor,
      vat: vatMinor,
      purpose: form.purpose.trim(),
      section: form.section,
      responsibleId: form.responsibleId ? Number(form.responsibleId) : null,
    };

    setSaving(true);
    try {
      const res = document
        ? await updateDocument(document.id, payload)
        : await createDocument(payload);
      onSaved(res.document);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить документ');
    } finally {
      setSaving(false);
    }
  };

  const amountMinor = parseMoney(form.amount);
  const vatMinor = form.vat ? parseMoney(form.vat) : 0;
  const netMinor = amountMinor !== null && vatMinor !== null ? amountMinor - vatMinor : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 py-10">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">
            {document ? `Документ ${document.number}` : 'Новый документ'}
          </h3>
          <Button variant="ghost" size="icon" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Тип документа">
              <Select value={form.type} onChange={(v) => set('type', v as DocType)}>
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {DOC_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Номер">
              <Input
                value={form.number}
                onChange={(e) => set('number', e.target.value)}
                placeholder="СЧ-1234"
                required
                autoFocus
              />
            </Field>
            <Field label="Дата документа">
              <Input type="date" value={form.docDate} onChange={(e) => set('docDate', e.target.value)} required />
            </Field>
            <Field label="Срок оплаты" hint="Пусто — срока нет">
              <Input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Контрагент">
              <Select
                value={form.counterpartyId}
                onChange={(v) => {
                  set('counterpartyId', v);
                  set('contractId', '');
                }}
              >
                <option value="">— не указан —</option>
                {dictionaries.counterparties.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.isVatPayer ? '' : ' (без НДС)'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Договор" hint={form.counterpartyId ? undefined : 'Сначала выберите контрагента'}>
              <Select
                value={form.contractId}
                onChange={(v) => set('contractId', v)}
                disabled={!form.counterpartyId || contracts.length === 0}
              >
                <option value="">— без договора —</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.number} — {c.subject}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Сумма, ₸">
              <Input
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="0,00"
                inputMode="decimal"
                required
              />
            </Field>
            <Field label="в т.ч. НДС, ₸" hint={vatTouched ? undefined : 'Считается автоматически'}>
              <Input
                value={form.vat}
                onChange={(e) => {
                  setVatTouched(true);
                  set('vat', e.target.value);
                }}
                placeholder="0,00"
                inputMode="decimal"
              />
            </Field>
            <Field label="Без НДС, ₸">
              <div className="flex h-10 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm tabular-nums text-slate-600">
                {netMinor !== null ? formatMoney(netMinor) : '—'}
              </div>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Статья расходов">
              <Select value={form.expenseItemId} onChange={(v) => set('expenseItemId', v)}>
                <option value="">— не указана —</option>
                {dictionaries.expenseItems.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Участок">
              <Select value={form.section} onChange={(v) => set('section', v as Section)}>
                {SECTIONS.map((s) => (
                  <option key={s} value={s}>
                    {SECTION_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Ответственный" hint="Пусто — по участку">
              <Select value={form.responsibleId} onChange={(v) => set('responsibleId', v)}>
                <option value="">— автоматически —</option>
                {dictionaries.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Назначение платежа">
            <textarea
              className="min-h-[72px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
              value={form.purpose}
              onChange={(e) => set('purpose', e.target.value)}
              placeholder="За что платим — попадёт в платёжное поручение"
            />
          </Field>

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {document ? 'Сохранить' : 'Создать документ'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium leading-none text-slate-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

function Select({
  value,
  onChange,
  children,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {children}
    </select>
  );
}
