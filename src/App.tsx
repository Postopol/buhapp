import type { ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { DashboardLayout } from '@/layouts/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Login } from '@/pages/Login';
import { Workspace } from '@/pages/Workspace';
import { Documents } from '@/pages/Documents';
import { DocumentDetail } from '@/pages/DocumentDetail';
import { Counterparties } from '@/pages/Counterparties';
import { CounterpartyDetail } from '@/pages/CounterpartyDetail';
import { Payments } from '@/pages/Payments';
import { Closing } from '@/pages/Closing';
import { Taxes } from '@/pages/Taxes';
import { Reconciliations } from '@/pages/Reconciliations';
import { ReconciliationDetail } from '@/pages/ReconciliationDetail';
import type { Role } from '@/types';

/** Кто пускается в раздел. Значения обязаны совпадать с requireRole в
 *  соответствующем роутере сервера и с фильтром меню в DashboardLayout,
 *  иначе пункт есть, а страница отдаёт 403. */
const ACCOUNTING: Role[] = ['accountant', 'chief_accountant'];
const ACCOUNTING_AND_DIRECTOR: Role[] = ['accountant', 'chief_accountant', 'director'];

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-slate-400">Загрузка…</div>
      </div>
    );
  }
  // Запоминаем, куда человек шёл: ссылку на карточку документа пересылают
  // коллеге, а протухшая сессия не должна ронять на рабочее место с середины
  // работы. После входа возвращаем на тот же адрес вместе с фильтрами в query.
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

/** Клиентское зеркало requireRole. Само по себе ничего не защищает — защищает
 *  сервер, — но без него инициатор по прямой ссылке видит красную плашку с
 *  403 вместо внятного объяснения. */
function RoleRoute({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { role } = useAuth();
  if (role && !roles.includes(role)) return <NoAccess />;
  return <>{children}</>;
}

function NoAccess() {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <ShieldAlert className="mx-auto h-8 w-8 text-slate-300" />
      <h2 className="mt-3 text-lg font-semibold text-slate-900">Недостаточно прав</h2>
      <p className="mt-1 text-sm text-slate-500">
        Этот раздел ведёт бухгалтерия. Если доступ нужен по работе, попросите главного бухгалтера.
      </p>
      <Link to="/">
        <Button variant="outline" className="mt-4">
          На рабочее место
        </Button>
      </Link>
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Workspace />} />
        <Route path="documents" element={<Documents />} />
        {/* Отдельный URL у документа: ссылку можно отправить, F5 не теряет контекст */}
        <Route path="documents/:id" element={<DocumentDetail />} />
        {/* Контрагенты ролью не закрыты: инициатор попадает сюда по ссылке из
            своей же карточки документа, и сервер такие чтения разрешает. */}
        <Route path="counterparties" element={<Counterparties />} />
        <Route path="counterparties/:id" element={<CounterpartyDetail />} />
        <Route
          path="payments"
          element={
            <RoleRoute roles={ACCOUNTING}>
              <Payments />
            </RoleRoute>
          }
        />
        <Route
          path="closing"
          element={
            <RoleRoute roles={ACCOUNTING_AND_DIRECTOR}>
              <Closing />
            </RoleRoute>
          }
        />
        <Route
          path="taxes"
          element={
            <RoleRoute roles={ACCOUNTING_AND_DIRECTOR}>
              <Taxes />
            </RoleRoute>
          }
        />
        <Route
          path="reconciliations"
          element={
            <RoleRoute roles={ACCOUNTING_AND_DIRECTOR}>
              <Reconciliations />
            </RoleRoute>
          }
        />
        <Route
          path="reconciliations/:id"
          element={
            <RoleRoute roles={ACCOUNTING_AND_DIRECTOR}>
              <ReconciliationDetail />
            </RoleRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <AppRoutes />
      </Router>
    </AuthProvider>
  );
}
