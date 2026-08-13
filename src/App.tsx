import type { ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { DashboardLayout } from '@/layouts/DashboardLayout';
import { Login } from '@/pages/Login';
import { Workspace } from '@/pages/Workspace';
import { Documents } from '@/pages/Documents';
import { DocumentDetail } from '@/pages/DocumentDetail';
import { Counterparties } from '@/pages/Counterparties';
import { CounterpartyDetail } from '@/pages/CounterpartyDetail';
import { Payments } from '@/pages/Payments';
import { Closing } from '@/pages/Closing';
import { Taxes } from '@/pages/Taxes';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-slate-400">Загрузка…</div>
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
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
        <Route path="counterparties" element={<Counterparties />} />
        <Route path="counterparties/:id" element={<CounterpartyDetail />} />
        <Route path="payments" element={<Payments />} />
        <Route path="closing" element={<Closing />} />
        <Route path="taxes" element={<Taxes />} />
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
