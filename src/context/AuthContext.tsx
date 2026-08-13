import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback } from 'react';
import type { User, Role } from '@/types';
import { login as apiLogin, logout as apiLogout, me as apiMe } from '@/services/auth';
import { getToken, setToken, clearToken } from '@/services/api';

interface AuthContextType {
  user: User | null;
  role: Role | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (iin: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    apiMe()
      .then(({ user }) => setUser(user))
      .catch(() => {
        clearToken();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (iin: string, password: string) => {
    const { token, user } = await apiLogin(iin, password);
    setToken(token);
    setUser(user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // даже если запрос упал — чистим локально
    }
    clearToken();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        role: user?.role ?? null,
        isAuthenticated: user !== null,
        loading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
