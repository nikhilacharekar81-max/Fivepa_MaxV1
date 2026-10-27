import { Router, Request, Response } from 'express';
import express from 'express';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import {
  store,
  cleanAllStoreData,
  mapDisputeRow,
  mapPayoutRow,
  mapPaymentMethodRow,
  type Message,
  type Payout,
  type Dispute,
  type Refund,
  type Order,
  type CustomInvoice,
  type PaymentMethodRecord
} from '../../store.js';
import { postgresStore, isPostgresEnabled } from '../../db/postgresStore.js';
import { financialTransactionService, financialRepository, checkOrRecordIdempotency, recordIdempotencyResult } from './financial.service.js';
import { diagnosticService } from '../../services/diagnosticService.js';
import { financeLedger, FinanceLedgerEngine } from './financeLedger.js';
import { paymentGatewayManager } from './paymentGateways.js';

import {
  requireAuth,
  requireActiveStatus,
  requireFinancialActiveStatus,
  requireRole,
  requireAdmin,
  adminActor,
  rateLimit,
  resolveAuthenticatedUserId,
  IS_PRODUCTION,
  formatApiError
} from '../../middleware/auth.js';
import {
  orderStateLocks,
  tryAcquireOrderLock,
  releaseOrderLock,
  resolveGigOrderPrice,
  enrichOrderWithServiceInfo,
  releaseOrderFunds,
  refundOrderFunds,
  fundOrderEscrowWithEvent,
  syncUserBalances,
  ensureWallet,
  LATE_ORDER_PROTECTION_HOURS,
  registerAuditLog,
  validateOrderReleasePreconditions
} from '../../services/orderService.js';
import { broadcastMessage } from '../../websocket.js';
import { recordMessage } from '../../services/messagingService.js';
import { closeActiveDispute } from '../../services/disputeService.js';
import {
  handlePayoutRequest,
  approvePayout,
  processPayout,
  rejectPayout,
  failPayout,
  retryPayout
} from './payout.service.js';
import { DEFAULT_FEE_CONFIG, calculateOrderFees, quoteOrderWithLiveSettings } from './fees.js';

function areSimulatedDepositsAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return true;
}

function formatRefundRow(r: any): Refund {
  return {
    id: r.id,
    orderId: r.order_id,
    buyerId: r.buyer_id,
    amount: Number(r.amount),
    reason: r.reason || '',
    status: r.status,
    createdAt: r.created_at
  };
}

function formatPayoutRow(r: any): Payout {
  return mapPayoutRow(r);
}

function formatPaymentMethodRow(r: any): PaymentMethodRecord {
  return mapPaymentMethodRow(r);
}

const router = Router();

// ==========================================
// PUBLIC FEES & INQUIRIES
// ==========================================

