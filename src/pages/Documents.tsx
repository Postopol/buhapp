import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Search, Plus, Download, Loader2, CheckCheck, Undo2, X, ChevronLeft, ChevronRight, SlidersHorizontal,
  ArrowDown, ArrowUp, ChevronsUpDown,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { listDocuments, bulkTransition, exportUrl, type DocumentFilters } from '@/services/documents';
import { getDictionaries } from '@/services/directory';
import { ApiError } from '@/services/api';
import { formatAmount, formatMoneyShort, formatDate, dueLabel, formatPeriod, plural } from '@/lib/format';
import { ApprovalChip, OriginalChip, PaymentChip, PostingChip } from '@/components/StatusChips';
import { DocumentFormModal } from '@/components/DocumentFormModal';
import { SavedViews } from '@/components/SavedViews';
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

/**
 * Колонки, которые умеет сортировать сервер (SORTABLE в server/routes/documents.ts),
 * и направление первого клика: даты и суммы бухгалтер смотрит от больших к меньшим,
 * тексты — по алфавиту, а срок оплаты — от ближайшего, иначе просроченные уедут вниз.
 */
const SORT_COLUMNS: Record<string, 'asc' | 'desc'> = {
  docDate: 'desc',
  number: 'asc',
  counterparty: 'asc',
  amount: 'desc',
  dueDate: 'asc',
};

/** Сервер без параметров сортирует по дате документа вниз — стрелка должна это показывать. */
const DEFAULT_SORT = 'docDate';

