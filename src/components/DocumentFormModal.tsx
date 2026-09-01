import { useState, useEffect, useMemo, useRef, useId, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X, Loader2 } from 'lucide-react';
import { formatDate, formatMoney, parseMoney, todayIso } from '@/lib/format';
import { createDocument, updateDocument, listDocuments, type DocumentInput } from '@/services/documents';
import { ApiError } from '@/services/api';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import {
  DOC_TYPE_LABELS,
  DOC_TYPES,
  SECTIONS,
  SECTION_LABELS,
  vatFromGross,
  vatRateOn,
} from '@shared/domain';
import type { Dictionaries, Document, DocType, Section } from '@/types';

interface Props {
  dictionaries: Dictionaries;
  /** Передан — режим правки, иначе создание. */
  document?: Document;
  onClose: () => void;
  onSaved: (doc: Document) => void;
}

/**
 * Ссылка «этот документ закрывает вот этот счёт» появилась в документе позже
 * остальных полей, и списочные ответы сервера могут её ещё не отдавать —
 * читаем мягко, чтобы правка старого документа не роняла форму.
 */
type DocumentWithCloses = Document & { closesDocumentId?: number | null };

/** Закрывающие документы: только у них есть поле «Закрывает счёт». */
const CLOSING_TYPES: DocType[] = ['act', 'waybill'];

/**
 * Участок по типу документа. Инициатор участок не выбирает (см. ниже), а один
 * общий дефолт «suppliers» молча уводил авансовый отчёт к поставщикам, откуда
 * его никто не забирал. Раскладка та же, что в чек-листе закрытия месяца:
 * подотчёт закрывает банк, движение ТМЗ — склад.
 */
const SECTION_BY_TYPE: Record<DocType, Section> = {
  invoice: 'suppliers',
  act: 'suppliers',
  waybill: 'inventory',
  contract: 'suppliers',
  expense_report: 'bank',
};

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
  closesDocumentId: string;
}

function initialState(doc?: Document): FormState {
  if (doc) {
    const closes = (doc as DocumentWithCloses).closesDocumentId ?? null;
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
      closesDocumentId: closes ? String(closes) : '',
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
    section: SECTION_BY_TYPE.invoice,
    responsibleId: '',
    closesDocumentId: '',
  };
}

