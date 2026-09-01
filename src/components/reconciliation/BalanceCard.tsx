import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, X } from 'lucide-react';
import { formatMoney, parseMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ReconciliationDetail as ActDetail } from '@/types';

/** Сальдо со слов контрагента рядом с расхождением: одно без другого не читается. */
export function BalanceCard({
  act,
  editable,
  disabled,
  onSave,
}: {
  act: ActDetail;
  editable: boolean;
  disabled: boolean;
  onSave: (value: number | null) => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-end justify-between gap-4 p-4">
        <TheirBalance act={act} editable={editable} disabled={disabled} onSave={onSave} />
        <div className="text-right">
          <div className="text-sm text-slate-500">Расхождение</div>
          <div
            className={cn(
              'text-2xl font-bold tabular-nums',
              act.diff === null ? 'text-slate-300' : act.diff === 0 ? 'text-emerald-600' : 'text-red-700'
            )}
          >
            {act.diff === null ? '—' : act.diff === 0 ? 'сходится' : formatMoney(act.diff)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Сальдо со слов контрагента. Подписано словами, а не «дебет/кредит»:
 *  у контрагента это зеркальная дебиторка, и знак путают постоянно. */
function TheirBalance({
  act,
  editable,
  disabled,
  onSave,
}: {
  act: ActDetail;
  editable: boolean;
  disabled: boolean;
  onSave: (value: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(act.theirClosing === null ? '' : (act.theirClosing / 100).toFixed(2));
  const [error, setError] = useState('');

  if (!editing) {
    return (
      <div>
        <div className="text-sm text-slate-500">Сколько мы должны по данным контрагента</div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-2xl font-bold tabular-nums text-slate-900">
            {act.theirClosing === null ? 'ответа нет' : formatMoney(act.theirClosing)}
          </span>
          {editable && (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditing(true)}>
              Внести
            </Button>
          )}
        </div>
      </div>
    );
  }

  const submit = () => {
    if (!value.trim()) {
      onSave(null);
      setEditing(false);
      return;
    }
    // Минус здесь законен: контрагент отвечает «это вы нам переплатили», и
    // такое сальдо надо внести как есть, иначе расхождение не закрыть.
    const minor = parseMoney(value, { allowNegative: true });
    if (minor === null) {
      setError('Некорректная сумма');
      return;
    }
    onSave(minor);
    setEditing(false);
  };

  return (
    <div className="space-y-1.5">
      <span className="text-sm text-slate-500">Сколько мы должны по данным контрагента</span>
      <div className="flex items-center gap-2">
        <Input
          className="w-44"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0,00"
          inputMode="decimal"
          autoFocus
        />
        <Button size="sm" disabled={disabled} onClick={submit}>
          <Check className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <p className="text-xs text-slate-400">Переплата в нашу пользу — со знаком минус</p>
    </div>
  );
}
