import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Что вообще можно взять фокусом внутри окна. Список короткий намеренно:
 *  в модалках портала живут только поля, кнопки и селекты. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Общее модальное окно: подложка, заголовок и крестик.
 *
 * Отдельный компонент нужен не ради разметки, а ради поведения. Модалка
 * перекрывает страницу целиком, поэтому Tab не должен уводить в таблицу под
 * подложкой, Escape обязан закрывать окно, а после закрытия фокус должен
 * вернуться на кнопку, которой окно открыли, — иначе клавиатурой из акта не
 * выбраться.
 */
export function Modal({
  title,
  description,
  onClose,
  className,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  /** Ширина и прокрутка — на усмотрение конкретного окна. */
  className?: string;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Колбэк закрытия приходит инлайновой стрелкой и меняется каждый рендер.
  // Через ref, иначе эффект переподписывался бы и на каждом рендере сбрасывал
  // фокус обратно в начало окна.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const box = boxRef.current;
    const opener = document.activeElement as HTMLElement | null;

    // autoFocus внутри содержимого сильнее: он ставит курсор в нужное поле,
    // а не в первую попавшуюся кнопку.
    if (box && !box.contains(document.activeElement)) {
      box.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('w-full rounded-xl bg-white p-6 shadow-xl', className)}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id={titleId} className="text-lg font-semibold text-slate-900">
              {title}
            </h3>
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
