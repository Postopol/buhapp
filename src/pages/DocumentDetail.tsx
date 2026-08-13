import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Loader2, Paperclip, Trash2, Download, Send, CheckCheck, Undo2, Ban,
  MessageSquare, History, Pencil, Building2, AlertTriangle, RotateCcw, Lock,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import {
  getDocument, transitionDocument, setOriginalStatus, setPostingStatus, addComment,
  uploadAttachment, deleteAttachment, attachmentUrl,
} from '@/services/documents';
import { getDictionaries } from '@/services/directory';
import { ApiError } from '@/services/api';
import {
  formatMoney, formatDate, formatDateTime, dueLabel, formatFileSize, formatPeriod,
} from '@/lib/format';
import { ApprovalChip, OriginalChip, PaymentChip, PostingChip, Chip } from '@/components/StatusChips';
import { DocumentFormModal } from '@/components/DocumentFormModal';
import {
  TRANSITIONS, DOC_TYPE_LABELS, SECTION_LABELS, ORIGINAL_STATUSES, ORIGINAL_LABELS,
  CHIEF_APPROVAL_THRESHOLD, MAX_ATTACHMENT_BYTES,
  type ApprovalStatus, type OriginalStatus,
} from '@shared/domain';
import { cn } from '@/lib/utils';
import type { Dictionaries, DocumentDetail as DocDetail } from '@/types';

const ACTION_ICONS: Record<ApprovalStatus, typeof Send> = {
  review: Send,
  approved: CheckCheck,
  returned: Undo2,
  rejected: Ban,
  draft: RotateCcw,
};

const HISTORY_LABELS: Record<string, string> = {
  created: 'Документ заведён',
  updated: 'Изменены реквизиты',
  approval: 'Смена статуса согласования',
  original: 'Смена статуса оригинала',
  posting: 'Смена статуса учёта',
  payment: 'Разнесена оплата',
  payment_deleted: 'Платёж удалён',
  attachment_added: 'Приложен файл',
  attachment_removed: 'Файл удалён',
};

