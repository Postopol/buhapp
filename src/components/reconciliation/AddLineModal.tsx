import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Loader2 } from 'lucide-react';
import { parseMoney } from '@/lib/format';
import { ApiError } from '@/services/api';

/** Документ, который есть у контрагента и которого нет у нас. */
export function AddLineModal({
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
    // Минус тут не принимаем осознанно: сервер требует строго положительную
    // сумму, отрицательная строка — это корректировка к существующей.
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
    <Modal
      title="Строка контрагента"
      description="Документ, который есть у него и которого нет у нас"
      onClose={onClose}
      className="max-w-md"
    >
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
    </Modal>
  );
}
