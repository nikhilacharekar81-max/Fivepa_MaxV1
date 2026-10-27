import { randomUUID } from 'crypto';
import {
  store,
  users,
  messages,
  disputes,
  auditLogs,
  type Order,
  type Gig,
  type User,
  type Dispute,
  type AuditLog,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import {
  financialTransactionService,
  financialRepository,
  recordRecentClearingSync,
  getRecentClearingTotalSync
} from '../domains/finance/financial.service.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { workspaceService } from '../../src/server/workspaceService.js';
import { emitSystemEvent, recordMessage, registerMessage } from './messagingService.js';
import { createNotification, sendOrderEmail } from './notificationService.js';
import { recalculateUserRating } from './reviewService.js';
import { broadcastMessage } from '../websocket.js';
import { diagnosticService } from './diagnosticService.js';

export interface ClearingEarning {
  orderId: string;
  sellerId: string;
  amount: number;
  clearsAt: string;
}
export const clearingEarnings: ClearingEarning[] = Object.freeze([]) as any;

export function getUnclearedEarnings(userId: string): number {
  return getRecentClearingTotalSync(userId);
}

export async function getUnclearedEarningsFromDb(userId: string): Promise<number> {
  const dbAmount = await store.getUnclearedEarningsAmount(userId);
  if (dbAmount > 0) return dbAmount;
  return getUnclearedEarnings(userId);
}

export async function getActiveEscrowRemaining(order: Order): Promise<number> {
  const esc = await financialRepository.getEscrow(order.id);
  if (esc) return esc.remaining;
  return (order.status === 'completed' || order.status === 'cancelled') ? 0 : Number(order.amount || 0);
}

export const orderIndex = new Map<string, Order>();

export const orderStateLocks = new Set<string>();

export function acquireOrderLock(orderId: string) {
  if (orderStateLocks.has(orderId)) {
    throw new Error('Action rejected: This order is currently being processed by another operation. Please retry in a moment.');
  }
  orderStateLocks.add(orderId);
}

export function tryAcquireOrderLock(orderId: string, res: any): boolean {
  try {
    acquireOrderLock(orderId);
    return true;
  } catch (err: any) {
    diagnosticService.log('security', 'orderService', 'tryAcquireOrderLock', 'server/services/orderService.ts', 'concurrency_lock', 'INTERCEPTED', { orderId }, err.message);
    res.status(409).json({ error: err.message });
    return false;
  }
}

export function releaseOrderLock(orderId: string) {
  orderStateLocks.delete(orderId);
}

export function registerOrder(o: Order) {
  // Authoritative persistence is handled directly via store.saveOrder
  return;
}

export async function recordOrder(o: Order): Promise<void> {
  await workspaceService.ensureWorkspaceForOrderAsync(o);
  registerOrder(o);
}

export async function registerAuditLog(log: AuditLog): Promise<void> {
  try {
    await store.addAuditLog(log);
  } catch (err) {
    console.error('[PostgresStore] Failed to save audit log:', err);
  }
}

export function saveOrdersToDisk() { return Promise.resolve(); }
export function saveUsersToPostgres() { return Promise.resolve(); }
export function saveGigsToPostgres() { return Promise.resolve(); }

export async function syncUserBalances(userIds?: string[]) {
  try {
    const pool = postgresStore.getPool();
    const hasSpecificUsers = Array.isArray(userIds) && userIds.length > 0;

    if (hasSpecificUsers) {
      const distinctIds = Array.from(new Set(userIds.filter(Boolean)));
      if (distinctIds.length === 0) return;

      await pool.query(`
        UPDATE users u
        SET wallet_balance = w.available_balance
        FROM wallets w
        WHERE u.id = w.user_id AND u.id = ANY($1)
      `, [distinctIds]);

      const walletRows = await pool.query(
        'SELECT user_id, available_balance FROM wallets WHERE user_id = ANY($1)',
        [distinctIds]
      );
      const balanceMap = new Map<string, number>();
      for (const r of walletRows.rows) {
        balanceMap.set(r.user_id, Number(r.available_balance));
      }

      for (const u of (users || [])) {
        if (!u || !balanceMap.has(u.id)) continue;
        u.walletBalance = balanceMap.get(u.id)!;
      }
    } else {
      await pool.query(`
        UPDATE users u
        SET wallet_balance = w.available_balance
        FROM wallets w
        WHERE u.id = w.user_id
      `);

      const walletRows = await pool.query('SELECT user_id, available_balance FROM wallets');
      const balanceMap = new Map<string, number>();
      for (const r of walletRows.rows) {
        balanceMap.set(r.user_id, Number(r.available_balance));
      }

      for (const u of (users || [])) {
        if (!u || !balanceMap.has(u.id)) continue;
        u.walletBalance = balanceMap.get(u.id)!;
      }
    }
  } catch (err) {
    console.error('[syncUserBalances] Error syncing balances:', err);
  }
}

export async function ensureWallet(userId: string) {
  try {
    await financialTransactionService.ensureWallet(userId);
  } catch (err) {
    console.error(`[ensureWallet] Failed for user ${userId}:`, err);
  }
}

export function syncIndexes() {
  // Clearing records are managed directly in PostgreSQL earnings_clearing
}

export async function resolveGigOrderPrice(gigId: string, extraIds: unknown): Promise<{ gig: any; gigPrice: number; extrasTitles: string[] }> {
  const res = await postgresStore.getPool().query('SELECT * FROM gigs WHERE id = $1', [gigId]);
  if (res.rows.length === 0) {
    const err: any = new Error('Gig not found.');
    err.status = 404;
    throw err;
  }
  const r = res.rows[0];
  if (r.status && r.status !== 'active') {
    const err: any = new Error('This gig is not active for purchase.');
    err.status = 400;
    throw err;
  }
  const basePrice = Number(r.price || 0);
  const extras = Array.isArray(r.extras) ? r.extras : [];
  const requestedIds = Array.isArray(extraIds) ? extraIds.map(String) : [];
  let extrasTotal = 0;
  const extrasTitles: string[] = [];
  for (const ex of extras) {
    if (ex && requestedIds.includes(String(ex.id))) {
      extrasTotal += Number(ex.price || 0);
      if (ex.title) extrasTitles.push(String(ex.title));
    }
  }
  const gigPrice = Math.round((basePrice + extrasTotal) * 100) / 100;
  return {
    gig: {
      id: r.id,
      title: r.title,
      price: basePrice,
      freelancerId: r.freelancer_id,
      freelancer_id: r.freelancer_id,
      deliveryDays: Number(r.delivery_days || 7),
      extras
    },
    gigPrice,
    extrasTitles
  };
}

export function getReviewWindowStart(order: any, delivery: any): number {
  const deliveredAt = new Date(delivery?.deliveredAt).getTime();
  const restartedAt = order?.reviewWindowRestartedAt ? new Date(order.reviewWindowRestartedAt).getTime() : NaN;
  if (!isNaN(restartedAt) && (isNaN(deliveredAt) || restartedAt > deliveredAt)) return restartedAt;
  return deliveredAt;
}

export function getReviewWindowDays(): number {
  if (process.env.REVIEW_WINDOW_DAYS !== undefined) {
    const parsed = Number(process.env.REVIEW_WINDOW_DAYS);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  const settings = siteSettings.getSettings();
  if (typeof settings.marketplace?.autoCompleteDeliveredDays === 'number') {
    return settings.marketplace.autoCompleteDeliveredDays;
  }
  return 3;
}

export function isAutoAcceptEnabled(): boolean {
  if (process.env.AUTO_ACCEPT_ENABLED !== undefined) {
    const v = process.env.AUTO_ACCEPT_ENABLED.trim().toLowerCase();
    if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  }
  const settings = siteSettings.getSettings();
  if (settings.marketplace?.autoCompleteDeliveredEnabled === false) return false;
  return getReviewWindowDays() > 0;
}

export const LATE_ORDER_PROTECTION_HOURS = 48;

export function assertOrderOpen(order: Order) {
  if (order.status === 'completed') throw new Error('Order is already completed; funds were already released.');
  if (order.status === 'cancelled') throw new Error('Order is already cancelled; funds were already handled.');
}

export async function fundOrderEscrowWithEvent(params: { orderId: string; orderTitle: string; amount: number; buyerId: string; sellerId: string; actor: string; skipMinimum?: boolean; idempotencyKey?: string }) {
  return await financialTransactionService.fundEscrow(params);
}

export async function topUpOrderEscrowWithEvent(params: { orderId: string; orderTitle: string; amount: number; buyerId: string; sellerId: string; actor: string; skipMinimum?: boolean; idempotencyKey?: string }) {
  const res = await financialTransactionService.topUpEscrow(params);
  await emitSystemEvent(params.orderId, 'escrow_funded', `🔒 Additional $${params.amount.toLocaleString()} funded into escrow for "${params.orderTitle}".`, { amount: params.amount, isTopUp: true });
  return res;
}

export async function releaseOrderFunds(order: Order, actor: string, reason: string, approvedByBuyer: boolean, requestKey?: string) {
  if (order.status === 'completed' && !requestKey) {
    throw new Error('Order is already completed; funds were already released.');
  }
  assertOrderOpen(order);
  
  const result = await financialTransactionService.releaseOrderFunds({
    orderId: order.id,
    actor,
    reason,
    idempotencyKey: requestKey
  });

  order.status = 'completed';
  if (!order.completedAt) {
    order.completedAt = new Date().toISOString();
  }
  if (Array.isArray(order.deliveryHistory) && order.deliveryHistory.length > 0) {
    order.acceptedVersion = order.deliveryHistory[order.deliveryHistory.length - 1].version;
  }

  await syncUserBalances([order.buyerId, order.sellerId].filter(Boolean));
  await postgresStore.getPool().query(
    'UPDATE orders SET status = $1, completed_at = COALESCE(completed_at, $2), accepted_version = COALESCE($3, accepted_version) WHERE id = $4 AND status NOT IN (\'completed\', \'cancelled\')',
    ['completed', order.completedAt, order.acceptedVersion ?? null, order.id]
  );

  if (approvedByBuyer) {
    await emitSystemEvent(order.id, 'deliverable_approved', `✅ Deliverables approved by buyer.`, {
      freelancerNet: result.freelancerNet,
      acceptedVersion: order.acceptedVersion
    });
  }

  await emitSystemEvent(order.id, 'escrow_released', `🎉 Escrow funds ($${order.amount.toLocaleString()}) released to seller! Workstream marked as completed.`, {
    amount: order.amount,
    freelancerNet: result.freelancerNet,
    platformFee: result.platformFee,
    orderCompleted: true
  });

  await emitSystemEvent(order.id, 'order_completed', `✅ Order completed.`);
  return result;
}

export async function refundOrderFunds(order: Order, amount: number | undefined, actor: string, reason: string, requestKey?: string) {
  const result = await financialTransactionService.refundOrderFunds({
    orderId: order.id,
    amount,
    reason,
    actor,
    idempotencyKey: requestKey
  });

  if (result.remaining === 0) {
    order.status = 'cancelled';
  }

  await syncUserBalances([order.buyerId, order.sellerId].filter(Boolean));
  await postgresStore.getPool().query(
    'UPDATE orders SET status = $1, cancellation_type = COALESCE($2, cancellation_type) WHERE id = $3 AND status NOT IN (\'completed\', \'cancelled\')',
    [order.status, order.cancellationType || null, order.id]
  );

  await emitSystemEvent(order.id, 'escrow_refunded', `💸 Escrow refunded ($${result.refunded.toLocaleString()}) to buyer wallet. Reason: ${reason}`, {
    refunded: result.refunded,
    orderCancelled: order.status === 'cancelled'
  });

  return result;
}

export async function splitOrderFunds(order: Order, refundAmount: number, actor: string, reason: string, requestKey?: string) {
  assertOrderOpen(order);
  const result = await financialTransactionService.resolveEscrowSplit({ orderId: order.id, refundAmount, reason, actor });
  order.status = 'completed';
  if (!order.completedAt) {
    order.completedAt = new Date().toISOString();
  }

  await syncUserBalances([order.buyerId, order.sellerId].filter(Boolean));
  await postgresStore.getPool().query(
    'UPDATE orders SET status = $1, completed_at = COALESCE(completed_at, $2) WHERE id = $3 AND status NOT IN (\'completed\', \'cancelled\')',
    ['completed', order.completedAt, order.id]
  );

  await emitSystemEvent(order.id, 'escrow_refunded', `💸 Partial refund of $${refundAmount.toLocaleString()} returned to buyer wallet. Reason: ${reason}`, {
    refunded: refundAmount,
    splitResolution: true
  });
  await emitSystemEvent(order.id, 'escrow_released', `🎉 Remaining escrow funds ($${result.release.freelancerNet.toLocaleString()}) released to seller. Workstream marked as completed.`, {
    freelancerNet: result.release.freelancerNet,
    platformFee: result.release.platformFee,
    orderCompleted: true,
    splitResolution: true
  });
  await emitSystemEvent(order.id, 'order_completed', `✅ Order completed via dispute resolution.`);

  return result;
}

export function validateOrderReleasePreconditions(order: Order, isAdmin = false, isInvoiceApproval = false): { status: number; error: string } | null {
  if (order.status === 'completed') {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Order is already completed');
    return { status: 400, error: 'Order is already completed and payment has already been released.' };
  }
  if (order.status === 'cancelled') {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Order is cancelled; funds already refunded');
    return { status: 400, error: 'Order is cancelled; funds have been returned to the buyer.' };
  }
  if (!isAdmin && (order.status as string) === 'disputed') {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Cannot release payment while dispute is open');
    return { status: 400, error: 'Cannot release payment while an active dispute is open. The dispute must be resolved first.' };
  }
  const hasDeliverables = (Array.isArray(order.deliverableFiles) && order.deliverableFiles.length > 0) ||
                          (Array.isArray(order.deliveryHistory) && order.deliveryHistory.length > 0) ||
                          Boolean(order.deliveryReference) ||
                          order.status === 'delivered';
  if (!isAdmin && !hasDeliverables) {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Payment release attempted without deliverable evidence');
    return { status: 400, error: 'Payment can only be released after deliverables have been submitted.' };
  }
  if (!isAdmin && !isInvoiceApproval && order.status !== 'delivered') {
    diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, status: order.status }, 'Payment release attempted before work was delivered');
    return { status: 400, error: 'Payment can only be released after the freelancer has submitted deliverables.' };
  }
  if (!isAdmin && !isInvoiceApproval && Array.isArray(order.revisions)) {
    const activeRev = order.revisions.some(r => r.status === 'requested');
    if (activeRev) {
      diagnosticService.log('security', 'orderService', 'validateOrderReleasePreconditions', 'server/services/orderService.ts', 'release_preconditions', 'INTERCEPTED', { orderId: order.id, revisions: order.revisions }, 'Payment release attempted while revision is pending');
      return { status: 400, error: 'Cannot release payment while a revision is in progress. The freelancer must deliver the revised work first.' };
    }
  }
  return null;
}

