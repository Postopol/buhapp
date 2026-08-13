import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Calculator, KeyRound, Mail, Loader2 } from 'lucide-react';
import { ApiError } from '@/services/api';

const DEMO_ACCOUNTS = [
  { email: 'anna@company.kz', role: 'Бухгалтер, участок «Поставщики»' },
  { email: 'olga@company.kz', role: 'Главный бухгалтер' },
  { email: 'igor@company.kz', role: 'Инициатор, отдел закупок' },
  { email: 'marat@company.kz', role: 'Бухгалтер, участок «Банк и касса»' },
  { email: 'erlan@company.kz', role: 'Руководитель' },
];

export function Login() {
  const { login, isAuthenticated, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!authLoading && isAuthenticated) navigate('/', { replace: true });
  }, [authLoading, isAuthenticated, navigate]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключиться к серверу');
    } finally {
      setSubmitting(false);
    }
  };

  const fillDemo = (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword('pass123');
    setError('');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md border-slate-200 shadow-lg">
        <CardHeader className="space-y-1 pb-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-900">
            <Calculator className="h-6 w-6 text-white" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Бухгалтерия</CardTitle>
          <CardDescription>Документы, согласование и оплаты</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <Input
                type="email"
                placeholder="Рабочая почта"
                className="pl-9"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
              />
            </div>
            <div className="relative">
              <KeyRound className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <Input
                type="password"
                placeholder="Пароль"
                className="pl-9"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Войти
            </Button>
          </form>
        </CardContent>

        {/* Демо-аккаунты: убрать перед продом */}
        <CardFooter className="flex-col items-stretch space-y-2 border-t border-slate-100 pt-5">
          <p className="text-xs font-semibold text-slate-500">Демо-доступы (пароль pass123):</p>
          <div className="space-y-1">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                onClick={() => fillDemo(account.email)}
                className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-50"
              >
                <span className="font-mono text-slate-700">{account.email}</span>
                <span className="text-slate-400">{account.role}</span>
              </button>
            ))}
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