router.get('/fees/quote', async (req: Request, res: Response) => {
  try {
    let gigPrice: number;
    if (typeof req.query.gigId === 'string' && req.query.gigId) {
      const extraIds = typeof req.query.extraIds === 'string' && req.query.extraIds ? req.query.extraIds.split(',') : [];
      const resolved = await resolveGigOrderPrice(req.query.gigId, extraIds);
      gigPrice = resolved.gigPrice;
    } else {
      gigPrice = Number(req.query.amount);
    }
    if (!Number.isFinite(gigPrice) || gigPrice < 0) return res.status(400).json({ error: 'A valid gigId or amount is required.' });
    
    // Authoritative fee calculation using live admin settings
    const q = await quoteOrderWithLiveSettings(gigPrice);
    res.json({ ...q });
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get('/disputes', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    let result;
    if (isAdmin) {
      result = await pool.query('SELECT * FROM disputes ORDER BY created_at DESC');
    } else {
      result = await pool.query(
        `SELECT d.* FROM disputes d
         LEFT JOIN orders o ON d.order_id = o.id
         WHERE d.raised_by = $1 OR d.buyer_id = $1 OR d.seller_id = $1 OR o.buyer_id = $1 OR o.seller_id = $1
         ORDER BY d.created_at DESC`,
        [authUserId]
      );
    }
    res.json(result.rows.map(mapDisputeRow));
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/refunds', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    let result;
    if (isAdmin) {
      result = await pool.query('SELECT * FROM refunds ORDER BY created_at DESC');
    } else {
      result = await pool.query(
        `SELECT r.* FROM refunds r
         LEFT JOIN orders o ON r.order_id = o.id
         WHERE r.buyer_id = $1 OR o.buyer_id = $1 OR o.seller_id = $1
         ORDER BY r.created_at DESC`,
        [authUserId]
      );
    }
    res.json(result.rows.map(formatRefundRow));
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/payouts', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    const payoutsList = isAdmin
      ? await store.listPayouts()
      : await store.listPayoutsForUser(authUserId);
    res.json(payoutsList);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payouts', requireAuth, requireFinancialActiveStatus, rateLimit(10, 60_000), handlePayoutRequest);

// ==========================================
// USER PAYMENTS SNAPSHOT & ESCROW APIS
// ==========================================

router.get('/payments/user/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const caller = await store.getUser(authUserId);
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user financial snapshot is not allowed.' });
    }

    const userId = targetUserId;
    const u = await store.getUser(userId);
    
    if (u) {
      await financialTransactionService.ensureWallet(u.id);
    }

    const wallet = await financialRepository.getWallet(userId);
    const availableBalance = wallet?.availableBalance ?? Number(u?.walletBalance || 0);
    
    const activeEscrowStatuses = ['funded_in_escrow', 'in_progress', 'delivered', 'revision', 'disputed', 'draft_review', 'work_in_progress'];
    const userOrders = await store.listOrdersForUser(userId);

    const buyerEscrowOrders = userOrders.filter(o => o.buyerId === userId && activeEscrowStatuses.includes(o.status));
    const buyerEscrowAmount = await financialRepository.getBuyerHeldEscrowTotal(userId);

    const freelancerEscrowOrders = userOrders.filter(o => o.sellerId === userId && activeEscrowStatuses.includes(o.status));
    const freelancerEscrowAmount = await financialRepository.getFreelancerHeldEscrowTotal(userId);

    const currentYearMonth = new Date().toISOString().slice(0, 7);
    const userPaidOrders = userOrders.filter(o => o.buyerId === userId && ['funded_in_escrow', 'in_progress', 'delivered', 'revision', 'disputed', 'completed'].includes(o.status));
    const paidToDate = userPaidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
    const paidThisMonth = userPaidOrders.filter(o => (o.createdAt || '').startsWith(currentYearMonth)).reduce((sum, o) => sum + (o.amount || 0), 0);

    const userEarnedOrders = userOrders.filter(o => o.sellerId === userId && o.status === 'completed');
    const earnedToDate = Number(u?.earned || 0) || userEarnedOrders.reduce((sum, o) => sum + financeLedger.quoteOrder(o.amount).freelancerNet, 0);
    const earnedThisMonth = userEarnedOrders.filter(o => (o.createdAt || '').startsWith(currentYearMonth)).reduce((sum, o) => sum + financeLedger.quoteOrder(o.amount).freelancerNet, 0);

    let userMethods: PaymentMethodRecord[] = [];
    try {
      userMethods = await store.listPaymentMethodsForUser(userId);
    } catch {}

    res.json({
      userId,
      availableBalance,
      buyerEscrowAmount,
      freelancerEscrowAmount,
      buyerEscrowOrders,
      freelancerEscrowOrders,
      paidToDate,
      paidThisMonth,
      earnedToDate,
      earnedThisMonth,
      earnedPastTwoMonths: earnedThisMonth,
      clearingPeriodDays: 14,
      paymentMethods: userMethods,
      walletStatus: wallet?.status || 'active'
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payments/withdraw', requireAuth, requireFinancialActiveStatus, rateLimit(10, 60_000), handlePayoutRequest);

router.post('/payments/deposit', requireAuth, requireFinancialActiveStatus, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    if (!areSimulatedDepositsAllowed()) {
      return res.status(501).json({ error: 'Deposits require a connected payment gateway in production.' });
    }

    const authUserId = (req as any).authenticatedUserId;
    if (!authUserId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required' });
    }

    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) {
      return res.status(401).json({ error: 'Authenticated user not found' });
    }

    const requestedUserId = req.body?.userId;
    const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
    if (requestedUserId && requestedUserId !== authUserId) {
      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden: You cannot deposit funds into another user wallet.' });
      }
    }
    const targetUserId = (isAdmin && requestedUserId) ? requestedUserId : authUserId;
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid deposit amount greater than $0.00' });
    }
    if (amount > 5000) {
      return res.status(400).json({ error: 'Simulated deposits are limited to $5,000.' });
    }

    await ensureWallet(targetUserId);
    const key = String(req.body?.idempotencyKey || req.body?.providerReference || randomUUID());
    await financialTransactionService.creditDeposit({
      userId: targetUserId,
      amount,
      actor: `${caller.name} (Simulated)`,
      idempotencyKey: `SIM-${targetUserId}-${key}`
    });
    await syncUserBalances();
    const newBalance = await financialRepository.getWalletBalance(targetUserId);
    const transaction = { id: `SIM-TXN-${key}` };

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller.name,
      role: caller.role,
      action: 'FUNDS_DEPOSITED',
      target: `User ${caller.name}`,
      details: `Deposited $${amount.toFixed(2)} (simulated). New Balance: $${newBalance.toFixed(2)}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, newBalance, transaction });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/payments/gateway/checkout', requireAuth, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    const { amount, currency = 'USD', gateway = 'stripe', orderId, purpose = 'deposit' } = req.body || {};
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT id, name FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 1.00) {
      return res.status(400).json({ error: 'Valid amount of at least $1.00 USD is required.' });
    }

    if (currency !== 'USD') {
      return res.status(400).json({ error: 'Only USD currency is supported.' });
    }

    await ensureWallet(authUserId);
    const checkoutId = 'chk_' + randomUUID();

    const providerSession = await paymentGatewayManager.createCheckoutSession({
      gateway: gateway as any,
      amount: amt,
      currency: 'USD',
      userId: authUserId,
      orderId: orderId || undefined,
      purpose: purpose || 'deposit',
      checkoutId
    });

    await pool.query(
      `INSERT INTO payment_checkout_sessions (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, provider_tx_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'USD', $6, 'pending', $7, NOW())`,
      [checkoutId, authUserId, orderId || null, gateway, amt, purpose, providerSession.providerSessionId]
    );

    res.json({
      success: true,
      checkoutId,
      gateway,
      amount: amt,
      currency: 'USD',
      redirectUrl: providerSession.checkoutUrl || `/checkout/success?session_id=${checkoutId}&amount=${amt}`
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

const handlePaymentWebhook = async (req: Request, res: Response) => {
  const rawBody = req.body;
  const gateway = (req.headers['x-gateway-provider'] || req.query.gateway || 'stripe') as string;
  const isVerified = await paymentGatewayManager.verifyWebhookSignature({
    gateway,
    headers: req.headers,
    rawBody
  });

  if (!isVerified) {
    return res.status(403).json({ error: 'Unauthorized: Invalid or missing provider webhook signature' });
  }

  let payload: any;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }

  const { event, userId, amount, reference, transactionId, eventId, currency, checkoutId, sessionId } = payload || {};
  const txId = transactionId || eventId;
  if (!txId) {
    return res.status(400).json({ error: 'Missing required transactionId or eventId' });
  }
  if (!currency || currency !== 'USD') {
    return res.status(400).json({ error: 'Invalid or missing currency: provider webhook currency must be explicitly USD.' });
  }

  const validEvents = ['payment.succeeded', 'checkout.session.completed', 'payment_intent.succeeded', 'payment.captured', 'order.approved'];
  if (!validEvents.includes(event)) {
    return res.json({ received: true });
  }

  // Authoritative Checkout Session Resolution
  const chkId = checkoutId || sessionId || payload?.orderId;
  const pool = postgresStore.getPool();

  let preloadedSess: any = null;
  if (chkId) {
    const preSessRes = await pool.query(
      'SELECT * FROM payment_checkout_sessions WHERE id = $1 OR provider_tx_id = $1 OR order_id = $1 LIMIT 1',
      [chkId]
    );
    if (preSessRes.rows.length > 0) {
      preloadedSess = preSessRes.rows[0];
    }
  } else {
    const preSessRes = await pool.query(
      'SELECT * FROM payment_checkout_sessions WHERE provider_tx_id = $1 LIMIT 1',
      [txId]
    );
    if (preSessRes.rows.length > 0) {
      preloadedSess = preSessRes.rows[0];
    }
  }

  const resolvedUserId = userId || preloadedSess?.user_id;
  const resolvedAmount = (amount !== undefined && amount !== null && amount !== '') 
    ? Number(amount) 
    : (preloadedSess ? Number(preloadedSess.expected_amount) : NaN);

  // If this is a payment success event, but userId or positive amount cannot be resolved from payload or checkout session:
  if (!resolvedUserId || !Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
    return res.status(400).json({ error: 'Malformed payment success event: missing valid userId or positive amount.' });
  }

  // Cross-validation: if both payload and stored checkout session specify userId or amount, they must match (in USD)
  if (userId && preloadedSess?.user_id && preloadedSess.user_id !== userId) {
    return res.status(400).json({ error: 'Checkout session user mismatch.' });
  }
  if (amount !== undefined && amount !== null && preloadedSess?.expected_amount && Math.round(Number(preloadedSess.expected_amount) * 100) !== Math.round(Number(amount) * 100)) {
    return res.status(400).json({ error: 'Checkout session amount mismatch.' });
  }
  if (preloadedSess && (!preloadedSess.currency || preloadedSess.currency !== 'USD')) {
    return res.status(400).json({ error: 'Checkout session currency mismatch: must be USD.' });
  }

  try {
    const result = await postgresStore.executeInTransaction(async (client) => {
      // 1. Durably check if provider transaction ID was already processed in completed checkout sessions
      const existingTx = await client.query(
        "SELECT * FROM payment_checkout_sessions WHERE provider_tx_id = $1 AND status = 'completed'",
        [txId]
      );
      if (existingTx.rows.length > 0) {
        return { received: true, replayed: true };
      }

      // 2. PostgreSQL-level durable idempotency lock via financial_idempotency table (protects against concurrent deliveries)
      const providerTxKey = `WH-PROVIDER-TX-${gateway}-${txId}`;
      const activeCheckoutId = preloadedSess?.id || chkId || txId;
      const payloadFingerprint = {
        gateway,
        txId,
        userId: resolvedUserId,
        amount: resolvedAmount,
        checkoutId: activeCheckoutId
      };
      const idempCheck = await checkOrRecordIdempotency(
        client,
        providerTxKey,
        'paymentWebhook',
        payloadFingerprint
      );
      if (idempCheck.replayed) {
        return { received: true, replayed: true };
      }

      // 3. Lock checkout session row if exists
      let sess: any = null;
      if (activeCheckoutId) {
        const sessRes = await client.query(
          'SELECT * FROM payment_checkout_sessions WHERE id = $1 OR provider_tx_id = $1 FOR UPDATE',
          [activeCheckoutId]
        );
        if (sessRes.rows.length > 0) {
          sess = sessRes.rows[0];
        }
      }

      if (sess) {
        if (sess.user_id !== resolvedUserId) {
          throw { status: 400, message: 'Checkout session user mismatch.' };
        }
        if (!sess.currency || sess.currency !== 'USD') {
          throw { status: 400, message: 'Checkout session currency mismatch.' };
        }
        if (Math.round(Number(sess.expected_amount) * 100) !== Math.round(resolvedAmount * 100)) {
          throw { status: 400, message: 'Checkout session amount mismatch.' };
        }
        if (sess.status === 'completed') {
          await recordIdempotencyResult(client, providerTxKey, 'paymentWebhook', { received: true, replayed: true }, payloadFingerprint);
          return { received: true, replayed: true };
        }
        if (sess.status !== 'pending') {
          throw { status: 400, message: `Checkout session already in status ${sess.status}` };
        }

        // Direct Provider API Object Authenticity Verification
        const liveVerification = await paymentGatewayManager.verifyPaymentEvent({
          gateway: sess.gateway || gateway,
          sessionId: sess.provider_tx_id || sess.id,
          transactionId: txId,
          expectedAmount: Number(sess.expected_amount),
          expectedCurrency: 'USD'
        });

        if (!liveVerification.verified) {
          throw { status: 400, message: `Provider payment verification failed: ${liveVerification.error}` };
        }
      }

      await financialTransactionService.ensureWallet({ userId: resolvedUserId, role: 'buyer' }, client);

      // Surgical Fix for ISS-019: Use distinct operation-scoped deterministic key for creditDeposit
      const depositIdempotencyKey = `${providerTxKey}:creditDeposit`;
      await financialTransactionService.creditDeposit({
        userId: resolvedUserId,
        amount: resolvedAmount,
        reference: reference || txId || 'WH-DEPOSIT',
        idempotencyKey: depositIdempotencyKey,
        actor: 'Gateway Webhook',
        source: 'webhook'
      }, client);

      // Handle checkout purpose if linked to an order
      const targetOrderId = sess?.order_id || payload?.orderId;
      const targetPurpose = sess?.purpose || payload?.purpose || 'deposit';
      if (targetOrderId && (targetPurpose === 'order_payment' || targetPurpose === 'order')) {
        const ordRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [targetOrderId]);
        const ord = ordRes.rows[0];
        if (ord && (ord.status === 'payment_pending' || ord.status === 'pending')) {
          const fundIdempKey = `${providerTxKey}:fundEscrow`;
          await financialTransactionService.fundEscrow({
            orderId: ord.id,
            orderTitle: ord.title,
            amount: Number(ord.amount),
            buyerId: ord.buyer_id,
            sellerId: ord.seller_id,
            actor: `user:${resolvedUserId}`,
            idempotencyKey: fundIdempKey
          }, client);
          await client.query("UPDATE orders SET status = 'funded_in_escrow' WHERE id = $1", [ord.id]);
        }
      }

      if (sess) {
        await client.query(
          'UPDATE payment_checkout_sessions SET status = $1, provider_tx_id = $2, completed_at = NOW() WHERE id = $3',
          ['completed', txId, sess.id]
        );
      }

      const resObj = { received: true };
      await recordIdempotencyResult(client, providerTxKey, 'paymentWebhook', resObj, payloadFingerprint);

      return resObj;
    });

    await syncUserBalances();
    return res.json(result);
  } catch (e: any) {
    const statusCode = typeof e?.status === 'number' ? e.status : 400;
    return res.status(statusCode).json({ error: e?.message || e?.error || 'Webhook transaction failed' });
  }
};

router.post('/payments/webhook', express.raw({ type: 'application/json' }), handlePaymentWebhook);
router.post('/webhooks/payment', express.raw({ type: 'application/json' }), handlePaymentWebhook);

router.post('/payments/escrow/release', requireAuth, requireFinancialActiveStatus, async (req: Request, res: Response) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const caller = callerRes.rows[0];
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    const isBuyer = userId === order.buyerId;
    if (!isAdmin && !isBuyer) {
      return res.status(403).json({ error: 'Forbidden: Only the order buyer or administrator can release escrow.' });
    }

    const validationError = validateOrderReleasePreconditions(order, isAdmin);
    if (validationError) {
      return res.status(validationError.status).json({ error: validationError.error });
    }

    let revisionsResolved = false;
    if (Array.isArray(order.revisions)) {
      for (const rev of order.revisions) {
        if (rev.status === 'requested') {
          rev.status = 'resolved';
          revisionsResolved = true;
        }
      }
    }
    if (revisionsResolved) {
      const sysMsg: Message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderId: order.id,
        senderId: 'system',
        senderName: 'WorkSphere Review Desk',
        text: `📝 Revision resolved by buyer.`,
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'revision_resolved' }
      };
      await recordMessage(sysMsg);
    }

    const esc = await financialRepository.getEscrow(order.id);
    if (!esc || esc.remaining <= 0 || esc.status === 'released' || esc.status === 'refunded') {
      return res.status(400).json({ error: 'No refundable or releasable escrow funds remain for this order.' });
    }

    const pendingOffersRes = await pool.query(
      "SELECT * FROM workstream_offers WHERE order_id = $1 AND kind = 'invoice' AND status = 'pending'",
      [order.id]
    );
    const pendingInvoices = pendingOffersRes.rows;

    const pendingHigherInvoice = pendingInvoices.find(o => Number(o.amount) > esc.remaining);
    if (pendingHigherInvoice) {
      return res.status(400).json({
        error: `Cannot release escrow directly: A final invoice (${pendingHigherInvoice.number} for $${pendingHigherInvoice.amount}) is awaiting payment. Please pay or decline the invoice in the workstream.`
      });
    }

    const pendingMatchingInvoice = pendingInvoices[0];

    const seller = await store.getUser(order.sellerId);
    const buyer = await store.getUser(order.buyerId);

    if (seller) await ensureWallet(seller.id);
    if (buyer) await ensureWallet(buyer.id);

    const actorName = isAdmin ? adminActor(req) : (buyer?.name || 'Authorized Buyer');
    const requestKey = req.body?.requestKey || req.body?.idempotencyKey;
    const result = await releaseOrderFunds(order, actorName, 'Buyer approved work', true, requestKey);

    if (pendingMatchingInvoice) {
      await pool.query(
        "UPDATE workstream_offers SET status = 'paid', resolved_at = $1, resolved_by = $2 WHERE id = $3",
        [new Date().toISOString(), caller?.id || userId, pendingMatchingInvoice.id]
      );
    }

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: actorName,
      role: caller?.role || 'buyer',
      action: 'ESCROW_RELEASED_BY_BUYER',
      target: `Order #${order.id}`,
      details: `Escrow release authorized of $${order.amount}. $${result.freelancerNet} credited to ${seller?.name || 'freelancer'}, $${result.platformFee} platform fee.`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, order: enrichOrderWithServiceInfo(order), freelancerNet: result.freelancerNet, platformFee: result.platformFee });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.post('/payments/escrow/refund', requireAuth, async (req: Request, res: Response) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID is required' });
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const userId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const caller = callerRes.rows[0];
    const { reason } = req.body;
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const activeDispute = await store.getDisputeByOrderId(order.id);
    if ((activeDispute && (activeDispute.status === 'open' || activeDispute.status === 'under_investigation')) || order.status === 'disputed') {
      return res.status(400).json({ error: 'Cannot refund escrow: Order is under active dispute.' });
    }
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot refund: Order has already been completed.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot refund: Order has already been cancelled/refunded.' });
    }

    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    const isSeller = userId === order.sellerId;
    const isBuyer = userId === order.buyerId;

    if (isBuyer && !isAdmin && ['delivered', 'draft_review'].includes(order.status)) {
      return res.status(403).json({ error: 'Work has been delivered. Accept it, request a revision, or open a dispute.' });
    }

    const isGigOrder = order.orderType === 'gig' || Boolean(order.gigOrderId);
    if (isGigOrder && isSeller && !isAdmin) return res.status(403).json({ error: 'Sellers must use the cancellation request.' });
    const overdueThresholdHours = LATE_ORDER_PROTECTION_HOURS;
    const isOverdueByThreshold = order.dueDate ? (Date.now() > new Date(order.dueDate).getTime() + overdueThresholdHours * 60 * 60 * 1000) : false;

    if (!isAdmin && !isSeller) {
      if (isBuyer && isOverdueByThreshold) {
        if (isGigOrder && (!reason || !String(reason).trim())) {
          return res.status(400).json({ error: 'Cancellation reason is required for very-late cancellation.' });
        }
        order.cancellationType = 'very_late';
      } else if (isBuyer) {
        return res.status(403).json({ error: `Forbidden: Buyer cannot cancel this order until ${overdueThresholdHours} hours have passed past the agreed due date.` });
      } else {
        return res.status(403).json({ error: 'Forbidden: Not authorized to refund this escrow.' });
      }
    }

    const buyer = await store.getUser(order.buyerId);
    if (buyer) await ensureWallet(buyer.id);

    const actorName = isAdmin ? adminActor(req) : (caller?.name || (isSeller ? 'Seller' : 'Buyer'));
    const requestKey = req.body?.requestKey || req.body?.idempotencyKey || `REFUND-FULL-${order.id}-${order.amount}`;
    const result = await refundOrderFunds(order, undefined, actorName, reason || (isSeller ? 'Seller cancelled order' : 'Escrow cancellation'), requestKey);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: actorName,
      role: caller?.role || (isSeller ? 'seller' : 'buyer'),
      action: isSeller ? 'ESCROW_REFUNDED_BY_SELLER' : (isAdmin ? 'ESCROW_REFUNDED_BY_ADMIN' : 'ESCROW_REFUNDED_BY_BUYER'),
      target: `Order #${order.id}`,
      details: `Escrow refund executed of $${result.refunded} to buyer wallet. Reason: ${reason || 'Escrow cancellation'}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, order, refunded: result.refunded });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.get('/payments/transactions/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user transactions is not allowed.' });
    }
    const userId = targetUserId;
    const userTxns = await financialRepository.getTransactions(userId);
    
    if (userTxns.length === 0) {
      const userOrders = await store.listOrdersForUser(userId);
      const syn: any[] = [];
      for (const ord of userOrders) {
        if (ord.buyerId === userId) {
          syn.push({
            id: `txn_ord_${ord.id}`,
            type: 'escrow_fund',
            amount: ord.amount,
            currency: 'USD',
            timestamp: `${ord.createdAt} 12:00:00`,
            status: 'completed',
            userId: userId,
            userName: ord.buyerUsername || 'Buyer',
            userRole: 'buyer',
            description: `Escrow hold for Order: ${ord.title}`,
            relatedOrderId: ord.id
          });
        }
        if (ord.sellerId === userId && ord.status === 'completed') {
          syn.push({
            id: `txn_rel_${ord.id}`,
            type: 'escrow_release',
            amount: financeLedger.quoteOrder(ord.amount).freelancerNet,
            currency: 'USD',
            timestamp: `${ord.dueDate} 15:30:00`,
            status: 'completed',
            userId: userId,
            userName: ord.sellerUsername || 'Freelancer',
            userRole: 'freelancer',
            description: `Escrow earnings (${financeLedger.quoteOrder(ord.amount).freelancerPercent}% net) from: ${ord.title}`,
            relatedOrderId: ord.id
          });
        }
      }
      return res.json(syn);
    }

    res.json(userTxns);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/payments/invoices/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const targetUserId = req.params.userId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && authUserId !== targetUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to another user invoices is not allowed.' });
    }
    const userId = targetUserId;
    const userOrders = await store.listOrdersForUser(userId);

    const orderInvoices = await Promise.all(userOrders.map(async o => {
      const isBuyer = o.buyerId === userId;
      const otherUser = await store.getUser(isBuyer ? o.sellerId : o.buyerId);
      const currentUser = await store.getUser(userId);
      return {
        id: `inv_ord_${o.id}`,
        invoiceNumber: `INV-${o.id.replace('ord_', '').toUpperCase()}`,
        userId: userId,
        type: isBuyer ? 'received' : 'sent',
        recipientName: isBuyer ? (currentUser?.name || 'Buyer') : (otherUser?.name || 'Client'),
        recipientEmail: isBuyer ? (currentUser?.email || 'buyer@example.com') : (otherUser?.email || 'client@example.com'),
        issuerName: isBuyer ? (otherUser?.name || 'Freelancer') : (currentUser?.name || 'Freelancer'),
        issuerEmail: isBuyer ? (otherUser?.email || 'seller@example.com') : (currentUser?.email || 'seller@example.com'),
        title: o.title,
        issueDate: o.createdAt,
        dueDate: o.dueDate,
        status: o.status === 'completed' ? 'paid' : o.status === 'cancelled' ? 'refunded' : 'in_escrow',
        items: [
          { description: o.title, quantity: 1, unitPrice: o.amount, amount: o.amount }
        ],
        subtotal: o.amount,
        serviceFee: o.feeBreakdown?.serviceFee ?? financeLedger.quoteOrder(o.amount).serviceFee,
        smallOrderFee: o.feeBreakdown?.smallOrderFee ?? financeLedger.quoteOrder(o.amount).smallOrderFee,
        platformFee: o.feeBreakdown?.platformCommission ?? financeLedger.quoteOrder(o.amount).platformCommission,
        tax: 0,
        total: o.feeBreakdown?.clientTotal ?? financeLedger.quoteOrder(o.amount).clientTotal,
        notes: `WorkPerHour 14-Day Escrow Protection Order #${o.id}. 100% Protected.`,
        relatedOrderId: o.id
      };
    }));

    let userCustom: any[] = [];
    try {
      const customInvoices = await store.listCustomInvoicesForUser(userId);
      userCustom = customInvoices.map(r => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        userId: r.buyerId,
        recipientName: 'Client',
        recipientEmail: 'client@example.com',
        title: r.description || `Invoice ${r.invoiceNumber}`,
        issueDate: r.createdAt ? r.createdAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
        dueDate: r.paidAt || new Date().toISOString().slice(0, 10),
        status: r.status,
        items: [{ description: r.description || 'Service', quantity: 1, unitPrice: Number(r.amount), amount: Number(r.amount) }],
        subtotal: Number(r.amount),
        platformFee: 0,
        tax: 0,
        total: Number(r.amount),
        relatedOrderId: r.relatedOrderId || undefined
      }));
    } catch {}

    res.json([...orderInvoices, ...userCustom]);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payments/invoices', requireAuth, async (req: Request, res: Response) => {
  try {
    const authenticatedUserId = (req as any).authenticatedUserId;
    const { recipientName, recipientEmail, title, dueDate, items, notes } = req.body;
    if (!title || !recipientName) {
      return res.status(400).json({ error: 'Title and recipient name are required' });
    }
    const rawItems = (items && Array.isArray(items) && items.length > 0)
      ? items
      : [{ description: title, quantity: 1, unitPrice: 100 }];

    let subtotalCents = 0;
    const cleanItems = [];
    for (const it of rawItems) {
      const qty = Number(it.quantity);
      const unitPrice = Number(it.unitPrice ?? it.price ?? it.amount);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Each invoice line item quantity must be a positive number.' });
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return res.status(400).json({ error: 'Each invoice line item price must be a non-negative number.' });
      }
      const itemAmount = Number((qty * unitPrice).toFixed(2));
      subtotalCents += Math.round(itemAmount * 100);
      cleanItems.push({
        description: String(it.description || title).slice(0, 255),
        quantity: qty,
        unitPrice,
        amount: itemAmount
      });
    }
    const subtotal = Number((subtotalCents / 100).toFixed(2));
    const platformFee = 0;
    const total = subtotal;

    const newInvoice: CustomInvoice = {
      id: 'inv_' + Date.now() + '_' + randomUUID().slice(0, 8),
      invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
      userId: authenticatedUserId,
      recipientName,
      recipientEmail: recipientEmail || 'client@example.com',
      title,
      issueDate: new Date().toISOString().substring(0, 10),
      dueDate: dueDate || new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10),
      status: 'unpaid',
      items: cleanItems,
      subtotal,
      platformFee,
      tax: 0,
      total,
      notes: notes || 'Standard WorkPerHour Invoice'
    };

    const invToSave = {
      id: newInvoice.id,
      invoiceNumber: newInvoice.invoiceNumber,
      buyerId: authenticatedUserId,
      sellerId: authenticatedUserId,
      amount: newInvoice.total,
      total: newInvoice.total,
      status: newInvoice.status,
      description: newInvoice.title,
      createdAt: newInvoice.issueDate
    };
    await store.saveCustomInvoice(invToSave as any);

    res.status(201).json(newInvoice);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/payments/methods/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';
    
    if (!isAdmin && authUserId !== req.params.userId) {
      return res.status(403).json({ error: 'Unauthorized: Cannot view another user payment methods.' });
    }

    const methods = await store.listPaymentMethodsForUser(req.params.userId);
    const sanitized = methods.map(m => ({
      ...m,
      details: {
        ...m.details,
        routingNumber: undefined
      }
    }));
    res.json(sanitized);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/payments/methods', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const { type, name, details, isDefault } = req.body;
    const userId = authUserId;
    
    if (!userId || !type || !name) {
      return res.status(400).json({ error: 'Method type and name are required' });
    }

    // Tight payment method details validation by method type
    const lowerType = String(type).trim().toLowerCase();
    if (lowerType.includes('bank')) {
      if (!details?.accountNumber && !details?.iban && !details?.routingNumber) {
        return res.status(400).json({ error: 'Bank account number, IBAN, or routing number is required for Bank Transfer.' });
      }
    } else if (lowerType.includes('paypal')) {
      if (!details?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(details.email))) {
        return res.status(400).json({ error: 'A valid email address is required for PayPal payment method.' });
      }
    } else if (lowerType.includes('upi')) {
      if (!details?.vpa && !details?.upiId) {
        return res.status(400).json({ error: 'A valid UPI VPA/ID (e.g., user@upi) is required for UPI payment method.' });
      }
    } else if (lowerType.includes('stripe')) {
      if (!details?.stripeAccountId && !details?.email) {
        return res.status(400).json({ error: 'Stripe account ID or email is required for Stripe payment method.' });
      }
    } else if (lowerType.includes('razorpay')) {
      if (!details?.accountId && !details?.vpa) {
        return res.status(400).json({ error: 'Razorpay account ID or UPI VPA is required.' });
      }
    }

    const existingMethods = await store.listPaymentMethodsForUser(userId);
    const newMethod: PaymentMethodRecord = {
      id: 'pm_' + Date.now() + '_' + randomUUID().slice(0, 8),
      userId,
      type,
      name,
      details: details || {},
      isDefault: Boolean(isDefault) || existingMethods.length === 0,
      createdAt: new Date().toISOString().substring(0, 10)
    };

    await store.savePaymentMethod(newMethod);
    res.json(newMethod);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/payments/methods/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';

    const method = await store.getPaymentMethodById(req.params.id);
    if (!method) return res.status(404).json({ error: 'Payment method not found' });

    if (!isAdmin && method.userId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Cannot delete another user payment method.' });
    }

    await store.deletePaymentMethod(req.params.id);
    res.json({ success: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.patch('/payments/methods/:id/default', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT role FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';

    const method = await store.getPaymentMethodById(req.params.id);
    if (!method) return res.status(404).json({ error: 'Payment method not found' });

    if (!isAdmin && method.userId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Cannot modify another user payment method.' });
    }

    await store.setDefaultPaymentMethod(method.userId, method.id);
    method.isDefault = true;
    res.json(method);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/wallet/deposit', requireAuth, requireFinancialActiveStatus, rateLimit(10, 60_000), async (req: Request, res: Response) => {
  try {
    if (!areSimulatedDepositsAllowed()) {
      return res.status(501).json({ error: 'Deposits require a connected payment gateway in production.' });
    }

    const authUserId = (req as any).authenticatedUserId;
    if (!authUserId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required' });
    }

    const pool = postgresStore.getPool();
    const callerRes = await pool.query('SELECT * FROM users WHERE id = $1', [authUserId]);
    const caller = callerRes.rows[0];
    if (!caller) {
      return res.status(401).json({ error: 'Authenticated user not found' });
    }

    const requestedUserId = req.body?.userId;
    let targetUserId = authUserId;
    if (requestedUserId && requestedUserId !== authUserId) {
      const isAdmin = caller.role === 'admin' || caller.role === 'super_admin';
      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden: You cannot deposit funds into another user wallet.' });
      }
      const targetUser = await store.getUser(requestedUserId);
      if (!targetUser) {
        return res.status(404).json({ error: 'Target user not found' });
      }
      targetUserId = requestedUserId;
    }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid deposit amount greater than $0.00' });
    }
    if (amount > 5000) {
      return res.status(400).json({ error: 'Simulated deposits are limited to $5,000.' });
    }

    await financialTransactionService.ensureWallet(targetUserId);
    const key = String(req.body?.idempotencyKey || randomUUID());
    const { replayed } = await financialTransactionService.creditDeposit({
      userId: targetUserId,
      amount,
      reference: `SIM-${key}`,
      idempotencyKey: `SIM-${targetUserId}-${key}`,
      actor: `${caller.name} (Simulated)`,
      source: 'simulated'
    });
    await syncUserBalances();
    const newBal = await financialRepository.getWalletBalance(targetUserId);
    res.json({ success: true, replayed, balance: newBal });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// ADMIN FINANCE REST APIS
// ==========================================

router.post('/admin/finance/reset-clean', requireRole(['super_admin']), async (req: Request, res: Response) => {
  if (IS_PRODUCTION && process.env.ALLOW_DATA_RESET !== 'true') {
    return res.status(403).json({ error: 'Data reset is disabled in production.' });
  }
  try {
    await cleanAllStoreData();
    orderStateLocks.clear();
    res.json({ success: true, message: 'All demo and runtime data reset to pristine clean state.' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/overview', requireRole(['admin', 'super_admin']), async (req: Request, res: Response) => {
  try {
    const overview = await financialRepository.getFinancialOverview();
    res.json(overview);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/wallets', requireAdmin, async (req: Request, res: Response) => {
  try {
    const wallets = await financialRepository.getWallets();
    res.json(wallets);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/wallets/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const data = await financialRepository.getWalletById(req.params.id);
    if (!data) return res.status(404).json({ error: 'Wallet not found' });
    res.json(data);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/wallets/:id/freeze', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory reason required to freeze a wallet' });
    const wallet = await financialTransactionService.freezeWallet(req.params.id, reason, adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/wallets/:id/unfreeze', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    const wallet = await financialTransactionService.unfreezeWallet(req.params.id, reason || 'Administrative review completed', adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/wallets/:id/restrict', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory reason required to restrict a wallet' });
    const wallet = await financialTransactionService.restrictWallet(req.params.id, reason, adminActor(req));
    res.json(wallet);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/transactions', requireAdmin, async (req: Request, res: Response) => {
  try {
    const txns = await financialRepository.getTransactions();
    res.json(txns);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/transactions/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const txn = await financialRepository.getTransactionById(req.params.id);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    const journal = txn.journalId ? await financialRepository.getJournalById(txn.journalId) : null;
    res.json({ transaction: txn, journal });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/ledger', requireAdmin, async (req: Request, res: Response) => {
  try {
    const journals = await financialRepository.getJournals();
    res.json(journals);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/ledger/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const journal = await financialRepository.getJournalById(req.params.id);
    if (!journal) return res.status(404).json({ error: 'Journal not found' });
    res.json(journal);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/ledger/:id/reverse', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Mandatory accounting reversal reason required' });
    const reversal = await financialTransactionService.reverseJournal(req.params.id, reason, adminActor(req));
    res.json(reversal);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/escrow', requireAdmin, async (req: Request, res: Response) => {
  try {
    const allOrders = await store.listOrders();

    const disputesRes = await postgresStore.getPool().query("SELECT * FROM disputes WHERE status IN ('open', 'under_investigation')");
    const activeDisputes = new Set(disputesRes.rows.map((r: any) => r.order_id));

    const refundsRes = await postgresStore.getPool().query("SELECT * FROM refunds WHERE status = 'approved'");
    const activeRefunds = new Set(refundsRes.rows.map((r: any) => r.order_id));

    const escrowOrders = await Promise.all(allOrders.map(async o => {
      const enriched = enrichOrderWithServiceInfo(o);
      const isDisputed = activeDisputes.has(o.id);
      const isRefunded = activeRefunds.has(o.id);
      const buyer = await store.getUser(o.buyerId);
      const seller = await store.getUser(o.sellerId);

      let escrowState = 'in_progress';
      if (isDisputed) escrowState = 'disputed';
      else if (isRefunded) escrowState = 'refunded';
      else if (o.status === 'completed') escrowState = 'released';
      else if (o.status === 'delivered') escrowState = 'release_pending';
      else if (o.status === 'funded_in_escrow') escrowState = 'funded';

      const esc = await financialRepository.getEscrow(o.id);

      return {
        ...enriched,
        buyerName: buyer?.name || 'Buyer #' + o.buyerId,
        buyerEmail: buyer?.email || '',
        sellerName: seller?.name || 'Freelancer #' + o.sellerId,
        sellerEmail: seller?.email || '',
        platformFeeRate: `${financeLedger.getPlatformCommissionRate()}%`,
        platformFeeAmount: FinanceLedgerEngine.round(o.amount * financeLedger.getPlatformCommissionRate() / 100),
        freelancerNetAmount: FinanceLedgerEngine.round(o.amount - o.amount * financeLedger.getPlatformCommissionRate() / 100),
        ledgerEscrowStatus: esc?.status || 'not_funded',
        ledgerEscrowHeld: esc?.remaining ?? 0,
        escrowState,
        isDisputed
      };
    }));
    res.json(escrowOrders);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/escrow/:orderId/release', requireAdmin, async (req: Request, res: Response) => {
  const orderId = req.params.orderId;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Order escrow has already been released and completed.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot release escrow: Order has already been cancelled/refunded.' });
    }
    const activeDispute = await store.getDisputeByOrderId(order.id);
    if ((activeDispute && (activeDispute.status === 'open' || activeDispute.status === 'under_investigation')) || order.status === 'disputed') {
      return res.status(400).json({ error: `Cannot release escrow: Order #${order.id} is under active dispute. Resolve the dispute first.` });
    }
    const esc = await financialRepository.getEscrow(order.id);
    if (!esc || esc.remaining <= 0 || esc.status === 'released' || esc.status === 'refunded') {
      return res.status(400).json({ error: 'No refundable or releasable escrow funds remain for this order.' });
    }
    const result = await releaseOrderFunds(order, adminActor(req), String(req.body.reason || 'Administrative escrow release'), false, req.body.requestKey);
    res.json({ success: true, order, journal: result.journal, freelancerNet: result.freelancerNet, platformFee: result.platformFee });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.post('/admin/finance/escrow/:orderId/refund', requireAdmin, async (req: Request, res: Response) => {
  const orderId = req.params.orderId;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const amount = req.body.amount === undefined || req.body.amount === '' ? undefined : Number(req.body.amount);
    const reason = String(req.body.reason || 'Administrative escrow refund approval');
    const actor = adminActor(req);
    const requestKey = req.body.requestKey || req.body.idempotencyKey;

    const result = await postgresStore.executeInTransaction(async (client) => {
      // 1. Lock order row
      const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (orderRes.rows.length === 0) throw new Error('Order not found');
      const orderRow = orderRes.rows[0];

      if (orderRow.status === 'completed') {
        throw new Error('Cannot refund order: Escrow funds have already been released to seller.');
      }
      if (orderRow.status === 'cancelled') {
        throw new Error('Order is already cancelled/refunded.');
      }

      // 2. Lock escrow row
      const escRes = await client.query('SELECT * FROM escrows WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (escRes.rows.length === 0) throw new Error('Escrow record not found for this order.');
      const escrow = escRes.rows[0];
      if (Number(escrow.remaining) <= 0 || escrow.status === 'released' || escrow.status === 'refunded') {
        throw new Error('No refundable escrow funds remaining for this order.');
      }

      // 3. Perform atomic refund financial operation
      const refundResult = await financialTransactionService.refundOrderFunds({
        orderId,
        amount,
        reason,
        actor,
        idempotencyKey: requestKey
      }, client);

      // 4. Lock & resolve active dispute in the same transaction
      const dispRes = await client.query(
        "SELECT * FROM disputes WHERE order_id = $1 AND status IN ('open', 'under_investigation') FOR UPDATE",
        [orderId]
      );
      if (dispRes.rows.length > 0) {
        await client.query(
          "UPDATE disputes SET status = 'resolved_refund', resolution_notes = $1, notes = $1 WHERE order_id = $2 AND status IN ('open', 'under_investigation')",
          [reason, orderId]
        );
      }

      return refundResult;
    });

    await syncUserBalances();
    const updatedOrder = await store.getOrder(orderId);
    res.json({ success: true, order: updatedOrder, result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

router.get('/admin/finance/payouts', requireAdmin, async (req: Request, res: Response) => {
  try {
    const payoutsList = await store.listPayouts();

    const enrichedPayouts = await Promise.all(payoutsList.map(async p => {
      const freelancer = await store.getUser(p.freelancerId);
      const wallet = await financialRepository.getWallet(p.freelancerId);
      return {
        ...p,
        freelancerName: freelancer?.name || 'Freelancer #' + p.freelancerId,
        freelancerEmail: freelancer?.email || '',
        walletAvailableBalance: wallet?.availableBalance || 0,
        currency: 'USD'
      };
    }));
    res.json(enrichedPayouts);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/payouts/:id/approve', requireAdmin, approvePayout);
router.post('/admin/finance/payouts/:id/process', requireAdmin, processPayout);
router.post('/admin/finance/payouts/:id/reject', requireAdmin, rejectPayout);
router.post('/admin/finance/payouts/:id/fail', requireAdmin, failPayout);
router.post('/admin/finance/payouts/:id/retry', requireAdmin, retryPayout);

router.patch('/admin/payouts/:id/approve', requireAdmin, approvePayout);
router.patch('/admin/payouts/:id/process', requireAdmin, processPayout);
router.patch('/admin/payouts/:id/fail', requireAdmin, failPayout);

router.get('/admin/finance/reconciliation', requireAdmin, async (req: Request, res: Response) => {
  try {
    const recon = await financialRepository.getReconciliationSummary();
    res.json(recon);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/reconciliation/resolve/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    if (!notes) {
      return res.status(400).json({ error: 'Investigation notes required to mark exception resolved' });
    }
    const actor = adminActor(req);
    const role = (req as any).authenticatedUser?.role || 'super_admin';
    const resolved = await financialTransactionService.resolveReconciliationException({
      exceptionId: req.params.id,
      notes,
      actor,
      role
    });
    res.json(resolved);
  } catch (err: any) {
    const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : (typeof err?.status === 'number' ? err.status : 400);
    res.status(statusCode).json({ error: err.message });
  }
});

router.get('/admin/finance/audit', requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!isPostgresEnabled()) {
      return res.status(503).json({ error: 'PostgreSQL persistence is required for financial audit logs.' });
    }
    const logs = await postgresStore.listAuditLogs();
    res.json(logs);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/admin/finance/adjustments/preview', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId, amount, direction, category, reason } = req.body;
    const preview = await financialRepository.previewAdjustment({ userId, amount: Number(amount), direction, category, reason });
    res.json(preview);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/finance/adjustments', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId, amount, direction, category, reason, evidenceReference, requestKey } = req.body;
    const result = await financialTransactionService.executeAdjustment({
      userId,
      amount: Number(amount),
      direction,
      category,
      reason,
      evidenceReference,
      actor: adminActor(req),
      requestKey
    });
    await syncUserBalances();
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/admin/finance/diagnostics', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { severity, service, operation, requestId, legacyOnly } = req.query;
    if (!isPostgresEnabled()) {
      return res.json(diagnosticService.getInMemoryLogs(req.query));
    }
    let sql = 'SELECT * FROM runtime_diagnostic_logs WHERE 1=1';
    const params: any[] = [];
    if (severity) { params.push(severity); sql += ` AND severity = $${params.length}`; }
    if (service) { params.push(service); sql += ` AND service = $${params.length}`; }
    if (operation) { params.push(operation); sql += ` AND operation = $${params.length}`; }
    if (requestId) { params.push(requestId); sql += ` AND request_id = $${params.length}`; }
    if (legacyOnly === 'true') { params.push('financeLedger'); sql += ` AND implementation = $${params.length}`; }
    sql += ' ORDER BY timestamp DESC LIMIT 100';
    
    const logs = await postgresStore.getPool().query(sql, params);
    res.json(logs.rows);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/admin/finance/export/:type', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { type } = req.params;
    const { filename, content } = await financialRepository.generateCsvExport(type, req.query as any);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(content);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
