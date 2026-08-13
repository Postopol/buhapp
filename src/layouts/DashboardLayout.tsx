import React from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import type { Role } from '@/types';
import {
  LayoutDashboard,
  Network,
  FileText,
  LogOut,
  UserCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const ROLE_LABELS: Record<Role, string> = {
  accountant: 'Рядовой бухгалтер',
  chief_accountant: 'Главный бухгалтер',
  manager: 'Руководитель'
};

export function DashboardLayout() {
  const { user, role, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const navItems = [
    { path: '/', label: 'Дашборд', icon: LayoutDashboard, roles: ['accountant', 'chief_accountant', 'manager'] },
    { path: '/workflow', label: 'Заявки (Workflow)', icon: FileText, roles: ['accountant', 'chief_accountant', 'manager'] },
    { path: '/integrations', label: 'Интеграции', icon: Network, roles: ['accountant', 'chief_accountant'] },
  ];

  const filteredNav = navItems.filter(item => role && item.roles.includes(role));

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-slate-200">
          <span className="font-bold text-lg tracking-tight text-slate-900">GovFin Portal</span>
        </div>
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {filteredNav.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${
                  isActive
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-slate-200">
          <div className="flex items-center gap-3 mb-4">
            <UserCircle className="h-8 w-8 text-slate-400" />
            <div className="flex flex-col">
              <span className="text-sm font-medium leading-none">{user?.name ?? 'Пользователь'}</span>
              <span className="text-xs text-slate-500 mt-1">{role ? ROLE_LABELS[role] : ''}</span>
            </div>
          </div>

          <Button variant="outline" className="w-full justify-start text-slate-600" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            Выйти
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 flex items-center justify-between px-8 border-b border-slate-200 bg-white">
          <h1 className="text-lg font-semibold">
            {filteredNav.find(n => n.path === location.pathname)?.label || 'Портал'}
          </h1>
          <div className="flex items-center gap-4">
            {/* Header actions could go here */}
          </div>
        </header>
        <div className="flex-1 overflow-auto p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
