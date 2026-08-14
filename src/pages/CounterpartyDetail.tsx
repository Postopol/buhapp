import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, Loader2, AlertTriangle, FileText, Scale } from 'lucide-react';
import { getCounterparty } from '@/services/directory';
import { listDocuments } from '@/services/documents';
import { formatMoney, formatMoneyShort, formatDate, formatAmount } from '@/lib/format';
import { ApprovalChip, OriginalChip, PaymentChip, Chip } from '@/components/StatusChips';
import { DOC_TYPE_SHORT } from '@shared/domain';
import type { CounterpartyDetail as CpDetail, Document } from '@/types';

export function CounterpartyDetail() {
  const { id } = useParams<{ id: string }>();
  const counterpartyId = Number(id);
  const navigate = useNavigate();

  const [cp, setCp] = useState<CpDetail | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getCounterparty(counterpartyId),
      listDocuments({ counterparty: String(counterpartyId), limit: 100 }),
    ])
      .then(([cpRes, docsRes]) => {
        if (cancelled) return;
        setCp(cpRes.counterparty);
        setDocuments(docsRes.documents);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Контрагент не найден');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [counterpartyId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Загрузка…
      </div>
    );
  }

  if (error || !cp) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-2" onClick={() => navigate('/counterparties')}>
          <ArrowLeft className="h-4 w-4" />
          К списку
        </Button>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
          {error || 'Контрагент не найден'}
        </div>
      </div>
    );
  }

  const missingOriginals = documents.filter((d) => d.originalStatus === 'none' && d.approvalStatus !== 'rejected');

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/counterparties')} title="Назад">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">{cp.name}</h2>
            {!cp.isVatPayer && <Chip tone="neutral">без НДС</Chip>}
          </div>
          <p className="font-mono text-sm text-slate-500">БИН/ИИН {cp.bin}</p>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => navigate(`/reconciliations?counterparty=${cp.id}`)}
        >
          <Scale className="h-4 w-4" />
          Акты сверки
        </Button>
      </div>

      {/* Сальдо — то, ради чего эту карточку открывают */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Начислено" value={formatMoneyShort(cp.accrued)} hint="По всем непогашенным документам" />
        <Metric label="Оплачено" value={formatMoneyShort(cp.paid)} hint="Деньги, которые ушли" />
        <Metric
          label="Долг"
          value={formatMoneyShort(cp.debt)}
          hint={cp.debt > 0 ? 'Мы должны контрагенту' : 'Расчёты закрыты'}
          tone={cp.debt > 0 ? 'attention' : 'normal'}
        />
        <Metric
          label="Без оригинала"
          value={String(cp.missingOriginals)}
          hint="Документы, по которым нет бумаги"
          tone={cp.missingOriginals > 0 ? 'urgent' : 'normal'}
        />
      </div>

      {missingOriginals.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
            <AlertTriangle className="h-4 w-4" />
            Не хватает оригиналов на {formatMoney(missingOriginals.reduce((s, d) => s + d.amount, 0))}
          </div>
          <p className="mt-1 text-sm text-amber-800">
            {missingOriginals.map((d) => `${DOC_TYPE_SHORT[d.type]} ${d.number}`).join(', ')}
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Реквизиты</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Field label="Банк" value={cp.bankName || '—'} />
            <Field label="БИК" value={cp.bankBic || '—'} mono />
            <Field label="IBAN" value={cp.iban || '—'} mono />
            <Field label="Ответственный" value={cp.responsibleName ?? '—'} />
            {cp.note && (
              <div className="rounded-md bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-600">{cp.note}</div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Договоры</CardTitle>
            <CardDescription>Действующие и истёкшие</CardDescription>
          </CardHeader>
          <CardContent>
            {cp.contracts.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">Договоров нет</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {cp.contracts.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 py-2.5">
                    <FileText className="h-4 w-4 shrink-0 text-slate-300" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900">№ {c.number}</div>
                      <div className="truncate text-xs text-slate-500">{c.subject}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm tabular-nums text-slate-700">{formatMoneyShort(c.amount)}</div>
                      <div className="text-xs text-slate-400">
                        до {formatDate(c.validUntil)}
                      </div>
                    </div>
                    {c.expired && <Chip tone="bad">истёк</Chip>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Документы</CardTitle>
          <CardDescription>Вся история работы с контрагентом</CardDescription>
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">Документов нет</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-2">Дата</TableHead>
                  <TableHead className="px-2">Документ</TableHead>
                  <TableHead className="px-2 text-right">Сумма</TableHead>
                  <TableHead className="px-2">Статья</TableHead>
                  <TableHead className="px-2">Статусы</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((doc) => (
                  <TableRow key={doc.id} className="cursor-pointer">
                    <TableCell className="whitespace-nowrap px-2 py-2 text-slate-500">
                      <Link to={`/documents/${doc.id}`} className="block">{formatDate(doc.docDate)}</Link>
                    </TableCell>
                    <TableCell className="px-2 py-2">
                      <Link to={`/documents/${doc.id}`} className="block">
                        <div className="font-medium text-slate-900">{doc.number}</div>
                        <div className="text-xs text-slate-400">{DOC_TYPE_SHORT[doc.type]}</div>
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap px-2 py-2 text-right font-medium tabular-nums">
                      <Link to={`/documents/${doc.id}`} className="block">{formatAmount(doc.amount)}</Link>
                    </TableCell>
                    <TableCell className="px-2 py-2 text-xs text-slate-500">
                      <Link to={`/documents/${doc.id}`} className="block">{doc.expenseItemName ?? '—'}</Link>
                    </TableCell>
                    <TableCell className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        <ApprovalChip status={doc.approvalStatus} />
                        <OriginalChip status={doc.originalStatus} />
                        <PaymentChip state={doc.paymentState} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone = 'normal',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'normal' | 'attention' | 'urgent';
}) {
  const border =
    tone === 'urgent' ? 'border-red-200 bg-red-50/40' : tone === 'attention' ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-white';
  const color = tone === 'urgent' ? 'text-red-700' : tone === 'attention' ? 'text-amber-700' : 'text-slate-900';
  return (
    <div className={`rounded-xl border p-4 ${border}`}>
      <div className="text-sm font-medium text-slate-600">{label}</div>
      <div className={`mt-1.5 text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="mt-1 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={`text-right text-slate-900 ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}
