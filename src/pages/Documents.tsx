import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Search, Plus, Download, Loader2, CheckCheck, Undo2, X, ChevronLeft, ChevronRight, SlidersHorizontal,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { listDocuments, bulkTransition, exportUrl, type DocumentFilters } from '@/services/documents';
import { getDictionaries } from '@/services/directory';
import { ApiError } from '@/services/api';
import { formatAmount, formatMoneyShort, formatDate, dueLabel, formatPeriod, plural } from '@/lib/format';
import { ApprovalChip, OriginalChip, PaymentChip, PostingChip } from '@/components/StatusChips';
import { DocumentFormModal } from '@/components/DocumentFormModal';
import {
  APPROVAL_LABELS, DOC_TYPE_LABELS, DOC_TYPE_SHORT, DOC_TYPES, ORIGINAL_LABELS,
  ORIGINAL_STATUSES, PAGE_SIZE, SECTIONS, SECTION_LABELS,
} from '@shared/domain';
import { cn } from '@/lib/utils';
import type { Dictionaries, Document, DocumentListResponse } from '@/types';

/** Фильтры живут в URL: ссылку на выборку можно отправить коллеге. */
const FILTER_KEYS = [
  'search', 'type', 'section', 'approval', 'original', 'payment',
  'posting', 'counterparty', 'period', 'overdue', 'mine', 'sort', 'dir',
] as const;

