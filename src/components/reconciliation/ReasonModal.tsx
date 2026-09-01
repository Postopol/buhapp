import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Loader2 } from 'lucide-react';

/** Причина перехода: переходы, меняющие смысл акта (спор, аннулирование),
 *  без объяснения в историю не попадают. */
export function ReasonModal({
  title,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  /** Ошибка перехода приходит с родителя: плашка под окном не видна, а текст
   *  причины при неудаче остаётся набранным — окно закрывает только успех. */
  error: string;
  onClose: () => void;
  onSubmit: (comment: string) => Promise<void>;
}) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={title} description="Причина попадёт в историю акта" onClose={onClose} className="max-w-md">
      <textarea
        className="mt-4 min-h-[80px] w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        autoFocus
      />
      {error && (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button
          disabled={busy || !comment.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(comment);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Подтвердить
        </Button>
      </div>
    </Modal>
  );
}
