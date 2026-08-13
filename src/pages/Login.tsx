import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Shield, KeyRound, User, Loader2 } from 'lucide-react';
import { ApiError } from '@/services/api';

export function Login() {
  const { login, isAuthenticated, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [iin, setIin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(iin.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Не удалось подключиться к серверу');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md shadow-lg border-slate-200">
        <CardHeader className="space-y-1 text-center pb-8">
          <div className="mx-auto bg-slate-100 w-12 h-12 rounded-full flex items-center justify-center mb-4">
            <Shield className="h-6 w-6 text-slate-700" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Вход в систему</CardTitle>
          <CardDescription>
            Портал автоматизации бухгалтерии
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <div className="relative">
                <User className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="ИИН / Логин"
                  className="pl-9"
                  value={iin}
                  onChange={(e) => setIin(e.target.value)}
                  required
                  autoComplete="username"
                />
              </div>
            </div>
            <div className="space-y-2">
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
            </div>
            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Вход…
                </>
              ) : (
                'Войти по паролю'
              )}
            </Button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-2 text-slate-500">
                Опции входа
              </span>
            </div>
          </div>

          <Button variant="outline" className="w-full bg-slate-50 hover:bg-slate-100" disabled={submitting}>
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Войти через ЭЦП (NCALayer)
          </Button>
        </CardContent>
        <CardFooter className="flex flex-col space-y-4 border-t border-slate-100 pt-6">
          <div className="w-full rounded-md bg-slate-50 p-3 text-xs text-slate-500 space-y-1">
            <p className="font-semibold text-slate-600">Тестовые аккаунты:</p>
            <p>Бухгалтер: <span className="font-mono">111111111111</span> / <span className="font-mono">pass123</span></p>
            <p>Главбух: <span className="font-mono">222222222222</span> / <span className="font-mono">pass123</span></p>
            <p>Руководитель: <span className="font-mono">333333333333</span> / <span className="font-mono">pass123</span></p>
          </div>
          <p className="text-center text-xs text-slate-500">
            Защищенное соединение. Все действия логируются.
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
