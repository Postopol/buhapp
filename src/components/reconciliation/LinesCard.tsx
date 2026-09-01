import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Clipboard } from 'lucide-react';
import { LineRow } from './LineRow';
import type { ReconciliationDetail as ActDetail } from '@/types';

/** Обороты за период: таблица строк, фильтр «только расхождения» и вход в
 *  оба способа добавить данные контрагента. */
export function LinesCard({
  act,
  editable,
  disabled,
  onImportClick,
  onAddClick,
  onPatchLine,
  onResolveLine,
  onDeleteLine,
}: {
  act: ActDetail;
  editable: boolean;
  disabled: boolean;
  onImportClick: () => void;
  onAddClick: () => void;
  onPatchLine: (lineId: number, data: { theirAmount?: number | null; comment?: string }) => void;
  onResolveLine: (lineId: number, data: { comment?: string; resolved?: boolean }) => void;
  onDeleteLine: (lineId: number) => void;
}) {
  const [onlyDiff, setOnlyDiff] = useState(false);

  const unresolved = act.warnings.unresolved;
  // Когда разобрана последняя строка, фильтр «только расхождения» оставил бы
  // пустую таблицу, а кнопка возврата к тому моменту уже исчезла.
  const showOnlyDiff = onlyDiff && unresolved > 0;
  const visible = showOnlyDiff ? act.lines.filter((l) => l.needsWork) : act.lines;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">Обороты за период</CardTitle>
          <CardDescription>{act.basis}</CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {unresolved > 0 && (
            <Button
              variant={showOnlyDiff ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setOnlyDiff((v) => !v)}
            >
              {showOnlyDiff ? 'Показать все' : `Только расхождения (${unresolved})`}
            </Button>
          )}
          {editable && (
            <>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onImportClick}>
                <Clipboard className="h-3.5 w-3.5" />
                Вставить выписку
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={onAddClick}>
                <Plus className="h-3.5 w-3.5" />
                Строка контрагента
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-400">
            {showOnlyDiff ? 'Расхождений не осталось' : 'За период движений не было'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-2">Дата</TableHead>
                <TableHead className="px-2">Документ</TableHead>
                <TableHead className="px-2 text-right">Начислено</TableHead>
                <TableHead className="px-2 text-right">Оплачено</TableHead>
                <TableHead className="px-2 text-right">У контрагента</TableHead>
                <TableHead className="px-2 text-right">Δ</TableHead>
                <TableHead className="px-2">Диагноз</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((line) => (
                <LineRow
                  key={line.id}
                  line={line}
                  editable={editable}
                  disabled={disabled}
                  canResolve={
                    act.permissions.isChief ||
                    Math.abs(line.delta ?? line.ourAmount - (line.theirAmount ?? 0)) <
                      act.permissions.resolveThreshold
                  }
                  onPatch={(data) => onPatchLine(line.id, data)}
                  onResolve={(data) => onResolveLine(line.id, data)}
                  onDelete={() => onDeleteLine(line.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
