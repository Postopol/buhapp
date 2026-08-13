import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Eye, CheckCircle, Clock, FileEdit, Send, ArrowLeft, X, Search, Loader2, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import type { Role, RequestStatus, PaymentRequest } from '@/types';
import { getRequests, getRequest, createRequest, advanceRequest } from '@/services/requests';
import { ApiError } from '@/services/api';

const STATUS_ACTIONS: Partial<Record<RequestStatus, { label: string; icon: LucideIcon; roles: Role[] }>> = {
  draft: { label: 'Отправить на проверку', icon: Send, roles: ['accountant'] },
  finance_check: { label: 'Согласовать', icon: CheckCircle, roles: ['accountant'] },
  chief_signature: { label: 'Подписать ЭЦП', icon: FileEdit, roles: ['chief_accountant'] },
  ready_treasury: { label: 'Отправить в Казначейство', icon: Send, roles: ['chief_accountant'] },
};

const EXPENSE_ITEMS = [
  '111 (Оплата труда)',
  '112 (Доп. выплаты)',
  '121 (Налоги)',
  '149 (Прочие услуги)',
  '159 (Прочие товары)',
  '414 (Оборудование)',
];

const statusMap: Record<RequestStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" }> = {
  draft: { label: 'Черновик', variant: 'secondary' },
  finance_check: { label: 'На проверке финотдела', variant: 'warning' },
  chief_signature: { label: 'На подписи Главбуха', variant: 'outline' },
  ready_treasury: { label: 'Готово к отправке в Казначейство', variant: 'success' },
  done: { label: 'Отправлено в Казначейство', variant: 'success' },
};

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 }).format(value);
};

