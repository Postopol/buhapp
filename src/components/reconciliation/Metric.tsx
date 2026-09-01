import { cn } from '@/lib/utils';

/** Плитка сальдо/оборота в шапке акта. */
export function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('rounded-xl border p-4', strong ? 'border-slate-900 bg-white' : 'border-slate-200 bg-white')}>
      <div className="text-sm font-medium text-slate-600">{label}</div>
      <div className="mt-1.5 text-xl font-bold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
