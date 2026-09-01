import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import type { ReconciliationDetail as ActDetail } from '@/types';

const ACTION_LABELS: Record<string, string> = {
  created: 'Акт сформирован',
  rebuilt: 'Снимок пересобран',
  their_balance: 'Внесено сальдо контрагента',
  line_matched: 'Сверена строка',
  line_resolved: 'Расхождение разобрано',
  line_reopened: 'Расхождение возвращено в работу',
  line_added: 'Добавлена строка контрагента',
  line_deleted: 'Удалена строка контрагента',
  imported: 'Загружена выписка контрагента',
  transition: 'Смена статуса',
};

/** Кто и что делал с актом. Спор с контрагентом тянется неделями, и «почему
 *  здесь эта цифра» спрашивают уже после того, как все всё забыли. */
export function History({ act }: { act: ActDetail }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">История</CardTitle>
        <CardDescription>Сформирован {formatDateTime(act.builtAt)}</CardDescription>
      </CardHeader>
      <CardContent>
        {act.history.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Пока пусто</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {act.history.map((entry) => {
              const details = entry.details as Record<string, unknown> | null;
              const comment = details && typeof details.comment === 'string' ? details.comment : '';
              return (
                <div key={entry.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="text-slate-900">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                    <span className="text-slate-400"> · {entry.userName}</span>
                    {comment && <div className="text-xs italic text-slate-500">{comment}</div>}
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">{formatDateTime(entry.createdAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
