import { Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { store, mapPayoutRow, type Payout } from '../../store.js';
import { postgresStore } from '../../db/postgresStore.js';
import { DEFAULT_SITE_SETTINGS, siteSettings } from '../../domains/admin/siteSettings.js';
import { financialTransactionService, financialRepository } from './financial.service.js';
import { EMAIL_DELIVERY_ENABLED } from '../../services/notificationService.js';
import {
  resolveAuthenticatedUserId,
  adminActor,
  IS_PRODUCTION
} from '../../middleware/auth.js';
import { verifyAndConsumeWithdrawalCode } from '../../services/authService.js';
import { syncUserBalances, registerAuditLog } from '../../services/orderService.js';

export const ALLOWED_METHODS: Record<string, keyof typeof DEFAULT_SITE_SETTINGS.wallets.allowedPayoutMethods> = {
  'UPI': 'upi',
  'Bank Transfer': 'bankTransfer',
  'Stripe': 'stripeConnect',
  'Razorpay': 'razorpayX',
  'PayPal': 'paypal'
};

export function resolvePayoutUserId(req: Request): string | null {
  return resolveAuthenticatedUserId(req);
}

export function formatPayoutRow(r: any): Payout {
  return mapPayoutRow(r);
}

export function payoutAudit(req: Request, action: string, p: Payout, details: string) {
  registerAuditLog({
    id: 'FAUD-' + randomUUID().slice(0, 12),
    actor: adminActor(req),
    role: 'super_admin',
    action,
    target: `Payout #${p.id}`,
    details,
    timestamp: new Date().toLocaleString()
  });
}

export async function handlePayoutRequest(req: Request, res: Response) {
  try {
    const freelancerId = resolvePayoutUserId(req);
    if (!freelancerId) {
      return res.status(401).json({ error: 'Authentication required to request a payout.' });
    }
    const user = await store.getUser(freelancerId);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }
    if (user.status === 'frozen') {
      return res.status(403).json({ error: 'User account is frozen. Financial transactions are restricted.' });
    }
    await financialTransactionService.ensureWallet({
      userId: freelancerId,
      name: user.name,
      email: user.email,
      role: user.role || 'freelancer'
    });

    const idempotencyKey = String(req.body?.idempotencyKey || req.body?.requestKey || req.headers['x-idempotency-key'] || '').trim();
    if (idempotencyKey) {
      const pool = postgresStore.getPool();
      const checkRes = await pool.query(
        "SELECT result FROM financial_idempotency WHERE key = $1 AND operation = 'requestPayout' AND status = 'completed' AND request_fingerprint->>'freelancerId' = $2",
        [idempotencyKey, freelancerId]
      );
      if (checkRes.rows.length > 0) {
        const resVal = typeof checkRes.rows[0].result === 'string' ? JSON.parse(checkRes.rows[0].result) : checkRes.rows[0].result;
        const activePayoutId = resVal?.payoutId || resVal?.payout?.id;
        const record = activePayoutId ? await store.getPayoutById(activePayoutId) : null;
        const newBalance = (await financialRepository.getWalletBalance(freelancerId)) ?? Number(user.walletBalance || 0);
        return res.status(200).json({
          success: true,
          replayed: true,
          newBalance,
          payout: record,
          ...(record || {})
        });
      }
    }

    const rawCode = req.body?.code;
    if (!rawCode || typeof rawCode !== 'string' || !rawCode.trim()) {
      return res.status(400).json({ error: 'Email verification code is required for withdrawal. Please request a code first via /api/auth/withdrawal/request-code.' });
    }

    const rawMethod = String(req.body?.method || 'Bank Transfer');
    const settingKey = ALLOWED_METHODS[rawMethod];
    const liveSettings = siteSettings.getSettings();
    const allowedMethods = liveSettings?.wallets?.allowedPayoutMethods || DEFAULT_SITE_SETTINGS.wallets.allowedPayoutMethods;
    if (!settingKey || !allowedMethods[settingKey]) {
      return res.status(400).json({ error: `Unsupported payout method "${rawMethod}".` });
    }

    const numAmount = Number(req.body?.amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0 || Math.abs(Math.round(numAmount * 100) - numAmount * 100) > 1e-6) {
      return res.status(400).json({ error: 'Please enter a valid withdrawal amount greater than $0.00' });
    }

    const walletConfig = liveSettings?.wallets || DEFAULT_SITE_SETTINGS.wallets;
    const minPayout = walletConfig?.minimumWithdrawalAmount ?? 10.00;
    if (numAmount < minPayout) {
      return res.status(400).json({ error: `Minimum payout withdrawal amount is $${minPayout.toFixed(2)}.` });
    }

    const pool = postgresStore.getPool();
    const walletRes = await pool.query('SELECT available_balance, status, user_role FROM wallets WHERE user_id = $1', [freelancerId]);
    if (walletRes.rows.length > 0) {
      const wallet = walletRes.rows[0];
      if (wallet.status === 'frozen' || wallet.status === 'suspended' || wallet.status === 'restricted') {
        return res.status(400).json({ error: `Cannot request payout from a ${wallet.status} wallet.` });
      }
      if (wallet.user_role && wallet.user_role !== 'freelancer') {
        return res.status(400).json({ error: 'Only freelancers can request payouts.' });
      }
      if (Number(wallet.available_balance || 0) < numAmount) {
        return res.status(400).json({ error: 'Insufficient available balance.' });
      }
    }

    const dailyLimit = walletConfig?.dailyWithdrawalLimit ?? 10000;
    const dailyRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total_today FROM payouts
       WHERE freelancer_id = $1 AND status IN ('pending', 'approved', 'processed') AND NULLIF(created_at::text, '')::timestamptz >= NOW() - INTERVAL '24 hours'`,
      [freelancerId]
    );
    const totalToday = Number(dailyRes.rows[0]?.total_today || 0);
    if (totalToday + numAmount > dailyLimit) {
      return res.status(400).json({
        error: `Daily withdrawal limit of $${dailyLimit.toFixed(2)} exceeded. Requested: $${numAmount.toFixed(2)}, Already requested today: $${totalToday.toFixed(2)}.`
      });
    }

    const verification = await verifyAndConsumeWithdrawalCode(freelancerId, rawCode);
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error });
    }

    // Deterministic payoutId if idempotencyKey provided, else random
    const id = idempotencyKey
      ? ('pay_' + createHash('sha256').update(`${freelancerId}:${idempotencyKey}`).digest('hex').slice(0, 12))
      : ('pay_' + randomUUID().slice(0, 8));

    const accountDetails = String(req.body?.accountDetails || 'Primary Bank Account').slice(0, 500);

    const payoutResult = await financialTransactionService.requestPayout({
      payoutId: id,
      freelancerId,
      amount: numAmount,
      method: rawMethod,
      accountDetails,
      actor: `user:${freelancerId}`,
      idempotencyKey: idempotencyKey || undefined
    });

    const activePayoutId = payoutResult.payoutId || id;
    let record = await store.getPayoutById(activePayoutId);
    if (!record) {
      record = {
        id: activePayoutId,
        freelancerId,
        amount: payoutResult.amount ?? numAmount,
        method: rawMethod as Payout['method'],
        status: 'pending',
        createdAt: new Date().toISOString(),
        accountDetails: payoutResult.accountDetails || accountDetails
      };
      await store.savePayout(record);
    }

    await syncUserBalances([freelancerId]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: user.name,
      role: user.role,
      action: 'PAYOUT_REQUESTED',
      target: `Payout #${record.id}`,
      details: `User requested withdrawal of $${numAmount.toFixed(2)} via ${record.method}`,
      timestamp: new Date().toLocaleString()
    });

    const newBalance = (await financialRepository.getWalletBalance(freelancerId)) ?? Number(user.walletBalance || 0);
    const txs = await financialRepository.getTransactions(freelancerId);
    const transaction = txs.find(t => (t as any).relatedPayoutId === activePayoutId);

    res.status(201).json({
      success: true,
      newBalance,
      payout: record,
      transaction,
      ...record
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}

export const approvePayout = async (req: Request, res: Response) => {
  try {
    const payoutId = req.params.id;
    const updatedPayout = await postgresStore.executeInTransaction(async (client) => {
      const pRes = await client.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [payoutId]);
      if (pRes.rows.length === 0) throw { status: 404, message: 'Payout not found' };
      const payout = pRes.rows[0];
      if (payout.status === 'approved') {
        return mapPayoutRow(payout);
      }
      if (payout.status !== 'pending') {
        throw { status: 400, message: `Cannot approve payout in status "${payout.status}"` };
      }
      const updated = await client.query(
        "UPDATE payouts SET status = 'approved', updated_at = NOW() WHERE id = $1 RETURNING *",
        [payoutId]
      );
      return mapPayoutRow(updated.rows[0]);
    });

    payoutAudit(req, 'PAYOUT_APPROVED', updatedPayout, `Approved payout of $${updatedPayout.amount} via ${updatedPayout.method} for freelancer ${updatedPayout.freelancerId}`);
    res.json(updatedPayout);
  } catch (err: any) {
    const status = typeof err?.status === 'number' ? err.status : 400;
    res.status(status).json({ error: err.message || err.error });
  }
};