export function DocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const documentId = Number(id);
  const navigate = useNavigate();
  const { role } = useAuth();

  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dictionaries, setDictionaries] = useState<Dictionaries | null>(null);
  const [showEdit, setShowEdit] = useState(false);

  const [pendingAction, setPendingAction] = useState<{ to: ApprovalStatus; label: string; requiresComment: boolean } | null>(null);
  const [actionComment, setActionComment] = useState('');

  const [commentDraft, setCommentDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    return getDocument(documentId)
      .then(({ document }) => setDoc(document))
      .catch((err) => setError(err instanceof Error ? err.message : 'Документ не найден'))
      .finally(() => setLoading(false));
  }, [documentId]);

  useEffect(() => {
    if (Number.isFinite(documentId)) load();
  }, [documentId, load]);

  useEffect(() => {
    getDictionaries().then(setDictionaries).catch(() => setDictionaries(null));
  }, []);

  if (loading && !doc) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Загрузка документа…
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-2" onClick={() => navigate('/documents')}>
          <ArrowLeft className="h-4 w-4" />
          К реестру
        </Button>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
          <p className="font-medium">{error || 'Документ не найден'}</p>
        </div>
      </div>
    );
  }

  // Закрытый период замораживает документ целиком: ни действий, ни правок.
  const frozen = doc.periodClosed;
  const available = frozen
    ? []
    : (TRANSITIONS[doc.approvalStatus] ?? []).filter((t) => role && t.roles.includes(role));
  const needsChief =
    doc.amount >= CHIEF_APPROVAL_THRESHOLD && role === 'accountant';
  const due = dueLabel(doc.dueDate);
  const outstanding = doc.amount - doc.paid;
  const canEdit =
    !frozen &&
    role !== 'director' &&
    !(doc.approvalStatus === 'approved' && role !== 'chief_accountant') &&
    !(doc.approvalStatus === 'review' && role === 'initiator');
  const isAccounting = !frozen && (role === 'accountant' || role === 'chief_accountant');

  const runTransition = async (to: ApprovalStatus, comment: string) => {
    setActionError('');
    setBusy(true);
    try {
      await transitionDocument(doc.id, to, comment);
      setPendingAction(null);
      setActionComment('');
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  };

  const changeOriginal = async (status: OriginalStatus) => {
    setActionError('');
    try {
      await setOriginalStatus(doc.id, status);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось изменить статус');
    }
  };

  const changePosting = async (status: 'posted' | 'not_posted') => {
    setActionError('');
    try {
      await setPostingStatus(doc.id, status);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось изменить статус');
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setActionError('');
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          throw new ApiError(413, `«${file.name}» больше ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} МБ`);
        }
        await uploadAttachment(doc.id, file);
      }
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleComment = async () => {
    if (!commentDraft.trim()) return;
    setBusy(true);
    try {
      await addComment(doc.id, commentDraft);
      setCommentDraft('');
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось отправить комментарий');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Шапка */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} title="Назад">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold tracking-tight text-slate-900">
                {DOC_TYPE_LABELS[doc.type]} {doc.number}
              </h2>
              {doc.overdue && (
                <Chip tone="bad">
                  <AlertTriangle className="h-3 w-3" />
                  Просрочен
                </Chip>
              )}
            </div>
            <p className="text-slate-500">
              от {formatDate(doc.docDate)} · период {formatPeriod(doc.period)} ·{' '}
              {SECTION_LABELS[doc.section]}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {canEdit && dictionaries && (
            <Button variant="outline" className="gap-2" onClick={() => setShowEdit(true)}>
              <Pencil className="h-4 w-4" />
              Изменить
            </Button>
          )}
          {available.map((t) => {
            const Icon = ACTION_ICONS[t.to];
            const blocked = t.to === 'approved' && needsChief;
            return (
              <Button
                key={t.to}
                variant={t.to === 'approved' ? 'default' : 'outline'}
                className="gap-2"
                disabled={busy || blocked}
                title={blocked ? `Сумма от ${formatMoney(CHIEF_APPROVAL_THRESHOLD)} — согласовывает главбух` : undefined}
                onClick={() => {
                  if (t.requiresComment) {
                    setPendingAction({ to: t.to, label: t.label, requiresComment: true });
                  } else {
                    runTransition(t.to, '');
                  }
                }}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </Button>
            );
          })}
        </div>
      </div>

      {frozen && (
        <div className="flex items-center gap-3 rounded-lg border border-slate-300 bg-slate-100 px-4 py-3 text-sm text-slate-700">
          <Lock className="h-4 w-4 shrink-0 text-slate-500" />
          <span>
            Период {formatPeriod(doc.period)} закрыт — документ заморожен. Чтобы внести изменения,
            главный бухгалтер должен открыть период заново.
          </span>
        </div>
      )}

      {needsChief && doc.approvalStatus === 'review' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Сумма документа — {formatMoney(doc.amount)}. Согласование от {formatMoney(CHIEF_APPROVAL_THRESHOLD)} проводит
          главный бухгалтер.
        </div>
      )}

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</div>
      )}

      {/* Четыре независимых статуса */}
      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatusCell label="Согласование">
            <ApprovalChip status={doc.approvalStatus} />
          </StatusCell>

          <StatusCell label="Оригинал">
            {isAccounting ? (
              <select
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
                value={doc.originalStatus}
                onChange={(e) => changeOriginal(e.target.value as OriginalStatus)}
              >
                {ORIGINAL_STATUSES.map((s) => (
                  <option key={s} value={s}>{ORIGINAL_LABELS[s]}</option>
                ))}
              </select>
            ) : (
              <OriginalChip status={doc.originalStatus} />
            )}
          </StatusCell>

          <StatusCell label="Оплата">
            <div className="space-y-1">
              <PaymentChip state={doc.paymentState} />
              {outstanding > 0 && doc.paid > 0 && (
                <div className="text-xs text-slate-500">осталось {formatMoney(outstanding)}</div>
              )}
            </div>
          </StatusCell>

          <StatusCell label="Учёт">
            {isAccounting ? (
              <Button
                size="sm"
                variant={doc.postingStatus === 'posted' ? 'secondary' : 'outline'}
                onClick={() => changePosting(doc.postingStatus === 'posted' ? 'not_posted' : 'posted')}
              >
                {doc.postingStatus === 'posted' ? 'Проведён — отменить' : 'Отметить проведённым'}
              </Button>
            ) : (
              <PostingChip status={doc.postingStatus} />
            )}
          </StatusCell>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* Реквизиты */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Реквизиты</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Detail label="Контрагент">
                {doc.counterpartyId ? (
                  <Link
                    to={`/counterparties/${doc.counterpartyId}`}
                    className="inline-flex items-center gap-1.5 font-medium text-slate-900 hover:underline"
                  >
                    <Building2 className="h-4 w-4 text-slate-400" />
                    {doc.counterpartyName}
                  </Link>
                ) : (
                  <span className="text-slate-400">не указан</span>
                )}
                {doc.counterpartyBin && <div className="text-xs text-slate-400">БИН {doc.counterpartyBin}</div>}
              </Detail>

              <Detail label="Договор">
                {doc.contractNumber ?? <span className="text-slate-400">без договора</span>}
              </Detail>

              <Detail label="Сумма">
                <span className="text-xl font-bold text-slate-900">{formatMoney(doc.amount)}</span>
                <div className="text-xs text-slate-500">
                  {doc.vat > 0 ? `в т.ч. НДС ${formatMoney(doc.vat)}` : 'без НДС'}
                </div>
              </Detail>

              <Detail label="Срок оплаты">
                {doc.dueDate ? (
                  <>
                    <span className={cn('font-medium', due?.overdue ? 'text-red-600' : 'text-slate-900')}>
                      {formatDate(doc.dueDate)}
                    </span>
                    {due && (
                      <div className={cn('text-xs', due.overdue ? 'text-red-500' : 'text-slate-500')}>{due.text}</div>
                    )}
                  </>
                ) : (
                  <span className="text-slate-400">не задан</span>
                )}
              </Detail>

              <Detail label="Статья расходов">
                {doc.expenseItemName ?? <span className="text-slate-400">не указана</span>}
              </Detail>

              <Detail label="Ответственный">
                {doc.responsibleName ?? <span className="text-slate-400">не назначен</span>}
                <div className="text-xs text-slate-400">Завёл: {doc.createdByName ?? '—'}</div>
              </Detail>

              {doc.purpose && (
                <div className="sm:col-span-2">
                  <div className="text-sm font-medium text-slate-500">Назначение платежа</div>
                  <p className="mt-1 rounded-md bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-700">
                    {doc.purpose}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Вложения */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <div>
                <CardTitle className="text-base">Вложения</CardTitle>
                <CardDescription>Сканы счетов, актов и договоров</CardDescription>
              </div>
              <div>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => handleUpload(e.target.files)}
                  accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx"
                />
                <Button variant="outline" size="sm" className="gap-2" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                  Приложить
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {doc.attachments.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400">
                  Файлов нет. Без скана документ не согласуют.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {doc.attachments.map((file) => (
                    <div key={file.id} className="flex items-center gap-3 py-2.5">
                      <Paperclip className="h-4 w-4 shrink-0 text-slate-300" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-900">{file.filename}</div>
                        <div className="text-xs text-slate-400">
                          {formatFileSize(file.size)} · {file.uploadedByName} · {formatDateTime(file.uploadedAt)}
                        </div>
                      </div>
                      <a href={attachmentUrl(file.id)} target="_blank" rel="noreferrer">
                        <Button variant="ghost" size="sm" className="gap-1.5">
                          <Download className="h-4 w-4" />
                          Скачать
                        </Button>
                      </a>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-slate-400 hover:text-red-600"
                        onClick={async () => {
                          await deleteAttachment(file.id);
                          load();
                        }}
                        title="Удалить"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Оплаты */}
          {doc.payments.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Оплаты</CardTitle>
                <CardDescription>
                  Разнесено {formatMoney(doc.paid)} из {formatMoney(doc.amount)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-slate-100">
                  {doc.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <div>
                        <div className="font-medium text-slate-900">{p.reference || 'Платёж'}</div>
                        <div className="text-xs text-slate-400">
                          {formatDate(p.paymentDate)} · {p.bankAccount || 'счёт не указан'}
                        </div>
                      </div>
                      <span className="font-medium tabular-nums text-slate-900">{formatMoney(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Правая колонка: обсуждение и история */}
        <div className="space-y-5">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="h-4 w-4 text-slate-400" />
                Обсуждение
              </CardTitle>
              <CardDescription>Здесь, а не в мессенджере</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {doc.comments.length === 0 ? (
                <p className="py-3 text-center text-sm text-slate-400">Пока тихо</p>
              ) : (
                <div className="space-y-3">
                  {doc.comments.map((c) => (
                    <div
                      key={c.id}
                      className={cn(
                        'rounded-lg border px-3 py-2',
                        c.kind === 'return_reason'
                          ? 'border-red-200 bg-red-50'
                          : 'border-slate-200 bg-slate-50'
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-700">{c.userName}</span>
                        <span className="text-xs text-slate-400">{formatDateTime(c.createdAt)}</span>
                      </div>
                      {c.kind === 'return_reason' && (
                        <div className="mt-1 text-xs font-medium text-red-600">Причина возврата</div>
                      )}
                      <p className="mt-1 text-sm leading-relaxed text-slate-700">{c.body}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2 border-t border-slate-100 pt-3">
                <textarea
                  className="min-h-[70px] w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
                  placeholder="Написать комментарий…"
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                />
                <Button size="sm" className="w-full" disabled={busy || !commentDraft.trim()} onClick={handleComment}>
                  Отправить
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4 text-slate-400" />
                История
              </CardTitle>
              <CardDescription>Кто и что сделал с документом</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {doc.history.map((h) => (
                  <div key={h.id} className="flex gap-3 text-sm">
                    <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                    <div className="min-w-0">
                      <div className="text-slate-800">{HISTORY_LABELS[h.action] ?? h.action}</div>
                      <div className="text-xs text-slate-400">
                        {h.userName} · {formatDateTime(h.createdAt)}
                      </div>
                      {typeof h.details?.comment === 'string' && (
                        <div className="mt-0.5 text-xs italic text-slate-500">«{h.details.comment}»</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Модалка действия с обязательной причиной */}
      {pendingAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-900">{pendingAction.label}</h3>
            <p className="mt-1 text-sm text-slate-500">
              Причина попадёт в карточку документа и увидится инициатору.
            </p>
            <textarea
              className="mt-4 min-h-[100px] w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950"
              placeholder="Например: нет договора и акта — приложите документы"
              value={actionComment}
              onChange={(e) => setActionComment(e.target.value)}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setPendingAction(null); setActionComment(''); }}>
                Отмена
              </Button>
              <Button
                disabled={busy || !actionComment.trim()}
                onClick={() => runTransition(pendingAction.to, actionComment)}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {pendingAction.label}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showEdit && dictionaries && (
        <DocumentFormModal
          dictionaries={dictionaries}
          document={doc}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function StatusCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-medium text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm text-slate-900">{children}</div>
    </div>
  );
}