export function enrichOrderWithServiceInfo(o: Order, isAdmin: boolean = false) {
  const resolvedType = o.orderType || (o as any).type || (o.projectId ? 'project' : 'gig');
  const base = {
    ...o,
    orderType: resolvedType,
    type: resolvedType,
    gigOrderId: o.gigOrderId || (resolvedType === 'gig' ? o.id : undefined),
    projectOrderId: o.projectOrderId || (resolvedType === 'project' ? o.id : undefined),
    sellerName: (o as any).sellerName || o.sellerUsername || 'Seller',
    sellerAvatar: (o as any).sellerAvatar || '',
    buyerName: (o as any).buyerName || o.buyerUsername || 'Buyer',
    buyerAvatar: (o as any).buyerAvatar || ''
  };
  if (!isAdmin) {
    const { adminInternalNotes, adminHistory, ...sanitized } = base as any;
    return sanitized;
  }
  return base;
}

export async function processCancellationTimeouts() {
  const now = Date.now();
  const pool = postgresStore.getPool();
  try {
    const res = await pool.query(
      "SELECT id FROM orders WHERE status NOT IN ('completed', 'cancelled') AND cancellation_request IS NOT NULL"
    );
    for (const r of res.rows) {
      const order = await store.getOrder(r.id);
      if (!order || !order.cancellationRequest || order.cancellationRequest.status !== 'pending') continue;
      const respondByTime = new Date(order.cancellationRequest.respondBy).getTime();

      if (now > respondByTime) {
        if (orderStateLocks.has(order.id)) continue;
        try {
          acquireOrderLock(order.id);
        } catch {
          continue;
        }
        try {
          const freshOrder = await store.getOrder(order.id);
          if (!freshOrder || freshOrder.status === 'completed' || freshOrder.status === 'cancelled' || !freshOrder.cancellationRequest || freshOrder.cancellationRequest.status !== 'pending') {
            continue;
          }
          const requestKey = `cancel_timeout_${freshOrder.id}_${freshOrder.cancellationRequest.requestedAt}`;
          const refundRes = await refundOrderFunds(freshOrder, undefined, 'System Auto-Cancel', 'Cancellation request auto-cancelled after 48h timeout', requestKey);
          freshOrder.cancellationRequest.status = 'auto_cancelled';
          await store.saveOrder(freshOrder);

          const requesterId = freshOrder.cancellationRequest.requesterId;
          const otherId = requesterId === freshOrder.buyerId ? freshOrder.sellerId : freshOrder.buyerId;
          createNotification({
            userId: requesterId,
            title: 'Cancellation Auto-Cancelled',
            message: `Order #${freshOrder.id} cancellation request timed out after 48h. Order cancelled & full refund issued ($${refundRes.refunded}).`,
            type: 'order',
            link: `/messages/${freshOrder.id}`
          });
          createNotification({
            userId: otherId,
            title: 'Cancellation Auto-Cancelled',
            message: `Order #${freshOrder.id} cancellation request timed out after 48h. Order cancelled & full refund issued ($${refundRes.refunded}).`,
            type: 'order',
            link: `/messages/${freshOrder.id}`
          });
        } catch (err) {
          console.error(`[CancellationTimeout] Failed to auto-cancel order ${order.id}:`, err);
        } finally {
          releaseOrderLock(order.id);
        }
      }
    }
  } catch (err) {
    console.error('[processCancellationTimeouts] Query error:', err);
  }
}

