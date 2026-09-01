import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bookmark, BookmarkPlus, Trash2, Users, X, Loader2, Pencil } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { listViews, createView, deleteView, renameView } from '@/services/documents';
import { ApiError } from '@/services/api';
import { formatMoneyShort } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SavedView } from '@/types';

interface Props {
  /** Текущий фильтр реестра — то, что предлагается сохранить. */
  current: Record<string, string>;
  onApply: (query: Record<string, string>) => void;
  /**
   * Меняется, когда реестр изменился (массовое согласование, сохранение документа).
   * Счётчики считаются на сервере в момент запроса, поэтому без такого сигнала
   * цифра на плитке осталась бы от прошлого состояния и разошлась бы со списком.
   */
  reloadKey?: number;
}

/** Два фильтра совпадают, если совпадает набор пар ключ-значение. */
function sameQuery(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((key, i) => key === kb[i] && a[key] === b[key]);
}

export function SavedViews({ current, onApply, reloadKey = 0 }: Props) {
  const { role } = useAuth();
  const [views, setViews] = useState<SavedView[]>([]);
  const [error, setError] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [editing, setEditing] = useState<SavedView | null>(null);

  useEffect(() => {
    // Отсечка на случай, если сигналов пришло несколько подряд: ответ на старый
    // запрос не должен вернуть на плитки уже неактуальные счётчики.
    let cancelled = false;
    listViews()
      .then(({ views }) => {
        if (!cancelled) setViews(views);
      })
      .catch(() => {
        if (!cancelled) setViews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const hasFilter = Object.keys(current).length > 0;
  const active = views.find((v) => sameQuery(v.query, current));
  const alreadySaved = Boolean(active);

  const remove = async (view: SavedView) => {
    setError('');
    try {
      await deleteView(view.id);
      setViews((prev) => prev.filter((v) => v.id !== view.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить фильтр');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {views.map((view) => {
          const isActive = active?.id === view.id;
          return (
            <div
              key={view.id}
              className={cn(
                'group inline-flex items-center rounded-md border text-sm transition-colors',
                isActive
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              )}
            >
              <button
                type="button"
                onClick={() => onApply(view.query)}
                aria-pressed={isActive}
                className="flex items-center gap-2 rounded-md py-1.5 pl-2.5 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-950"
                title={view.shared ? `Общий фильтр — ${view.ownerName}` : 'Личный фильтр'}
              >
                {view.shared ? (
                  <Users className={cn('h-3.5 w-3.5', isActive ? 'text-slate-300' : 'text-slate-400')} />
                ) : (
                  <Bookmark className={cn('h-3.5 w-3.5', isActive ? 'text-slate-300' : 'text-slate-400')} />
                )}
                <span className="font-medium">{view.name}</span>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums',
                    view.count === 0
                      ? isActive
                        ? 'bg-slate-700 text-slate-400'
                        : 'bg-slate-100 text-slate-400'
                      : isActive
                        ? 'bg-white text-slate-900'
                        : 'bg-slate-900 text-white'
                  )}
                  title={view.amount > 0 ? formatMoneyShort(view.amount) : undefined}
                >
                  {view.count}
                </span>
              </button>
              {view.mine && (
                // Кнопки прячутся до наведения, но фокус с клавиатуры мышью не
                // сопровождается — focus-within проявляет их, иначе Tab уходил бы
                // на невидимые кнопки удаления.
                <div className="flex items-center pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => setEditing(view)}
                    className={cn(
                      'rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                      isActive ? 'hover:bg-slate-700 focus-visible:ring-white' : 'hover:bg-slate-100 focus-visible:ring-slate-950'
                    )}
                    title="Переименовать"
                    aria-label={`Переименовать фильтр «${view.name}»`}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(view)}
                    className={cn(
                      'rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                      isActive ? 'hover:bg-slate-700 focus-visible:ring-white' : 'hover:bg-slate-100 focus-visible:ring-slate-950'
                    )}
                    title="Удалить"
                    aria-label={`Удалить фильтр «${view.name}»`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {hasFilter && !alreadySaved && (
          <Button variant="ghost" size="sm" className="gap-1.5 text-slate-500" onClick={() => setShowSave(true)}>
            <BookmarkPlus className="h-4 w-4" />
            Сохранить фильтр
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {showSave && (
        <SaveModal
          query={current}
          canShare={role === 'chief_accountant'}
          onClose={() => setShowSave(false)}
          onSaved={(view) => {
            setShowSave(false);
            setViews((prev) => [...prev, view]);
          }}
        />
      )}

      {editing && (
        <RenameModal
          view={editing}
          onClose={() => setEditing(null)}
          onSaved={(view) => {
            setEditing(null);
            setViews((prev) => prev.map((v) => (v.id === view.id ? view : v)));
          }}
        />
      )}
    </div>
  );
}

function SaveModal({
  query,
  canShare,
  onClose,
  onSaved,
}: {
  query: Record<string, string>;
  canShare: boolean;
  onClose: () => void;
  onSaved: (view: SavedView) => void;
}) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    if (!name.trim()) {
      setError('Укажите название');
      return;
    }
    setSaving(true);
    try {
      const { view } = await createView({ name, query, shared });
      onSaved(view);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Сохранить фильтр" onClose={onClose}>
      <p className="text-sm text-slate-500">
        Фильтр появится плиткой над реестром со счётчиком документов. Условия:{' '}
        <span className="font-mono text-xs text-slate-600">
          {Object.entries(query)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}
        </span>
      </p>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-slate-700">Название</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Мои просроченные по аренде"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </label>
      {canShare && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
          />
          <span className="text-sm text-slate-700">
            Общий для всей бухгалтерии
            <span className="block text-xs text-slate-400">Появится на панели у каждого</span>
          </span>
        </label>
      )}
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
    </Modal>
  );
}

function RenameModal({
  view,
  onClose,
  onSaved,
}: {
  view: SavedView;
  onClose: () => void;
  onSaved: (view: SavedView) => void;
}) {
  const [name, setName] = useState(view.name);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    if (!name.trim()) {
      setError('Название не может быть пустым');
      return;
    }
    setSaving(true);
    try {
      const res = await renameView(view.id, name);
      onSaved(res.view);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось переименовать');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Переименовать фильтр" onClose={onClose}>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-slate-700">Название</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && submit()}
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
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