export function Documents() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [data, setData] = useState<DocumentListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dictionaries, setDictionaries] = useState<Dictionaries | null>(null);

  /**
   * Выделение переживает смену страницы, поэтому рядом с id храним сумму документа:
   * иначе подпись «Выбрано 8 документов» стояла бы рядом с суммой только тех,
   * что видны сейчас, и бухгалтер увёл бы в работу неверную цифру.
   */
  const [selected, setSelected] = useState<Map<number, number>>(new Map());
  const [showFilters, setShowFilters] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [bulkAction, setBulkAction] = useState<'approved' | 'returned' | null>(null);
  const [bulkComment, setBulkComment] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');

  /** Сигнал плиткам сохранённых фильтров: реестр изменился, счётчики пора пересчитать. */
  const [viewsReloadKey, setViewsReloadKey] = useState(0);

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

  /**
   * Фильтры переключают быстрее, чем отвечает сервер. Без отсечки ответ на
   * прошлый запрос перезапишет таблицу и итоги, которые уже относятся к другому
   * URL, а его finally погасит loading, пока новый запрос ещё летит. Поэтому у
   * каждого запроса свой номер, и результат принимает только самый свежий.
   */
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const res = await listDocuments(filters);
      if (seq !== requestSeq.current) return;
      setData(res);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : 'Не удалось загрузить документы');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
    // Размонтирование и смена фильтра одинаково обесценивают летящий ответ.
    return () => {
      requestSeq.current++;
    };
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
      if (e.key === 'Escape' && !typing) setSelected(new Map());
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
    setSelected(new Map());
  };

  const resetFilters = () => {
    setSearchDraft('');
    setParams(new URLSearchParams());
    setSelected(new Map());
  };

  // Незнакомый sort из чужой ссылки сервер молча заменит на дату документа —
  // стрелка в заголовке должна показывать то же, а не «сортировки нет».
  const rawSort = params.get('sort');
  const sortKey = rawSort && rawSort in SORT_COLUMNS ? rawSort : DEFAULT_SORT;
  const sortDir: 'asc' | 'desc' = params.get('dir') === 'asc' ? 'asc' : 'desc';

  /**
   * Сортировка меняет только порядок, а не состав выборки, поэтому выделение
   * не сбрасываем — в отличие от смены фильтра. Страницу же начинаем сначала:
   * третья страница другого порядка ничего общего с прежней не имеет.
   */
  const toggleSort = (column: string) => {
    const nextDir =
      sortKey === column ? (sortDir === 'asc' ? 'desc' : 'asc') : (SORT_COLUMNS[column] ?? 'desc');
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('sort', column);
      next.set('dir', nextDir);
      next.delete('offset');
      return next;
    });
  };

  const activeFilterCount = FILTER_KEYS.filter(
    (k) => k !== 'search' && k !== 'sort' && k !== 'dir' && params.get(k)
  ).length;

  /** Текущий фильтр в том же виде, в каком он хранится в пресете. */
  const currentQuery = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of FILTER_KEYS) {
      const value = params.get(key);
      if (value && value !== 'all') out[key] = value;
    }
    return out;
  }, [params]);

  const applyView = (query: Record<string, string>) => {
    setSearchDraft(query.search ?? '');
    setParams(new URLSearchParams(query));
    setSelected(new Map());
  };

  const documents = data?.documents ?? [];
  const selectedOnPage = documents.filter((d) => selected.has(d.id)).length;
  const allSelected = documents.length > 0 && selectedOnPage === documents.length;

  // Частичное выделение страницы честнее показывать «квадратиком»: пустая галка
  // рядом с половиной отмеченных строк читается как «ничего не выбрано».
  // indeterminate живёт только в DOM, атрибутом его не задать — отсюда ref.
  const partlySelected = selectedOnPage > 0 && !allSelected;
  const selectAllRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (node) node.indeterminate = partlySelected;
    },
    [partlySelected]
  );

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allSelected) documents.forEach((d) => next.delete(d.id));
      else documents.forEach((d) => next.set(d.id, d.amount));
      return next;
    });
  };

  const toggleOne = (doc: Document) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(doc.id)) next.delete(doc.id);
      else next.set(doc.id, doc.amount);
      return next;
    });
  };

  // Сумма по выделенным — то, за чем бухгалтер обычно лезет в Excel. Считается по
  // всему выделению, включая строки с других страниц: цифра и подпись должны сойтись.
  const selectedSum = useMemo(() => {
    let sum = 0;
    for (const amount of selected.values()) sum += amount;
    return sum;
  }, [selected]);

  const canBulk = role === 'accountant' || role === 'chief_accountant';

  const runBulk = async () => {
    if (!bulkAction) return;
    if (bulkAction === 'returned' && !bulkComment.trim()) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const res = await bulkTransition([...selected.keys()], bulkAction, bulkComment);
      const parts: string[] = [];
      if (res.applied.length) {
        parts.push(`Обработано: ${plural(res.applied.length, 'документ', 'документа', 'документов')}`);
      }
      if (res.skipped.length) {
        const reasons = [...new Set(res.skipped.map((s) => s.reason))].slice(0, 2).join('; ');
        parts.push(`Пропущено ${res.skipped.length} — ${reasons}`);
      }
      setBulkResult(parts.join('. ') || 'Ничего не изменилось');
      setSelected(new Map());
      setBulkAction(null);
      setBulkComment('');
      await load();
      // Согласование перекладывает документы между сохранёнными фильтрами:
      // цифра на плитке не должна разойтись с тем, что покажет список.
      setViewsReloadKey((k) => k + 1);
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

      {/* Сохранённые фильтры со счётчиками — личная панель работы */}
      <SavedViews current={currentQuery} onApply={applyView} reloadKey={viewsReloadKey} />

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
              {/* Иначе непонятно, почему выбрано больше, чем видно отмеченных строк. */}
              {selected.size > selectedOnPage && (
                <span className="text-xs text-slate-400">
                  из них {selected.size - selectedOnPage} на других страницах
                </span>
              )}
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
                <Button size="sm" variant="ghost" className="text-slate-300 hover:bg-slate-800 hover:text-white" onClick={() => setSelected(new Map())}>
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
                          ref={selectAllRef}
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer rounded border-slate-300"
                          checked={allSelected}
                          onChange={toggleAll}
                          aria-label={
                            allSelected ? 'Снять выделение со страницы' : 'Выделить все на странице'
                          }
                        />
                      </TableHead>
                      <SortHeader column="docDate" label="Дата" sort={sortKey} dir={sortDir} onSort={toggleSort} />
                      <SortHeader column="number" label="Документ" sort={sortKey} dir={sortDir} onSort={toggleSort} />
                      <SortHeader column="counterparty" label="Контрагент" sort={sortKey} dir={sortDir} onSort={toggleSort} />
                      <SortHeader column="amount" label="Сумма" sort={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                      <TableHead className="px-2 text-right">НДС</TableHead>
                      <TableHead className="px-2">Статья</TableHead>
                      <SortHeader column="dueDate" label="Срок" sort={sortKey} dir={sortDir} onSort={toggleSort} />
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
                          onToggle={() => toggleOne(doc)}
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
            // Новый документ попадает в чьи-то сохранённые фильтры — счётчики
            // должны пересчитаться, даже если сейчас мы уходим в карточку.
            setViewsReloadKey((k) => k + 1);
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

/**
 * Ячейка-ссылка. Раньше строка открывалась через onClick на <tr>: такую «ссылку»
 * не видит скринридер, на неё не встать с клавиатуры и не открыть документ средней
 * кнопкой или Ctrl+кликом — а реестр это главный экран бухгалтера. Теперь ссылка
 * настоящая и растянута на всю ячейку, поэтому попадание мышью не изменилось.
 * В обход по Tab пускаем только номер документа (tabbable): восемь остановок
 * на строку сделали бы клавиатурную работу невозможной.
 */
function CellLink({
  to,
  tabbable,
  cellClassName,
  className,
  children,
}: {
  to: string;
  tabbable?: boolean;
  cellClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TableCell className={cn('p-0', cellClassName)}>
      <Link
        to={to}
        tabIndex={tabbable ? undefined : -1}
        className={cn(
          'block px-2 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-950',
          className
        )}
      >
        {children}
      </Link>
    </TableCell>
  );
}

function DocumentRow({
  doc,
  checked,
  onToggle,
}: {
  doc: Document;
  checked: boolean;
  onToggle: () => void;
}) {
  const due = dueLabel(doc.dueDate);
  const to = `/documents/${doc.id}`;
  return (
    <TableRow className={cn(checked && 'bg-slate-50')}>
      <TableCell className="px-2 py-2">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer rounded border-slate-300"
          checked={checked}
          onChange={onToggle}
          aria-label={`Выделить ${doc.number}`}
        />
      </TableCell>
      <CellLink to={to} className="whitespace-nowrap text-slate-500">
        {formatDate(doc.docDate)}
      </CellLink>
      <CellLink to={to} tabbable>
        <div className="font-medium text-slate-900">{doc.number}</div>
        <div className="text-xs text-slate-400">{DOC_TYPE_SHORT[doc.type]}</div>
      </CellLink>
      <CellLink to={to} cellClassName="max-w-[220px]">
        <div className="truncate text-slate-700">{doc.counterpartyName ?? '—'}</div>
        {doc.purpose && <div className="truncate text-xs text-slate-400">{doc.purpose}</div>}
      </CellLink>
      <CellLink to={to} className="whitespace-nowrap text-right font-medium tabular-nums text-slate-900">
        {formatAmount(doc.amount)}
        {doc.paid > 0 && doc.paid < doc.amount && (
          <div className="text-xs font-normal text-amber-600">−{formatAmount(doc.paid)}</div>
        )}
      </CellLink>
      <CellLink to={to} className="whitespace-nowrap text-right tabular-nums text-slate-400">
        {doc.vat > 0 ? formatAmount(doc.vat) : '—'}
      </CellLink>
      <CellLink to={to} cellClassName="max-w-[140px]">
        <span className="block truncate text-xs text-slate-500">{doc.expenseItemName ?? '—'}</span>
      </CellLink>
      <CellLink to={to} className="whitespace-nowrap">
        {due ? (
          <div className={cn('text-xs', due.overdue ? 'font-medium text-red-600' : 'text-slate-500')}>
            <div>{formatDate(doc.dueDate)}</div>
            <div className={due.overdue ? 'text-red-500' : 'text-slate-400'}>{due.text}</div>
          </div>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        )}
      </CellLink>
      <CellLink to={to}>
        <div className="flex flex-wrap gap-1">
          <ApprovalChip status={doc.approvalStatus} />
          <OriginalChip status={doc.originalStatus} />
          <PaymentChip state={doc.paymentState} />
          <PostingChip status={doc.postingStatus} />
        </div>
      </CellLink>
    </TableRow>
  );
}

/**
 * Заголовок-сортировка. Сервер сортировку уже умеет, а параметры лежат в URL и
 * в пресетах — не хватало только способа их задать мышью. aria-sort нужен, чтобы
 * скринридер называл текущий порядок, а не только «кнопка Сумма».
 */
function SortHeader({
  column,
  label,
  sort,
  dir,
  onSort,
  align = 'left',
}: {
  column: string;
  label: string;
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (column: string) => void;
  align?: 'left' | 'right';
}) {
  const active = sort === column;
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn('px-2', align === 'right' && 'text-right')}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1 rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950',
          active ? 'text-slate-900' : 'hover:text-slate-700'
        )}
      >
        {label}
        <Icon className={cn('h-3.5 w-3.5', active ? 'text-slate-700' : 'text-slate-300')} />
      </button>
    </TableHead>
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
      type="button"
      onClick={onClick}
      // Кнопка-тумблер: без aria-pressed скринридер прочитает её как обычную
      // кнопку и не скажет, включён фильтр или нет.
      aria-pressed={active}
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
