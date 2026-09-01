import { AlertTriangle } from 'lucide-react';
import { formatMoney, plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ReconciliationDetail as ActDetail } from '@/types';

/** Всё, что бухгалтер должен знать про цифры акта до того, как отправит его
 *  контрагенту: дрейф снимка, несогласованные документы, отсечённые суммы. */
export function Warnings({ act }: { act: ActDetail }) {
  const w = act.warnings;
  const items: { text: string; tone: 'amber' | 'red' }[] = [];

  if (act.drift.changed) {
    items.push({
      tone: 'red',
      text: `Данные изменились после формирования: в снимке ${formatMoney(act.closing)}, сейчас ${formatMoney(act.drift.closingNow)}. Акт показывает то, что ушло контрагенту.`,
    });
  }
  if (!act.final) {
    items.push({
      tone: 'amber',
      text: 'Не все месяцы периода закрыты — цифры под актом ещё могут измениться.',
    });
  }
  if (w.unapprovedCount > 0) {
    items.push({
      tone: 'amber',
      text: `В акт вошло ${plural(w.unapprovedCount, 'несогласованный документ', 'несогласованных документа', 'несогласованных документов')} на ${formatMoney(w.unapproved)}.`,
    });
  }
  if (w.unallocated > 0) {
    items.push({
      tone: 'amber',
      text: `Есть неразнесённый остаток платежей на ${formatMoney(w.unallocated)} — похоже на аванс, в сальдо он не вошёл.`,
    });
  }
  if (w.excludedCount > 0) {
    items.push({
      tone: 'amber',
      text: `Отклонённые документы в акт не вошли: ${w.excludedCount} на ${formatMoney(w.excluded)}.`,
    });
  }
  if (w.excludedPaidCount > 0) {
    // Отдельная строка, а не слагаемое к предыдущей: оплаты отсекаются по
    // дате платежа, поэтому попадают в другой период, чем сам документ.
    items.push({
      tone: 'amber',
      text: `Оплаты по отклонённым документам в акт не вошли: ${w.excludedPaidCount} на ${formatMoney(w.excludedPaid)}. Деньги со счёта ушли, и контрагент их у себя покажет.`,
    });
  }
  for (const dup of w.duplicates) {
    items.push({
      tone: 'amber',
      text: `Счёт и акт на одну сумму ${formatMoney(dup.amount)} — ${dup.numbers}. Похоже на двойной счёт одной услуги.`,
    });
  }

  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
          className={cn(
            'flex items-start gap-2 rounded-lg border px-4 py-3 text-sm',
            item.tone === 'red' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'
          )}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}
