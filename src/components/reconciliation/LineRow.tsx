import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TableCell, TableRow } from '@/components/ui/table';
import { formatAmount, formatDate, parseMoney } from '@/lib/format';
import { MatchChip } from '@/components/StatusChips';
import { cn } from '@/lib/utils';
import type { ReconciliationLine } from '@/types';

/** Строка оборота с раскрывающимся диагнозом: что у нас, что у контрагента,
 *  чем объясняется разница и что с ней решили. */
export function LineRow({
  line,
  editable,
  canResolve,
  disabled,
  onPatch,
  onResolve,
  onDelete,
}: {
  line: ReconciliationLine;
  editable: boolean;
  canResolve: boolean;
  disabled: boolean;
  onPatch: (data: { theirAmount?: number | null; comment?: string }) => void;
  onResolve: (data: { comment?: string; resolved?: boolean }) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [theirs, setTheirs] = useState(line.theirAmount === null ? '' : (line.theirAmount / 100).toFixed(2));
  const [comment, setComment] = useState(line.comment);
  const [lineError, setLineError] = useState('');

  // После сохранения, импорта или пересборки сервер отдаёт акт целиком, а id
  // строки не меняется — React сохранил бы старый ввод. Подтягиваем значения
  // из пропса, иначе в поле висит цифра, которой в акте уже нет.
  useEffect(() => {
    setTheirs(line.theirAmount === null ? '' : (line.theirAmount / 100).toFixed(2));
    setComment(line.comment);
    setLineError('');
  }, [line.theirAmount, line.comment]);

  return (
    <>
      <TableRow className={cn(line.needsWork && 'bg-red-50/30')}>
        <TableCell className="whitespace-nowrap px-2 py-2 text-slate-500">{formatDate(line.date, true)}</TableCell>
        <TableCell className="px-2 py-2">
          {line.documentId ? (
            <Link to={`/documents/${line.documentId}`} className="font-medium text-slate-900 hover:underline">
              {line.title}
            </Link>
          ) : (
            <span className="font-medium text-slate-900">{line.title}</span>
          )}
          {line.purpose && <div className="truncate text-xs text-slate-400">{line.purpose}</div>}
        </TableCell>
        <TableCell className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
          {line.accrued ? formatAmount(line.accrued) : <span className="text-slate-300">—</span>}
        </TableCell>
        <TableCell className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
          {line.paid ? formatAmount(line.paid) : <span className="text-slate-300">—</span>}
        </TableCell>
        <TableCell className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-slate-600">
          {line.theirAmount === null ? <span className="text-slate-300">не сверяли</span> : formatAmount(line.theirAmount)}
        </TableCell>
        <TableCell
          className={cn(
            'whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums',
            line.delta ? 'text-red-700' : 'text-slate-300'
          )}
        >
          {line.delta === null || line.delta === 0 ? '—' : formatAmount(line.delta)}
        </TableCell>
        <TableCell className="px-2 py-2">
          <button
            className="flex items-center gap-1.5 text-left"
            onClick={() => setOpen((v) => !v)}
            title="Подробнее"
          >
            <MatchChip match={line.match} resolved={line.resolved} />
          </button>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow>
          <TableCell colSpan={7} className="bg-slate-50 px-4 py-3">
            <div className="space-y-3">
              {line.hint && <p className="text-sm text-slate-600">{line.hint}</p>}
              {lineError && <p className="text-sm text-red-600">{lineError}</p>}
              {line.theirRaw && (
                <p className="font-mono text-xs text-slate-400">Из выписки: {line.theirRaw}</p>
              )}
              {line.comment && !editable && <p className="text-sm text-slate-700">{line.comment}</p>}

              {editable && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="space-y-1">
                    <span className="block text-xs font-medium text-slate-600">Сумма у контрагента</span>
                    <Input
                      className="w-40"
                      value={theirs}
                      onChange={(e) => setTheirs(e.target.value)}
                      placeholder="0,00"
                      inputMode="decimal"
                    />
                  </label>
                  <label className="flex-1 space-y-1">
                    <span className="block text-xs font-medium text-slate-600">Что решили</span>
                    <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Например: их накладная по другому договору" />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      // Пустое поле — это «стереть сумму контрагента», а вот
                      // неразобранный ввод стирать молча нельзя. Минус разрешён:
                      // у контрагента строка может быть корректировкой.
                      const minor = theirs.trim() ? parseMoney(theirs, { allowNegative: true }) : null;
                      if (theirs.trim() && minor === null) {
                        setLineError('Некорректная сумма');
                        return;
                      }
                      setLineError('');
                      onPatch({ theirAmount: minor, comment });
                    }}
                  >
                    Сохранить
                  </Button>
                  {line.needsWork && (
                    <Button
                      size="sm"
                      onClick={() => onResolve({ comment })}
                      // Крупное расхождение закрывает только главбух — это же
                      // правило стоит на сервере, здесь оно лишь видимое.
                      disabled={disabled || !canResolve}
                      title={canResolve ? undefined : 'Такое расхождение закрывает главный бухгалтер'}
                    >
                      Разобрано
                    </Button>
                  )}
                  {line.resolved && (
                    <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onResolve({ resolved: false })}>
                      Вернуть в работу
                    </Button>
                  )}
                  {line.kind === 'their' && (
                    <Button size="sm" variant="ghost" className="text-red-600" disabled={disabled} onClick={onDelete}>
                      Удалить строку
                    </Button>
                  )}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