export function Workflow() {
  const { role } = useAuth();
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaymentRequest | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [actionError, setActionError] = useState('');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formData, setFormData] = useState({ initiator: '', expenseItem: EXPENSE_ITEMS[0], amount: '' });
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<RequestStatus | 'all'>('all');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const loadList = useCallback(() => {
    setListLoading(true);
    setListError('');
    getRequests(debouncedSearch, statusFilter)
      .then(({ requests }) => setRequests(requests))
      .catch((err) => setListError(err instanceof Error ? err.message : 'Не удалось загрузить заявки'))
      .finally(() => setListLoading(false));
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadDetail = useCallback((id: string) => {
    setDetailLoading(true);
    getRequest(id)
      .then(({ request }) => setDetail(request))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, []);

  const handleView = (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setActionError('');
    loadDetail(id);
  };

  const handleBack = () => {
    setSelectedId(null);
    setDetail(null);
    setActionError('');
  };

  const handleAdvance = async (id: string) => {
    setActionError('');
    setAdvancing(true);
    try {
      const { request: updated } = await advanceRequest(id);
      setDetail(updated);
      setRequests(prev => prev.map(r => r.id === id ? { ...r, status: updated.status } : r));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
    } finally {
      setAdvancing(false);
    }
  };

  const openCreateModal = () => {
    setFormData({ initiator: '', expenseItem: EXPENSE_ITEMS[0], amount: '' });
    setFormError('');
    setShowCreateModal(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const amount = parseInt(formData.amount, 10);
    if (!formData.initiator.trim()) {
      setFormError('Укажите инициатора заявки');
      return;
    }
    if (!amount || amount <= 0) {
      setFormError('Сумма должна быть положительным числом');
      return;
    }
    setCreating(true);
    try {
      const { request: created } = await createRequest({
        initiator: formData.initiator.trim(),
        expenseItem: formData.expenseItem,
        amount,
      });
      setRequests(prev => [created, ...prev]);
      setShowCreateModal(false);
      handleView(created.id);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Не удалось создать заявку');
    } finally {
      setCreating(false);
    }
  };

  if (selectedId) {
    const request = detail;
    const action = request ? STATUS_ACTIONS[request.status] : undefined;
    const canAct = !!(action && role && action.roles.includes(role));

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={handleBack}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-slate-900">Заявка {selectedId}</h2>
              <p className="text-slate-500">Детальная информация и история согласования</p>
            </div>
          </div>
          <div className="flex gap-2">
            {canAct && action && (
              <Button className="gap-2" onClick={() => handleAdvance(selectedId)} disabled={advancing}>
                {advancing ? <Loader2 className="h-4 w-4 animate-spin" /> : <action.icon className="h-4 w-4" />}
                {action.label}
              </Button>
            )}
            {request?.status === 'done' && (
              <Badge variant="success" className="text-sm px-3 py-1.5 gap-1">
                <CheckCircle className="h-4 w-4" /> Заявка отправлена в Казначейство
              </Badge>
            )}
          </div>
        </div>

        {actionError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 text-sm">
            {actionError}
          </div>
        )}

        {detailLoading ? (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Загрузка заявки…
          </div>
        ) : !request ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
            <p className="font-medium">Заявка не найдена</p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>Детали заявки</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-slate-500">Инициатор</p>
                    <p className="text-base font-semibold text-slate-900">{request.initiator}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-500">Статья расходов</p>
                    <p className="text-base font-semibold text-slate-900">{request.expenseItem}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-500">Сумма к оплате</p>
                    <p className="text-xl font-bold text-slate-900">{formatCurrency(request.amount)}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-500">Текущий статус</p>
                    <Badge variant={statusMap[request.status].variant} className="mt-1">
                      {statusMap[request.status].label}
                    </Badge>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-100">
                  <p className="text-sm font-medium text-slate-500 mb-2">Прикрепленные документы</p>
                  <div className="flex items-center gap-2 p-3 border border-slate-200 rounded-md bg-slate-50">
                    <FileEdit className="h-5 w-5 text-slate-400" />
                    <span className="text-sm font-medium text-slate-700">Счет_на_оплату_№45.pdf</span>
                    <Button variant="link" size="sm" className="ml-auto">Скачать</Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>История согласования</CardTitle>
                <CardDescription>Таймлайн движения документа</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {(request.timeline ?? []).map((item, index, arr) => (
                    <div key={item.id} className="relative flex gap-4">
                      {index !== arr.length - 1 && (
                        <div className="absolute left-3 top-8 bottom-[-24px] w-px bg-slate-200" />
                      )}

                      <div className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white border-2 border-slate-200">
                        {item.status === 'completed' ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <Clock className="h-4 w-4 text-slate-400" />
                        )}
                      </div>

                      <div className="flex flex-col pb-2">
                        <span className={`text-sm font-semibold ${item.status === 'completed' ? 'text-slate-900' : 'text-slate-500'}`}>
                          {item.action}
                        </span>
                        <span className="text-xs text-slate-500 mt-1">{item.user}</span>
                        <span className="text-xs text-slate-400 mt-0.5">{item.date}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Заявки на оплату</h2>
          <p className="text-slate-500">Управление документами и маршрутами согласования.</p>
        </div>
        {role === 'accountant' && (
          <Button className="gap-2" onClick={openCreateModal}>
            <FileEdit className="h-4 w-4" />
            Создать заявку
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Список заявок</CardTitle>
          <CardDescription>Все заявки, требующие вашего внимания или находящиеся в работе.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Поиск по ID, инициатору, статье..."
                className="pl-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <select
              className="h-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as RequestStatus | 'all')}
            >
              <option value="all">Все статусы</option>
              <option value="draft">Черновик</option>
              <option value="finance_check">На проверке финотдела</option>
              <option value="chief_signature">На подписи Главбуха</option>
              <option value="ready_treasury">Готово к Казначейству</option>
              <option value="done">Отправлено в Казначейство</option>
            </select>
          </div>

          {listError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 text-sm">
              {listError}
            </div>
          ) : listLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Загрузка заявок…
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Инициатор</TableHead>
                  <TableHead>Статья расходов</TableHead>
                  <TableHead className="text-right">Сумма</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-slate-400 py-8">
                      Ничего не найдено
                    </TableCell>
                  </TableRow>
                ) : (
                  requests.map((request) => (
                    <TableRow key={request.id}>
                      <TableCell className="font-medium text-slate-900">{request.id}</TableCell>
                      <TableCell className="text-slate-500">{request.date}</TableCell>
                      <TableCell>{request.initiator}</TableCell>
                      <TableCell>{request.expenseItem}</TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(request.amount)}</TableCell>
                      <TableCell>
                        <Badge variant={statusMap[request.status].variant}>
                          {statusMap[request.status].label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => handleView(request.id)}>
                          <Eye className="h-4 w-4 mr-2" />
                          Просмотр
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h3 className="text-lg font-semibold text-slate-900">Новая заявка на оплату</h3>
              <Button variant="ghost" size="icon" onClick={() => setShowCreateModal(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4 px-6 py-5">
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">Инициатор (отдел)</label>
                <Input
                  placeholder="Например: IT Отдел"
                  value={formData.initiator}
                  onChange={(e) => setFormData(prev => ({ ...prev, initiator: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">Статья расходов</label>
                <select
                  className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm ring-offset-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
                  value={formData.expenseItem}
                  onChange={(e) => setFormData(prev => ({ ...prev, expenseItem: e.target.value }))}
                >
                  {EXPENSE_ITEMS.map(item => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">Сумма (тенге)</label>
                <Input
                  type="number"
                  min="1"
                  placeholder="Введите сумму"
                  value={formData.amount}
                  onChange={(e) => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                  required
                />
              </div>
              {formError && (
                <p className="text-sm text-red-500">{formError}</p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setShowCreateModal(false)}>
                  Отмена
                </Button>
                <Button type="submit" disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Создание…
                    </>
                  ) : (
                    'Создать заявку'
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
