import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CheckCircle2, XCircle, RefreshCw, Server, FileText, Briefcase, Loader2, Search, type LucideIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { Integration, SyncLog } from '@/types';
import { getIntegrations, getLogs, syncOne, syncAll } from '@/services/integrations';

const INTEGRATION_ICONS: Record<string, LucideIcon> = {
  'e-qyzmet': Briefcase,
  'treasury': Server,
  'goszakup': FileText,
};

export function Integrations() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(true);
  const [error, setError] = useState('');

  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [syncAllLoading, setSyncAllLoading] = useState(false);

  const [logSearch, setLogSearch] = useState('');
  const [debouncedLogSearch, setDebouncedLogSearch] = useState('');
  const [logStatusFilter, setLogStatusFilter] = useState<string>('all');
  const [logSystemFilter, setLogSystemFilter] = useState<string>('all');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedLogSearch(logSearch), 300);
    return () => clearTimeout(t);
  }, [logSearch]);

  const loadIntegrations = useCallback(() => {
    getIntegrations()
      .then(({ integrations }) => setIntegrations(integrations))
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить интеграции'))
      .finally(() => setLoading(false));
  }, []);

  const loadLogs = useCallback(() => {
    setLogsLoading(true);
    getLogs(debouncedLogSearch, logSystemFilter, logStatusFilter)
      .then(({ logs }) => setLogs(logs))
      .catch(() => setLogs([]))
      .finally(() => setLogsLoading(false));
  }, [debouncedLogSearch, logSystemFilter, logStatusFilter]);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const handleSyncOne = async (id: string) => {
    setSyncingIds(prev => new Set(prev).add(id));
    try {
      const { integration } = await syncOne(id);
      setIntegrations(prev => prev.map(i => i.id === id ? integration : i));
      loadLogs();
    } catch {
      // ошибка сети — просто снимаем флаг
    } finally {
      setSyncingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleSyncAll = async () => {
    setSyncAllLoading(true);
    try {
      const { integrations: updated } = await syncAll();
      setIntegrations(updated);
      loadLogs();
    } catch {
      // игнорируем
    } finally {
      setSyncAllLoading(false);
    }
  };

  const isAnySyncing = syncingIds.size > 0 || syncAllLoading;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Интеграционный шлюз</h2>
          <p className="text-slate-500">Управление подключениями к внешним государственным системам.</p>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          onClick={handleSyncAll}
          disabled={isAnySyncing}
        >
          <RefreshCw className={`h-4 w-4 ${syncAllLoading ? 'animate-spin' : ''}`} />
          {syncAllLoading ? 'Синхронизация...' : 'Синхронизировать все'}
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 text-sm">
          {error}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12 text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Загрузка интеграций…
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {integrations.map((integration) => {
            const Icon = INTEGRATION_ICONS[integration.id] || Server;
            const isSyncing = syncingIds.has(integration.id) || syncAllLoading;
            const isError = integration.status === 'error';
            return (
              <Card key={integration.id} className="flex flex-col">
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <div className="space-y-1">
                    <CardTitle className="text-base font-semibold">{integration.name}</CardTitle>
                    <CardDescription className="text-xs">{integration.description}</CardDescription>
                  </div>
                  <div className="p-2 bg-slate-100 rounded-md">
                    <Icon className="h-5 w-5 text-slate-600" />
                  </div>
                </CardHeader>
                <CardContent className="flex-1 pt-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-500">Статус:</span>
                    {isSyncing ? (
                      <Badge variant="secondary" className="gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" /> Синхронизация...
                      </Badge>
                    ) : isError ? (
                      <Badge variant="destructive" className="gap-1">
                        <XCircle className="h-3 w-3" /> Ошибка связи
                      </Badge>
                    ) : (
                      <Badge variant="success" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Подключено
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    Последняя синхронизация: {integration.lastSync}
                  </div>
                </CardContent>
                <CardFooter className="border-t border-slate-100 pt-4">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full gap-2"
                    onClick={() => handleSyncOne(integration.id)}
                    disabled={isSyncing}
                  >
                    <RefreshCw className={`h-3 w-3 ${isSyncing ? 'animate-spin' : ''}`} />
                    {isSyncing ? 'Синхронизация...' : 'Принудительная синхронизация'}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Логи синхронизации</CardTitle>
          <CardDescription>История обмена данными с внешними системами.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Поиск по времени, системе, ошибке..."
                className="pl-9"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
              />
            </div>
            <select
              className="h-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
              value={logSystemFilter}
              onChange={(e) => setLogSystemFilter(e.target.value)}
            >
              <option value="all">Все системы</option>
              <option value="e-Qyzmet">e-Qyzmet</option>
              <option value={'Казначейство (ИС "Казначейство-клиент")'}>Казначейство</option>
              <option value="Государственные закупки (OAG)">Государственные закупки</option>
            </select>
            <select
              className="h-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
              value={logStatusFilter}
              onChange={(e) => setLogStatusFilter(e.target.value)}
            >
              <option value="all">Все статусы</option>
              <option value="success">Успешно</option>
              <option value="error">Ошибка</option>
            </select>
          </div>

          {logsLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Загрузка логов…
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Время</TableHead>
                  <TableHead>Система</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Ошибки</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-slate-400 py-8">
                      Ничего не найдено
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium text-slate-600">{log.time}</TableCell>
                      <TableCell>{log.system}</TableCell>
                      <TableCell>
                        {log.status === 'success' ? (
                          <Badge variant="success">Успешно</Badge>
                        ) : (
                          <Badge variant="destructive">Ошибка</Badge>
                        )}
                      </TableCell>
                      <TableCell className={log.error !== '-' ? 'text-red-500 text-xs' : 'text-slate-400'}>
                        {log.error}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