export function DocumentFormModal({ dictionaries, document, onClose, onSaved }: Props) {
  const { role } = useAuth();
  const [form, setForm] = useState<FormState>(() => initialState(document));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  /** НДС считается сам, пока пользователь не тронул поле руками. */
  const [vatTouched, setVatTouched] = useState(!!document);
  /** Участок, выбранный бухгалтерией руками, смена типа документа не затирает. */
  const [sectionTouched, setSectionTouched] = useState(!!document);
  const [invoices, setInvoices] = useState<Document[]>([]);
  const [invoicesError, setInvoicesError] = useState('');

  const titleId = useId();
  const dialogRef = useModalChrome<HTMLDivElement>(onClose);

  /**
   * Инициатор — менеджер закупок или подотчётник: деления бухгалтерии на
   * участки и её штатного расписания он не знает, и выбор из этих двух
   * справочников для него всегда угадайка. Участок подставляем по типу
   * документа, ответственного назначит сервер по участку.
   */
  const isInitiator = role === 'initiator';

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

  const closesInvoice = CLOSING_TYPES.includes(form.type);

  /**
   * Ставка НДС — функция от даты документа, а не константа: с 01.01.2026 базовая
   * ставка в РК 16 %, но у документа декабря 2025 года навсегда остаётся 12 %,
   * иначе уточнёнка по ФНО 300.00 разойдётся со сданной отчётностью.
   */
  const vatRateLabel = `${Math.round(vatRateOn(form.docDate) * 100)} %`;

  // Плательщик НДС → выделяем налог из суммы с налогом. Пересчитываем и при
  // смене даты: правка даты декабрём меняет ставку, а НДС в поле оставался
  // посчитанным по прежней. Ручной ввод пересчёт отменяет.
  useEffect(() => {
    if (vatTouched) return;
    const amountMinor = parseMoney(form.amount);
    if (amountMinor === null || !counterparty?.isVatPayer) {
      set('vat', '');
      return;
    }
    set('vat', (vatFromGross(amountMinor, form.docDate) / 100).toFixed(2));
  }, [form.amount, form.docDate, counterparty?.isVatPayer, vatTouched]);

  // Счета того же контрагента — кандидаты на закрытие. Тянем реестром: свежие
  // сверху, дальше первых двухсот в такой связке не забираются.
  useEffect(() => {
    if (!closesInvoice || !form.counterpartyId) {
      setInvoices([]);
      setInvoicesError('');
      return;
    }
    let cancelled = false;
    setInvoicesError('');
    listDocuments({ type: 'invoice', counterparty: form.counterpartyId, limit: 200 })
      .then((res) => {
        if (cancelled) return;
        // Отклонённый счёт закрывать нечем — он и так не создаёт обязательства.
        setInvoices(res.documents.filter((d) => d.approvalStatus !== 'rejected'));
      })
      .catch(() => {
        if (cancelled) return;
        setInvoices([]);
        setInvoicesError('Не удалось загрузить счета контрагента');
      });
    return () => {
      cancelled = true;
    };
  }, [closesInvoice, form.counterpartyId]);

  const changeType = (type: DocType) => {
    setForm((prev) => ({
      ...prev,
      type,
      section: isInitiator || !sectionTouched ? SECTION_BY_TYPE[type] : prev.section,
      // Счёт закрывают только акт и накладная — у остальных связь теряет смысл.
      closesDocumentId: CLOSING_TYPES.includes(type) ? prev.closesDocumentId : '',
    }));
  };

  const changeCounterparty = (value: string) => {
    // И договор, и закрываемый счёт принадлежат прежнему контрагенту — чужие
    // связи сохранять нельзя.
    setForm((prev) => ({ ...prev, counterpartyId: value, contractId: '', closesDocumentId: '' }));
  };

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

    // Поле закрываемого счёта отдаём всегда: пустое значение — это «связь снять»,
    // и без него отвязать ошибочно выбранный счёт было бы нечем.
    const payload: DocumentInput & { closesDocumentId: number | null } = {
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
      closesDocumentId: closesInvoice && form.closesDocumentId ? Number(form.closesDocumentId) : null,
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

  const vatHint = vatTouched
    ? `Ставка на дату документа — ${vatRateLabel}`
    : counterparty && !counterparty.isVatPayer
      ? 'Контрагент не плательщик НДС'
      : `Считается автоматически по ставке ${vatRateLabel}`;

  // Выбранный счёт мог не попасть в выборку (старый, за пределами двухсот).
  // Показываем его отдельной строкой, иначе сохранение молча снимет связь.
  const closesMissing =
    form.closesDocumentId !== '' && !invoices.some((d) => String(d.id) === form.closesDocumentId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 py-10"
      // Закрываем по нажатию именно на подложку: click срабатывал бы и когда
      // кнопку мыши отпустили мимо окна, выделяя текст внутри формы.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-2xl rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 id={titleId} className="text-lg font-semibold text-slate-900">
            {document ? `Документ ${document.number}` : 'Новый документ'}
          </h3>
          <Button variant="ghost" size="icon" onClick={onClose} type="button" aria-label="Закрыть">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Тип документа">
              <Select value={form.type} onChange={(v) => changeType(v as DocType)}>
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
            <Field label="Дата документа" hint={`Определяет период и ставку НДС — сейчас ${vatRateLabel}`}>
              <Input type="date" value={form.docDate} onChange={(e) => set('docDate', e.target.value)} required />
            </Field>
            <Field label="Срок оплаты" hint="Пусто — срока нет">
              <Input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Контрагент">
              <Select value={form.counterpartyId} onChange={changeCounterparty}>
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

          {closesInvoice && (
            <Field
              label="Закрывает счёт"
              hint={
                !form.counterpartyId
                  ? 'Сначала выберите контрагента'
                  : invoicesError ||
                    'Счёт на оплату сам по себе обязательства не создаёт — начисление появляется от акта или накладной. Указанный счёт выпадает из начислений, поэтому сальдо по контрагенту не задваивается, но оплаты по-прежнему разносятся на него.'
              }
            >
              <Select
                value={form.closesDocumentId}
                onChange={(v) => set('closesDocumentId', v)}
                disabled={!form.counterpartyId}
              >
                <option value="">— ничего не закрывает —</option>
                {closesMissing && <option value={form.closesDocumentId}>Выбранный ранее счёт</option>}
                {invoices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.number} от {formatDate(d.docDate)} · {formatMoney(d.amount)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

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
            <Field label="в т.ч. НДС, ₸" hint={vatHint}>
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

          <div className={cn('grid gap-4', isInitiator ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
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
            {!isInitiator && (
              <>
                <Field label="Участок">
                  <Select
                    value={form.section}
                    onChange={(v) => {
                      setSectionTouched(true);
                      set('section', v as Section);
                    }}
                  >
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
              </>
            )}
          </div>

          <Field label="Назначение платежа">
            <textarea
              className="min-h-[72px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
              value={form.purpose}
              onChange={(e) => set('purpose', e.target.value)}
              placeholder="За что платим — попадёт в платёжное поручение"
            />
          </Field>

          {isInitiator && (
            <p className="text-xs text-slate-400">
              Участок и ответственного бухгалтера подставит бухгалтерия — вам их выбирать не нужно.
            </p>
          )}

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

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Обвязка модального окна: Escape, ловушка Tab и возврат фокуса туда, откуда
 * окно открыли. Без неё клавиатура уходит в форму под подложкой — пользователь
 * правит документ, который даже не видит, — а закрыть окно можно только мышью.
 *
 * Хук лежит рядом с первой модалкой, а не в общих примитивах: модалок в портале
 * пока две, и общий компонент Modal был бы обобщением на глазок.
 */
export function useModalChrome<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  // onClose почти всегда стрелка прямо из JSX и меняется каждый рендер. Держим
  // его в ref: с ним в зависимостях эффект пересобирался бы на каждый ввод
  // символа и возвращал фокус открывшей кнопке посреди заполнения формы.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    // window.document, а не document: в этом файле имя `document` занято пропом.
    const doc = window.document;
    const opener = doc.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      const panel = ref.current;
      if (!panel) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        // Скрытые поля в обход не берём: иначе Tab «застревает» на невидимом.
        (el) => el.offsetParent !== null
      );
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = doc.activeElement;
      const edge = event.shiftKey ? active === first : active === last;
      if (edge || !panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };

    doc.addEventListener('keydown', onKeyDown, true);
    return () => {
      doc.removeEventListener('keydown', onKeyDown, true);
      // Фокус возвращаем на элемент, которым окно открыли: иначе он падает
      // в начало страницы и читалка теряет место.
      opener?.focus?.();
    };
  }, []);

  return ref;
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