export async function processAutoAcceptOrders(customNow?: number): Promise<Array<{
  orderId: string;
  acceptedVersion: number;
  amount: number;
  freelancerNet: number;
}>> {
  if (!isAutoAcceptEnabled()) {
    return [];
  }

  const now = typeof customNow === 'number' ? customNow : Date.now();
  const processed: Array<{ orderId: string; acceptedVersion: number; amount: number; freelancerNet: number }> = [];
  const pool = postgresStore.getPool();

  try {
    const ordersRes = await pool.query("SELECT id FROM orders WHERE status = 'delivered'");
    const targetOrders: Order[] = [];
    for (const r of ordersRes.rows) {
      const order = await store.getOrder(r.id);
      if (order) targetOrders.push(order);
    }

    for (const order of targetOrders) {
      const days = order.orderType === 'project' ? 7 : getReviewWindowDays();
      const windowMs = days * 24 * 60 * 60 * 1000;

      if (!Array.isArray(order.deliveryHistory) || order.deliveryHistory.length === 0) continue;
      const latestDelivery = order.deliveryHistory[order.deliveryHistory.length - 1];
      if (!latestDelivery || !latestDelivery.deliveredAt) continue;

      const deliveredAt = getReviewWindowStart(order, latestDelivery);
      if (isNaN(deliveredAt)) continue;
      if (now - deliveredAt < windowMs) continue;

      if (Array.isArray(order.revisions)) {
        const hasActiveRequestedRevision = order.revisions.some(rev => rev.status === 'requested');
        if (hasActiveRequestedRevision) continue;
      }

      const dispute = await store.getDisputeByOrderId(order.id);
      const inMemoryDispute = (disputes || []).find(d => d.orderId === order.id && (d.status === 'open' || d.status === 'under_investigation'));
      if ((dispute && (dispute.status === 'open' || dispute.status === 'under_investigation')) || inMemoryDispute) continue;

      const esc = await financialRepository.getEscrow(order.id);
      const hasEscrow = (esc && esc.remaining > 0 && esc.status !== 'released' && esc.status !== 'refunded');
      if (!hasEscrow) {
        continue;
      }

      if (orderStateLocks.has(order.id)) continue;
      try {
        acquireOrderLock(order.id);
      } catch {
        continue;
      }

      const requestKey = `auto_accept_${order.id}_v${latestDelivery.version}`;
      try {
        const freshOrder = await store.getOrder(order.id);
        if (!freshOrder || freshOrder.status !== 'delivered') {
          continue;
        }
        if (Array.isArray(freshOrder.revisions) && freshOrder.revisions.some(rev => rev.status === 'requested')) {
          continue;
        }

        const result = await releaseOrderFunds(freshOrder, 'System Auto-Accept', `Auto-accept after buyer review window (${days} days) elapsed`, false, requestKey);
        freshOrder.acceptedVersion = latestDelivery.version;
        await store.saveOrder(freshOrder);

        const sysMsg: Message = {
          id: `msg_${randomUUID()}`,
          orderId: freshOrder.id,
          senderId: 'system',
          senderName: 'WorkPerHour System',
          text: `🎉 Deliverables automatically accepted: Buyer review window (${days} days) closed without revisions or dispute. Escrow funds released to seller.`,
          timestamp: new Date(now).toISOString(),
          type: 'system',
          metadata: {
            action: 'order_auto_accepted',
            acceptedVersion: latestDelivery.version,
            reviewWindowDays: days
          }
        };
        await recordMessage(sysMsg);

        const autoLog: AuditLog = {
          id: 'log_' + randomUUID(),
          actor: 'System Auto-Accept',
          role: 'system',
          action: 'ORDER_AUTO_ACCEPTED',
          target: `Order #${freshOrder.id}`,
          details: `Auto-accepted deliverables (version ${latestDelivery.version}) after ${days}-day buyer review window expired`,
          timestamp: new Date(now).toISOString()
        };
        registerAuditLog(autoLog);

        processed.push({
          orderId: freshOrder.id,
          acceptedVersion: latestDelivery.version,
          amount: freshOrder.amount,
          freelancerNet: result.freelancerNet
        });
      } catch (err: any) {
        console.error(`[ReviewWindow] Failed to auto-accept order ${order.id}:`, err);
      } finally {
        releaseOrderLock(order.id);
      }
    }
  } catch (err) {
    console.error('[processAutoAcceptOrders] Query error:', err);
  }

  return processed;
}

export async function atomicUpdateOrder(orderId: string, updates: Record<string, any>, allowedStatuses: string[]): Promise<boolean> {
  const pool = postgresStore.getPool();
  const keys = Object.keys(updates);
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map(k => updates[k]);
  
  const query = `
    UPDATE orders 
    SET ${setClause}
    WHERE id = $1 AND status = ANY($${keys.length + 2})
  `;
  const res = await pool.query(query, [orderId, ...values, allowedStatuses]);
  return res.rowCount !== null && res.rowCount > 0;
}
