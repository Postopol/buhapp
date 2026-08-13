import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, TrendingUp, Wallet, CheckCircle2, Lock, Loader2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { getKpis, getIfp, getAlerts } from '@/services/dashboard';
import type { Kpis, IfpItem, DashboardAlert } from '@/types';

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 }).format(value);
};

export function Dashboard() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [ifpData, setIfpData] = useState<IfpItem[]>([]);
  const [alerts, setAlerts] = useState<DashboardAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([getKpis(), getIfp(), getAlerts()])
      .then(([k, i, a]) => {
        if (cancelled) return;
        setKpis(k.kpis);
        setIfpData(i.ifp);
        setAlerts(a.alerts);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить данные');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Загрузка данных…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
        <p className="font-medium">Ошибка загрузки</p>
        <p className="text-sm mt-1">{error}</p>
      </div>
    );
  }

  const spentPercent = kpis && kpis.totalBudget > 0
    ? ((kpis.spent / kpis.totalBudget) * 100).toFixed(1)
    : '0.0';

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">Бюджетное планирование</h2>
        <p className="text-slate-500">Сводная информация по исполнению бюджета на текущий год.</p>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Общий бюджет</CardTitle>
            <Wallet className="h-4 w-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis ? formatCurrency(kpis.totalBudget) : '—'}</div>
            <p className="text-xs text-slate-500 mt-1">+12% к прошлому году</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Освоено (Касса)</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis ? formatCurrency(kpis.spent) : '—'}</div>
            <p className="text-xs text-slate-500 mt-1">
              {spentPercent}% от плана
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Остаток</CardTitle>
            <TrendingUp className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis ? formatCurrency(kpis.remaining) : '—'}</div>
            <p className="text-xs text-slate-500 mt-1">Доступно к распределению</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Заблокировано (Резерв)</CardTitle>
            <Lock className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis ? formatCurrency(kpis.blocked) : '—'}</div>
            <p className="text-xs text-slate-500 mt-1">По незакрытым договорам</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        {/* Chart */}
        <Card className="col-span-4 lg:col-span-5">
          <CardHeader>
            <CardTitle>Исполнение ИПФ по спецификам</CardTitle>
            <CardDescription>План против факта (в млн тенге)</CardDescription>
          </CardHeader>
          <CardContent className="pl-2">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ifpData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#64748b', fontSize: 12 }}
                    dy={10}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#64748b', fontSize: 12 }}
                    dx={-10}
                  />
                  <Tooltip
                    cursor={{ fill: '#f1f5f9' }}
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  />
                  <Legend wrapperStyle={{ paddingTop: '20px' }} />
                  <Bar dataKey="plan" name="План" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="fact" name="Факт (Освоено)" fill="#0f172a" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Alerts */}
        <Card className="col-span-4 lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-500" />
              Критические уведомления
            </CardTitle>
            <CardDescription>Риски неосвоения и блокировки</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {alerts.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">Нет уведомлений</p>
              ) : (
                alerts.map((alert) => (
                  <div key={alert.id} className="flex flex-col space-y-2 p-4 rounded-lg border border-slate-100 bg-slate-50/50">
                    <div className="flex items-center justify-between">
                      <Badge
                        variant={
                          alert.type === 'critical' ? 'destructive' :
                          alert.type === 'warning' ? 'warning' : 'secondary'
                        }
                      >
                        {alert.type === 'critical' ? 'Критично' :
                         alert.type === 'warning' ? 'Внимание' : 'Инфо'}
                      </Badge>
                      <span className="text-xs text-slate-500">{alert.date}</span>
                    </div>
                    <p className="text-sm text-slate-700 leading-relaxed">
                      {alert.message}
                    </p>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
