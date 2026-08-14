import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import {
  LayoutDashboard, FileText, Wallet, Building2, CalendarCheck, CalendarClock,
  LogOut, UserCircle, Calculator, Scale,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ROLE_LABELS, SECTION_LABELS, type Role } from '@shared/domain';
import { cn } from '@/lib/utils';

interface NavItem {
  path: string;
  label: string;
  icon: typeof FileText;
  roles: Role[];
  end?: boolean;
}

const NAV: NavItem[] = [
  {
    path: '/',
    label: 'Рабочее место',
    icon: LayoutDashboard,
    roles: ['initiator', 'accountant', 'chief_accountant', 'director'],
    end: true,
  },
  {
    path: '/documents',
    label: 'Документы',
    icon: FileText,
    roles: ['initiator', 'accountant', 'chief_accountant', 'director'],
  },
  {
    path: '/payments',
    label: 'Оплаты',
    icon: Wallet,
    roles: ['accountant', 'chief_accountant'],
  },
  {
    path: '/counterparties',
    label: 'Контрагенты',
    icon: Building2,
    roles: ['accountant', 'chief_accountant', 'director'],
  },
  {
    // Роли обязаны совпадать с requireRole в роутере, иначе пункт есть,
    // а страница отдаёт 403.
    path: '/reconciliations',
    label: 'Акты сверки',
    icon: Scale,
    roles: ['accountant', 'chief_accountant', 'director'],
  },
  {
    path: '/closing',
    label: 'Закрытие месяца',
    icon: CalendarCheck,
    roles: ['accountant', 'chief_accountant', 'director'],
  },
  {
    path: '/taxes',
    label: 'Налоговый календарь',
    icon: CalendarClock,
    roles: ['accountant', 'chief_accountant', 'director'],
  },
];

export function DashboardLayout() {
  const { user, role, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const items = NAV.filter((item) => role && item.roles.includes(role));

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
          <Calculator className="h-5 w-5 text-slate-900" />
          <span className="text-lg font-bold tracking-tight text-slate-900">Бухгалтерия</span>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-slate-100 text-slate-900'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-4">
          <div className="mb-3 flex items-center gap-3">
            <UserCircle className="h-8 w-8 shrink-0 text-slate-300" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium leading-tight">{user?.name ?? 'Пользователь'}</div>
              <div className="mt-0.5 truncate text-xs text-slate-500">
                {role ? ROLE_LABELS[role] : ''}
                {user?.section ? ` · ${SECTION_LABELS[user.section]}` : ''}
                {user?.department ? ` · ${user.department}` : ''}
              </div>
            </div>
          </div>
          <Button variant="outline" className="w-full justify-start text-slate-600" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            Выйти
          </Button>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-auto p-6 lg:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
