import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Loader2 } from 'lucide-react';
import { ApiError } from '@/services/api';
import type { ReconciliationDetail as ActDetail } from '@/types';

/** Выписка контрагента как есть — из письма или Excel. Разбор на сервере:
 *  там же лежит сопоставление со строками акта. */
export function ImportModal({
  onClose,
  onImport,
  onDone,
}: {
  onClose: () => void;
  onImport: (text: string, kind: 'accrued' | 'paid') => Promise<{ act: ActDetail; parsed: { rows: number; skipped: { raw: string; reason: string }[] } }>;
  onDone: (act: ActDetail) => void;
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'accrued' | 'paid'>('accrued');
  const [result, setResult] = useState<{ rows: number; skipped: { raw: string; reason: string }[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await onImport(text, kind);
      setResult(res.parsed);
      onDone(res.act);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось разобрать');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Выписка контрагента"
      description="Вставьте как есть — из письма или Excel. Колонки: дата, номер, начислено, оплачено"
      onClose={onClose}
      className="max-h-[90vh] max-w-2xl overflow-auto"
    >
      <div className="mt-4 space-y-4">
        <textarea
          className="min-h-[180px] w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'01.07.2026\tСЧ-4471\t3 400 000,00\t0\n15.07.2026\tПП-341\t0\t3 400 000,00'}
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Если колонка суммы одна, считать её:
          <select
            className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'accrued' | 'paid')}
          >
            <option value="accrued">начислением</option>
            <option value="paid">оплатой</option>
          </select>
        </label>

        {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {result && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
            <p className="font-medium text-slate-900">
              Разобрано строк: {result.rows}
              {result.skipped.length > 0 && `, пропущено: ${result.skipped.length}`}
            </p>
            {result.skipped.length > 0 && (
              <ul className="mt-2 space-y-1">
                {result.skipped.map((s, i) => (
                  <li key={i} className="font-mono text-xs text-slate-500">
                    {s.raw} — {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {result ? 'Закрыть' : 'Отмена'}
          </Button>
          <Button onClick={submit} disabled={busy || !text.trim()}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Разобрать и сопоставить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
