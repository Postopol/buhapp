import { Router } from 'express';
import { db } from '../db';
import { requireAuth } from '../auth';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get('/kpis', (_req, res) => {
  const totals = db.prepare(
    'SELECT COALESCE(SUM(plan), 0) as total_plan, COALESCE(SUM(fact), 0) as total_fact FROM ifp_data'
  ).get() as { total_plan: number; total_fact: number };
  const blockedRow = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as blocked FROM requests
     WHERE status IN ('finance_check','chief_signature','ready_treasury')`
  ).get() as { blocked: number };
  const totalBudget = totals.total_plan;
  const spent = totals.total_fact;
  const blocked = blockedRow.blocked;
  const remaining = totalBudget - spent - blocked;
  res.json({
    kpis: {
      totalBudget,
      spent,
      remaining: remaining > 0 ? remaining : 0,
      blocked,
    },
  });
});

dashboardRouter.get('/ifp', (_req, res) => {
  const rows = db.prepare(
    'SELECT name, plan, fact FROM ifp_data ORDER BY code'
  ).all() as { name: string; plan: number; fact: number }[];
  res.json({
    ifp: rows.map((r) => ({
      name: r.name,
      plan: Math.round(r.plan / 1000000),
      fact: Math.round(r.fact / 1000000),
    })),
  });
});

dashboardRouter.get('/alerts', (_req, res) => {
  const rows = db.prepare(
    'SELECT id, type, message, created_at FROM alerts ORDER BY created_at DESC'
  ).all() as { id: number; type: 'critical' | 'warning' | 'info'; message: string; created_at: string }[];
  res.json({
    alerts: rows.map((r) => ({
      id: r.id,
      type: r.type,
      message: r.message,
      date: r.created_at,
    })),
  });
});