export function Documents() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [data, setData] = useState<DocumentListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dictionaries, setDictionaries] = useState<Dictionaries | null>(null);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [bulkAction, setBulkAction] = useState<'approved' | 'returned' | null>(null);
  const [bulkComment, setBulkComment] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');

  const offset = Number(params.get('offset') ?? 0);

  const filters = useMemo(() => {
    const result: DocumentFilters = { limit: PAGE_SIZE, offset };
    for (const key of FILTER_KEYS) {
      const value = params.get(key);
      if (value) (result as Record<string, string>)[key] = value;
    }
    return result;
  }, [params, offset]);

  // Поиск отдельным стейтом с задержкой — URL не должен дёргаться на каждой букве.
  useEffect(() => {
    const current = params.get('search') ?? '';
    if (searchDraft === current) return;
    const timer = setTimeout(() => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (searchDraft) next.set('search', searchDraft);
        else next.delete('search');
        next.delete('offset');
        return next;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, params, setParams]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    return listDocuments(filters)
      .then((res) => setData(res))
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить документы'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    getDictionaries().then(setDictionaries).catch(() => setDictionaries(null));
  }, []);

  // «/» ставит курсор в поиск — бухгалтер работает с клавиатуры.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape' && !typing) setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setFilter = (key: string, value: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value && value !== 'all') next.set(key, value);
      else next.delete(key);
      next.delete('offset');
      return next;
    });
    setSelected(new Set());
  };

  const resetFilters = () => {
    setSearchDraft('');
    setParams(new URLSearchParams());
    setSelected(new Set());
  };

  const activeFilterCount = FILTER_KEYS.filter(
    (k) => k !== 'search' && k !== 'sort' && k !== 'dir' && params.get(k)
  ).length;

  const documents = data?.documents ?? [];
  const allSelected = documents.length > 0 && documents.every((d) => selected.has(d.id));

  const toggleAll = () => {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        documents.forEach((d) => next.delete(d.id));
        return next;
      }
      return new Set([...prev, ...documents.map((d) => d.id)]);
    });
  };

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Сумма по выделенным — то, за чем бухгалтер обычно лезет в Excel.
  const selectedSum = documents
    .filter((d) => selected.has(d.id))
    .reduce((sum, d) => sum + d.amount, 0);

  const canBulk = role === 'accountant' || role === 'chief_accountant';

  const runBulk = async () => {
    if (!bulkAction) return;
    if (bulkAction === 'returned' && !bulkComment.trim()) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const res = await bulkTransition([...selected], bulkAction, bulkComment);
      const parts: string[] = [];
      if (res.applied.length) {
        parts.push(`Обработано: ${plural(res.applied.length, 'документ', 'документа', 'документов')}`);
      }
      if (res.skipped.length) {
        const reasons = [...new Set(res.skipped.map((s) => s.reason))].slice(0, 2).join('; ');
        parts.push(`Пропущено ${res.skipped.length} — ${reasons}`);
      }
      setBulkResult(parts.join('. ') || 'Ничего не изменилось');
      setSelected(new Set());
      setBulkAction(null);
      setBulkComment('');
      await load();
    } catch (err) {
      setBulkResult(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
    } finally {
      setBulkBusy(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const goPage = (page: number) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const newOffset = (page - 1) * PAGE_SIZE;
      if (newOffset > 0) next.set('offset', String(newOffset));
      else next.delete('offset');
      return next;
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Реестр документов</h2>
          <p className="text-slate-500">
            {data ? plural(data.total, 'документ', 'документа', 'документов') : '—'} по текущему фильтру
          </p>
        </div>
        <div className="flex gap-2">
          <a href={exportUrl(filters)}>
            <Button variant="outline" className="gap-2">
              <Download className="h-4 w-4" />
              В Excel
            </Button>
          </a>
          {dictionaries && (
            <Button className="gap-2" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              Новый документ
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          {/* Строка поиска и переключатели */}
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-[240px] flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <Input
                ref={searchRef}
                placeholder="Номер, контрагент, БИН, назначение…   /"
                className="pl-9"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
              />
            </div>
            <Toggle
              active={params.get('overdue') === 'true'}
              onClick={() => setFilter('overdue', params.get('overdue') === 'true' ? '' : 'true')}
            >
              Просроченные
            </Toggle>
            <Toggle
              active={params.get('mine') === 'true'}
              onClick={() => setFilter('mine', params.get('mine') === 'true' ? '' : 'true')}
            >
              Только мои
            </Toggle>
            <Button
              variant={showFilters || activeFilterCount ? 'secondary' : 'outline'}
              className="gap-2"
              onClick={() => setShowFilters((v) => !v)}
            >
              <SlidersHorizontal className="h-4 w-4" />
              Фильтры
              {activeFilterCount > 0 && (
                <span className="rounded bg-slate-900 px-1.5 text-xs text-white">{activeFilterCount}</span>
              )}
            </Button>
            {(activeFilterCount > 0 || searchDraft) && (
              <Button variant="ghost" onClick={resetFilters} className="gap-1 text-slate-500">
                <X className="h-4 w-4" />
                Сбросить
              </Button>
            )}
          </div>

          {showFilters && (
            <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3 sm:grid-cols-3 lg:grid-cols-4">
              <FilterSelect label="Тип" value={params.get('type') ?? 'all'} onChange={(v) => setFilter('type', v)}>
                <option value="all">Все типы</option>
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>{DOC_TYPE_LABELS[t]}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Согласование" value={params.get('approval') ?? 'all'} onChange={(v) => setFilter('approval', v)}>
                <option value="all">Любое</option>
                {Object.entries(APPROVAL_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Оригинал" value={params.get('original') ?? 'all'} onChange={(v) => setFilter('original', v)}>
                <option value="all">Любой</option>
                {ORIGINAL_STATUSES.map((s) => (
                  <option key={s} value={s}>{ORIGINAL_LABELS[s]}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Оплата" value={params.get('payment') ?? 'all'} onChange={(v) => setFilter('payment', v)}>
                <option value="all">Любая</option>
                <option value="unpaid">Не оплачен</option>
                <option value="partial">Частично</option>
                <option value="paid">Оплачен</option>
              </FilterSelect>

              <FilterSelect label="Учёт" value={params.get('posting') ?? 'all'} onChange={(v) => setFilter('posting', v)}>
                <option value="all">Любой</option>
                <option value="not_posted">Не проведён</option>
                <option value="posted">Проведён</option>
              </FilterSelect>

              <FilterSelect label="Участок" value={params.get('section') ?? 'all'} onChange={(v) => setFilter('section', v)}>
                <option value="all">Все участки</option>
                {SECTIONS.map((s) => (
                  <option key={s} value={s}>{SECTION_LABELS[s]}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Контрагент" value={params.get('counterparty') ?? 'all'} onChange={(v) => setFilter('counterparty', v)}>
                <option value="all">Все контрагенты</option>
                {dictionaries?.counterparties.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Период" value={params.get('period') ?? 'all'} onChange={(v) => setFilter('period', v)}>
                <option value="all">Все периоды</option>
                {dictionaries?.periods.map((p) => (
                  <option key={p} value={p}>{formatPeriod(p)}</option>
                ))}
              </FilterSelect>
            </div>
          )}

          {/* Панель массовых действий */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-900 bg-slate-900 px-4 py-2.5 text-white">
              <span className="text-sm font-medium">
                Выбрано {plural(selected.size, 'документ', 'документа', 'документов')}
              </span>
              <span className="text-sm tabular-nums text-slate-300">на {formatMoneyShort(selectedSum)}</span>
              <div className="ml-auto flex gap-2">
                {canBulk && (
                  <>
                    <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => setBulkAction('approved')}>
                      <CheckCheck className="h-4 w-4" />
                      Согласовать
                    </Button>
                    <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => setBulkAction('returned')}>
                      <Undo2 className="h-4 w-4" />
                      Вернуть
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" className="text-slate-300 hover:bg-slate-800 hover:text-white" onClick={() => setSelected(new Set())}>
                  Снять
                </Button>
              </div>
            </div>
          )}

          {bulkResult && (
            <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
              <span className="flex-1">{bulkResult}</span>
              <button onClick={() => setBulkResult(null)} className="text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          ) : (
            /* Данные не гаснут при обновлении — только слегка блёкнут */
            <div className={cn('relative transition-opacity', loading && data && 'opacity-50')}>
              {loading && !data && (
                <div className="flex items-center justify-center py-16 text-slate-400">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Загрузка…
                </div>
              )}

              {data && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8 px-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer rounded border-slate-300"
                          checked={allSelected}
                          onChange={toggleAll}
                          aria-label="Выделить все"
                        />
                      </TableHead>
                      <TableHead className="px-2">Дата</TableHead>
                      <TableHead className="px-2">Документ</TableHead>
                      <TableHead className="px-2">Контрагент</TableHead>
                      <TableHead className="px-2 text-right">Сумма</TableHead>
                      <TableHead className="px-2 text-right">НДС</TableHead>
                      <TableHead className="px-2">Статья</TableHead>
                      <TableHead className="px-2">Срок</TableHead>
                      <TableHead className="px-2">Статусы</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {documents.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-12 text-center text-slate-400">
                          Ничего не найдено. Попробуйте снять фильтры.
                        </TableCell>
                      </TableRow>
                    ) : (
                      documents.map((doc) => (
                        <DocumentRow
                          key={doc.id}
                          doc={doc}
                          checked={selected.has(doc.id)}
                          onToggle={() => toggleOne(doc.id)}
                          onOpen={() => navigate(`/documents/${doc.id}`)}
                        />
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </div>
          )}

          {/* Итоги по всей выборке, а не по странице */}
          {data && data.total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-3 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <Total label="Итого" value={formatMoneyShort(data.totals.amount)} strong />
                <Total label="в т.ч. НДС" value={formatMoneyShort(data.totals.vat)} />
                <Total label="Оплачено" value={formatMoneyShort(data.totals.paid)} />
                <Total label="Осталось" value={formatMoneyShort(data.totals.unpaid)} />
              </div>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => goPage(currentPage - 1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-slate-500 tabular-nums">
                    {currentPage} / {totalPages}
                  </span>
                  <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => goPage(currentPage + 1)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {showCreate && dictionaries && (
        <DocumentFormModal
          dictionaries={dictionaries}
          onClose={() => setShowCreate(false)}
          onSaved={(doc) => {
            setShowCreate(false);
            navigate(`/documents/${doc.id}`);
          }}
        />
      )}

      {bulkAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-900">
              {bulkAction === 'approved' ? 'Согласовать документы' : 'Вернуть на доработку'}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Выбрано {plural(selected.size, 'документ', 'документа', 'документов')} на {formatMoneyShort(selectedSum)}.
              {bulkAction === 'approved' &&
                ' Документы, которые вам не по правам, будут пропущены — их список покажем после.'}
            </p>
            <textarea
              className="mt-4 min-h-[90px] w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
              placeholder={bulkAction === 'returned' ? 'Причина возврата — обязательно' : 'Комментарий (необязательно)'}
              value={bulkComment}
              onChange={(e) => setBulkComment(e.target.value)}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setBulkAction(null); setBulkComment(''); }}>
                Отмена
              </Button>
              <Button onClick={runBulk} disabled={bulkBusy || (bulkAction === 'returned' && !bulkComment.trim())}>
                {bulkBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {bulkAction === 'approved' ? 'Согласовать' : 'Вернуть'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentRow({
  doc,
  checked,
  onToggle,
  onOpen,
}: {
  doc: Document;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const due = dueLabel(doc.dueDate);
  return (
    <TableRow className={cn('cursor-pointer', checked && 'bg-slate-50')} onClick={onOpen}>
      <TableCell className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer rounded border-slate-300"
          checked={checked}
          onChange={onToggle}
          aria-label={`Выделить ${doc.number}`}
        />
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2 text-slate-500">{formatDate(doc.docDate)}</TableCell>
      <TableCell className="px-2 py-2">
        <div className="font-medium text-slate-900">{doc.number}</div>
        <div className="text-xs text-slate-400">{DOC_TYPE_SHORT[doc.type]}</div>
      </TableCell>
      <TableCell className="max-w-[220px] px-2 py-2">
        <div className="truncate text-slate-700">{doc.counterpartyName ?? '—'}</div>
        {doc.purpose && <div className="truncate text-xs text-slate-400">{doc.purpose}</div>}
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums text-slate-900">
        {formatAmount(doc.amount)}
        {doc.paid > 0 && doc.paid < doc.amount && (
          <div className="text-xs font-normal text-amber-600">−{formatAmount(doc.paid)}</div>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-slate-400">
        {doc.vat > 0 ? formatAmount(doc.vat) : '—'}
      </TableCell>
      <TableCell className="max-w-[140px] px-2 py-2">
        <span className="block truncate text-xs text-slate-500">{doc.expenseItemName ?? '—'}</span>
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2">
        {due ? (
          <div className={cn('text-xs', due.overdue ? 'font-medium text-red-600' : 'text-slate-500')}>
            <div>{formatDate(doc.dueDate)}</div>
            <div className={due.overdue ? 'text-red-500' : 'text-slate-400'}>{due.text}</div>
          </div>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        )}
      </TableCell>
      <TableCell className="px-2 py-2">
        <div className="flex flex-wrap gap-1">
          <ApprovalChip status={doc.approvalStatus} />
          <OriginalChip status={doc.originalStatus} />
          <PaymentChip state={doc.paymentState} />
          <PostingChip status={doc.postingStatus} />
        </div>
      </TableCell>
    </TableRow>
  );
}

function Toggle({
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
        'h-10 rounded-md border px-3 text-sm font-medium transition-colors',
        active
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
      )}
    >
      {children}
    </button>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <select
        className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-slate-500">{label}:</span>
      <span className={cn('tabular-nums', strong ? 'font-semibold text-slate-900' : 'text-slate-700')}>
        {value}
      </span>
    </span>
  );
}