export const processPayout = async (req: Request, res: Response) => {
  try {
    const payoutId = req.params.id;
    const pool = postgresStore.getPool();
    const pCheck = await pool.query('SELECT * FROM payouts WHERE id = $1', [payoutId]);
    if (pCheck.rows.length === 0) return res.status(404).json({ error: 'Payout not found' });
    const preRow = pCheck.rows[0];
    if (preRow.status !== 'pending' && preRow.status !== 'approved') {
      return res.status(400).json({ error: `Cannot process payout in status "${preRow.status}"` });
    }
    if (Number(preRow.amount) >= 500 && preRow.status !== 'approved') {
      return res.status(400).json({ error: 'Payouts of $500.00 or more require explicit administrative approval before processing.' });
    }
    const providerReference = req.body?.providerReference ? String(req.body.providerReference).trim() : '';
    if (IS_PRODUCTION && !providerReference) {
      return res.status(400).json({ error: 'Explicit providerReference is required in production to process a payout.' });
    }
    const { journal } = await financialTransactionService.settlePayout({
      payoutId,
      actor: adminActor(req),
      providerReference: providerReference || `GW-SETTLE-${Date.now()}`
    });
    const p = await store.getPayoutById(payoutId);
    if (p) {
      payoutAudit(req, 'PAYOUT_PROCESSED', p, `Processed payout of $${p.amount} via ${p.method}`);
    }
    await syncUserBalances([preRow.freelancer_id]);
    res.json({ success: true, payout: p, journal, ...(p || {}) });
  } catch (err: any) {
    const status = typeof err?.status === 'number' ? err.status : 400;
    res.status(status).json({ error: err.message || err.error });
  }
};

export const rejectPayout = async (req: Request, res: Response) => {
  try {
    const p = await store.getPayoutById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payout not found' });
    if (p.status !== 'pending' && p.status !== 'approved') {
      return res.status(400).json({ error: `Cannot reject payout in status "${p.status}"` });
    }
    await financialTransactionService.cancelPayout({
      payoutId: p.id,
      reason: String(req.body?.reason || 'Administrative rejection'),
      actor: adminActor(req)
    });
    const updated = (await store.getPayoutById(p.id)) || { ...p, status: 'cancelled' as const };
    payoutAudit(req, 'PAYOUT_REJECTED', updated, `Rejected payout of $${updated.amount}; funds returned to wallet`);
    await syncUserBalances([p.freelancerId]);
    res.json({ success: true, payout: updated, ...updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const failPayout = async (req: Request, res: Response) => {
  try {
    const payoutId = req.params.id;
    const pool = postgresStore.getPool();
    const pCheck = await pool.query('SELECT * FROM payouts WHERE id = $1', [payoutId]);
    if (pCheck.rows.length === 0) return res.status(404).json({ error: 'Payout not found' });
    const currentPayout = pCheck.rows[0];

    if (currentPayout.status === 'failed') {
      const p = await store.getPayoutById(payoutId);
      return res.json(p || mapPayoutRow(currentPayout));
    }
    if (currentPayout.status === 'processed') {
      return res.status(400).json({ error: 'Cannot fail payout: Payout has already been processed.' });
    }
    if (currentPayout.status !== 'pending' && currentPayout.status !== 'approved') {
      return res.status(400).json({ error: `Cannot fail payout in status "${currentPayout.status}"` });
    }

    await financialTransactionService.failPayout({
      payoutId,
      reason: String(req.body?.reason || 'Gateway reported a transfer failure'),
      actor: adminActor(req)
    });
    const p = await store.getPayoutById(payoutId);
    if (p) {
      payoutAudit(req, 'PAYOUT_FAILED', p, `Payout of $${p.amount} failed; funds returned to wallet`);
    }
    await syncUserBalances([currentPayout.freelancer_id]);
    res.json(p || mapPayoutRow(currentPayout));
  } catch (err: any) {
    const status = typeof err?.status === 'number' ? err.status : 400;
    res.status(status).json({ error: err.message || err.error });
  }
};

export const retryPayout = async (req: Request, res: Response) => {
  try {
    const payoutId = req.params.id;
    const pool = postgresStore.getPool();
    const pCheck = await pool.query('SELECT * FROM payouts WHERE id = $1', [payoutId]);
    if (pCheck.rows.length === 0) return res.status(404).json({ error: 'Payout not found' });
    const p = pCheck.rows[0];
    if (p.status !== 'failed') return res.status(400).json({ error: 'Only failed payouts can be retried.' });

    await financialTransactionService.retryPayout({ payoutId, actor: adminActor(req) });
    const updated = await store.getPayoutById(payoutId);
    if (updated) {
      payoutAudit(req, 'PAYOUT_RETRIED', updated, `Re-queued failed payout of $${updated.amount}`);
    }
    await syncUserBalances([p.freelancer_id]);
    res.json(updated || mapPayoutRow(p));
  } catch (err: any) {
    const status = typeof err?.status === 'number' ? err.status : 400;
    res.status(status).json({ error: err.message || err.error });
  }
};
