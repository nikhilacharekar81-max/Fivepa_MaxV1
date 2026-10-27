import { Router, Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import {
  DEFAULT_SITE_SETTINGS,
  store,
  type ExtensionRequest,
  type Message,
  type Dispute,
  type Order,
  type User,
  type WorkstreamOffer
} from '../store.js';
import { calculateOrderFees } from '../domains/finance/fees.js';
import { checkOrRecordIdempotency, recordIdempotencyResult } from '../domains/finance/index.js';
import { postgresStore } from '../db/postgresStore.js';
import { financialRepository } from '../services/financialService.js';
import {
  requireAuth,
  requireActiveStatus,
  requireRole,
  requireAdmin,
  adminActor,
  rateLimit,
  resolveAuthenticatedUserId,
  safeUser,
  orderParticipantSafeUser,
  isStaffUser,
  formatApiError
} from '../middleware/auth.js';
import {
  tryAcquireOrderLock,
  releaseOrderLock,
  recordOrder,
  resolveGigOrderPrice,
  enrichOrderWithServiceInfo,
  releaseOrderFunds,
  refundOrderFunds,
  splitOrderFunds,
  fundOrderEscrowWithEvent,
  syncUserBalances,
  ensureWallet,
  registerAuditLog,
  getActiveEscrowRemaining,
  LATE_ORDER_PROTECTION_HOURS
} from '../services/orderService.js';
import { broadcastMessage } from '../websocket.js';
import {
  createNotification,
  sendOrderEmail,
  notifyOrderParties
} from '../services/notificationService.js';
import {
  recordMessage,
  emitSystemEvent,
  pushSystemMessage
} from '../services/messagingService.js';
import { closeActiveDispute } from '../services/disputeService.js';
import {
  orderHasEscrow,
  viewOffer,
  postOfferMessage,
  validateStoredWorkstreamFiles,
  cancelPendingOffersForOrder,
  generateCollisionSafeOfferNumber
} from '../services/workstreamService.js';
import { workspaceService } from '../../src/server/workspaceService.js';
import { handleSubmitReview } from './reviewRoutes.js';

function escapeHtml(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const router = Router();

// Orders List - Directly querying PostgreSQL
router.get('/orders', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  try {
    const authUserId = resolveAuthenticatedUserId(req)!;
    const caller = await store.getUser(authUserId);
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin' || caller?.role === 'support';

    const ordersList = isAdmin ? await store.listOrders() : await store.listOrdersForUser(authUserId);
    const orderIds = ordersList.map(o => o.id);
    const userIds = Array.from(new Set(ordersList.flatMap(o => [o.buyerId, o.sellerId]).filter(Boolean)));

    if (ordersList.length === 0) {
      return res.json([]);
    }

    const pool = postgresStore.getPool();
    const [usersList, latestMsgsRes] = await Promise.all([
      userIds.length > 0
        ? Promise.all(userIds.map(id => store.getUser(id)))
        : Promise.resolve([]),
      orderIds.length > 0
        ? pool.query(`
            SELECT DISTINCT ON (order_id) order_id, text, timestamp
            FROM messages
            WHERE order_id = ANY($1)
            ORDER BY order_id, timestamp DESC
          `, [orderIds])
        : Promise.resolve({ rows: [] as any[] })
    ]);

    const userMap = new Map((usersList.filter(Boolean) as User[]).map(u => [u.id, u]));
    const latestMsgMap = new Map((latestMsgsRes.rows as any[]).map(m => [m.order_id, m]));

    const userOrders: Order[] = ordersList.map(order => {
      const buyerUser = userMap.get(order.buyerId);
      const sellerUser = userMap.get(order.sellerId);
      const lastMsg = latestMsgMap.get(order.id);
      return {
        ...order,
        sellerUsername: order.sellerUsername || sellerUser?.username || undefined,
        buyerUsername: order.buyerUsername || buyerUser?.username || undefined,
        sellerName: sellerUser?.name || order.sellerUsername || 'Seller',
        sellerAvatar: sellerUser?.avatar || '',
        buyerName: buyerUser?.name || order.buyerUsername || 'Buyer',
        buyerAvatar: buyerUser?.avatar || '',
        buyer: buyerUser ? (isAdmin ? safeUser(buyerUser) : orderParticipantSafeUser(buyerUser)) : undefined,
        seller: sellerUser ? (isAdmin ? safeUser(sellerUser) : orderParticipantSafeUser(sellerUser)) : undefined,
        lastMessage: lastMsg?.text || undefined,
        lastMessageTime: lastMsg?.timestamp ? new Date(lastMsg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined,
      };
    });

    res.json(userOrders.map(o => enrichOrderWithServiceInfo(o, isAdmin)));
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to list orders'));
  }
});

// Single Order Workspace Detail - Directly querying PostgreSQL
router.get('/orders/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const authUserId = resolveAuthenticatedUserId(req)!;
    const caller = await store.getUser(authUserId);
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && order.buyerId !== authUserId && order.sellerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Access to this order is restricted to participants.' });
    }

    const enriched = enrichOrderWithServiceInfo(order, isAdmin);
    const [buyer, seller, orderMessages, dispute] = await Promise.all([
      store.getUser(order.buyerId),
      store.getUser(order.sellerId),
      store.listMessages(order.id),
      store.getDisputeByOrderId(order.id)
    ]);

    res.json({
      ...enriched,
      buyer: buyer ? (isAdmin ? safeUser(buyer) : orderParticipantSafeUser(buyer)) : null,
      seller: seller ? (isAdmin ? safeUser(seller) : orderParticipantSafeUser(seller)) : null,
      messages: orderMessages,
      dispute
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to get order details'));
  }
});

// Create Order / Inquiry
router.post('/orders', requireAuth, requireActiveStatus, rateLimit(30, 60_000), async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  if (caller.status === 'restricted') {
    return res.status(403).json({ error: 'Restricted: You cannot purchase new services while your account is restricted.' });
  }

  try {
    const authUserId = (req as any).authenticatedUserId;
    const userCaller = (req as any).authenticatedUser || (await store.getUser(authUserId));
    if (!userCaller || (userCaller.status !== 'active' && userCaller.status !== 'restricted')) {
      return res.status(403).json({ error: 'Account is not active' });
    }

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (title.length < 3) return res.status(400).json({ error: 'A valid order title is required.' });
    const isAdminCaller = userCaller.role === 'admin' || userCaller.role === 'super_admin';
    const requestedBuyerId = isAdminCaller && typeof req.body?.buyerId === 'string' && req.body.buyerId.trim()
      ? req.body.buyerId.trim()
      : userCaller.id;
    const buyer = requestedBuyerId === userCaller.id ? userCaller : await store.getUser(requestedBuyerId);
    if (!buyer) return res.status(404).json({ error: 'Buyer account not found.' });
    const buyerId = buyer.id;
    const sellerId = String(req.body?.sellerId || '');

    const seller = await store.getUser(sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found.' });
    if (buyerId === sellerId) return res.status(400).json({ error: 'You cannot order from yourself.' });

    await ensureWallet(buyerId);
    await ensureWallet(sellerId);
    if (buyer.status !== 'active' || seller.status !== 'active') {
      return res.status(403).json({ error: 'Both accounts must be active to place an order.' });
    }

    if (req.body?.gigId && req.body?.projectId) {
      return res.status(400).json({ error: 'Order cannot specify both gigId and projectId.' });
    }

    let rawAmount = Number(req.body?.amount);
    const isInquiry = rawAmount === 0 && /^inquiry:/i.test(title);

    const rawIdempKey = String(
      req.headers['idempotency-key'] ||
      req.headers['x-idempotency-key'] ||
      req.body?.idempotencyKey ||
      req.body?.requestKey ||
      req.body?.clientRequestId ||
      ''
    ).trim();

    const isPaidGig = Boolean(req.body?.gigId) && !isInquiry;
    if (isPaidGig && !rawIdempKey) {
      return res.status(400).json({ error: 'Idempotency-Key header is required for paid Gig purchase requests.' });
    }

    const scopedIdempKey = rawIdempKey ? `ORD-CREATE:${buyerId}:${rawIdempKey}` : '';

    const id = scopedIdempKey
      ? 'ord_' + createHash('sha256').update(scopedIdempKey).digest('hex').slice(0, 12)
      : 'ord_' + randomUUID().slice(0, 12);
    const today = new Date().toISOString().split('T')[0];

    if (req.body?.gigId) {
      if (!isInquiry) {
        const { gig: gigRow, gigPrice } = await resolveGigOrderPrice(req.body.gigId, req.body?.extraIds);
        if (gigRow.freelancer_id !== sellerId) {
          return res.status(400).json({ error: 'This gig does not belong to the selected seller.' });
        }
        rawAmount = gigPrice;
      } else {
        const gig = await store.getGig(req.body.gigId);
        if (!gig) return res.status(404).json({ error: 'Gig not found.' });
        if (gig.freelancerId !== sellerId && (gig as any).sellerId !== sellerId) {
          return res.status(400).json({ error: 'This gig does not belong to the selected seller.' });
        }
      }
    } else if (req.body?.projectId) {
      const proj = await store.getProject(req.body.projectId);
      if (!proj) return res.status(404).json({ error: 'Project not found.' });
      const projOwner = (proj as any).clientId || proj.buyerId;
      if (projOwner !== buyerId) {
        return res.status(403).json({ error: 'Only the project owner can create an order for this project.' });
      }

      if (!isInquiry) {
        let proposalQuery = `SELECT * FROM proposals WHERE project_id = $1 AND freelancer_id = $2 AND status = 'accepted'`;
        const proposalParams: any[] = [req.body.projectId, sellerId];
        if (req.body?.proposalId) {
          proposalQuery += ` AND id = $3`;
          proposalParams.push(req.body.proposalId);
        }
        proposalQuery += ` ORDER BY created_at DESC LIMIT 1`;
        const propRes = await postgresStore.getPool().query(proposalQuery, proposalParams);
        if (propRes.rows.length === 0) {
          return res.status(400).json({ error: 'No valid proposal found for this freelancer on the specified project.' });
        }
        const proposal = propRes.rows[0];
        rawAmount = Number(proposal.bid_amount);
      } else {
        const sellerUser = await store.getUser(sellerId);
        if (!sellerUser) {
          return res.status(400).json({ error: 'Selected seller not found.' });
        }
      }
    }

    if (!isInquiry) {
      if (!Number.isFinite(rawAmount) || rawAmount < 1.00) {
        return res.status(400).json({ error: 'Minimum order amount is $1.00.' });
      }
    }

    const orderPayloadFingerprint = {
      buyerId,
      sellerId,
      title,
      gigId: req.body?.gigId || null,
      projectId: req.body?.projectId || null,
      proposalId: req.body?.proposalId || null,
      extraIds: Array.isArray(req.body?.extraIds) ? [...req.body.extraIds].map(String).sort() : null,
      amount: isInquiry ? 0 : rawAmount,
      isInquiry
    };

    const requirements = typeof req.body?.requirements === 'string' ? escapeHtml(req.body.requirements.trim()).slice(0, 2000) : '';

    let deliveryDays = 10;
    if (req.body?.gigId) {
      const gig = await store.getGig(req.body.gigId);
      if (gig && Number(gig.deliveryDays) > 0) {
        deliveryDays = Math.max(1, Math.min(365, Number(gig.deliveryDays)));
      }
    } else if (req.body?.projectId) {
      const proj = await store.getProject(req.body.projectId);
      if (proj && Number(proj.deadlineDays) > 0) {
        deliveryDays = Math.max(1, Math.min(365, Number(proj.deadlineDays)));
      }
    }
    const serverDerivedDueDate = new Date(Date.now() + deliveryDays * 86400000).toISOString().split('T')[0];

    const isGig = Boolean(req.body?.gigId);
    const isProject = Boolean(req.body?.projectId);
    const orderType: 'gig' | 'project' | undefined = isGig ? 'gig' : (isProject ? 'project' : undefined);
    const gigOrderId = isGig ? id : undefined;
    const projectOrderId = isProject ? id : undefined;

    let workspaceId: string;
    if (isGig) {
      const ws = await workspaceService.createWorkspaceAsync({
        buyerId,
        sellerId,
        originType: 'gig',
        originId: req.body?.gigId || id,
        activeOrderId: id
      });
      workspaceId = ws.workspaceId;
    } else if (req.body?.workspaceId) {
      const ws = await workspaceService.getWorkspaceAsync(req.body.workspaceId);
      if (!ws) return res.status(404).json({ error: 'Workspace not found.' });
      if (ws.buyerId !== buyerId || ws.sellerId !== sellerId) {
        return res.status(400).json({ error: 'The provided workspace does not match the buyer and seller of this order.' });
      }
      workspaceId = ws.workspaceId;
    } else {
      const ws = await workspaceService.createWorkspaceAsync({
        buyerId,
        sellerId,
        originType: isProject ? 'project' : 'gig',
        originId: req.body?.projectId || id,
        activeOrderId: id
      });
      workspaceId = ws.workspaceId;
    }

    let newOrd: Order;
    if (isInquiry) {
      newOrd = {
        id,
        workspaceId,
        ...(orderType ? { orderType } : {}),
        ...(gigOrderId ? { gigOrderId } : {}),
        ...(projectOrderId ? { projectOrderId } : {}),
        title,
        buyerId,
        sellerId,
        amount: 0,
        status: 'in_progress',
        createdAt: today,
        dueDate: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
        gigId: req.body.gigId,
        projectId: req.body.projectId,
        ...(requirements ? { requirements } : {})
      };
    } else {
      newOrd = {
        id,
        workspaceId,
        ...(orderType ? { orderType } : {}),
        ...(gigOrderId ? { gigOrderId } : {}),
        ...(projectOrderId ? { projectOrderId } : {}),
        title,
        buyerId,
        sellerId,
        amount: rawAmount,
        status: 'payment_pending',
        createdAt: today,
        dueDate: serverDerivedDueDate,
        escrowProtectionStartDate: today,
        escrowProtectionEndDate: new Date(Date.now() + DEFAULT_SITE_SETTINGS.commission.escrowProtectionDays * 86400000).toISOString().split('T')[0],
        gigId: req.body.gigId,
        projectId: req.body.projectId,
        feeBreakdown: calculateOrderFees(rawAmount),
        ...(requirements ? { requirements } : {})
      };
    }

    const txResult = await postgresStore.executeInTransaction(async (client) => {
      if (scopedIdempKey) {
        const idempCheck = await checkOrRecordIdempotency(client, scopedIdempKey, 'createOrder', orderPayloadFingerprint);
        if (idempCheck.replayed) {
          return { replayed: true, result: idempCheck.result };
        }
      }

      await workspaceService.ensureWorkspaceForOrderAsync(newOrd);
      const enriched = enrichOrderWithServiceInfo(newOrd);
      await recordOrder(enriched);
      await store.saveOrder(enriched);

      if (!isInquiry) {
        try {
          await fundOrderEscrowWithEvent({
            orderId: id,
            orderTitle: title,
            amount: rawAmount,
            buyerId,
            sellerId,
            actor: `user:${buyerId}`,
            idempotencyKey: scopedIdempKey ? `${scopedIdempKey}:fund` : undefined
          });

          enriched.status = 'funded_in_escrow';
          await store.saveOrder(enriched);
          await syncUserBalances();
        } catch (fundingErr: any) {
          throw new Error(fundingErr.message || 'Failed to fund escrow.');
        }
      }

      if (scopedIdempKey) {
        await recordIdempotencyResult(client, scopedIdempKey, 'createOrder', enriched, orderPayloadFingerprint);
      }

      return { replayed: false, result: enriched };
    });

    if (txResult.replayed) {
      return res.status(201).json(txResult.result);
    }

    const enriched = txResult.result;

    if (isInquiry) {
      await emitSystemEvent(newOrd.id, 'order_created', `Inquiry thread opened: ${title}.`);
    } else {
      await emitSystemEvent(newOrd.id, 'order_created', `Order placed: ${title}. Payment is held in escrow until the work is approved.`);
      if (requirements) {
        const reqMsg: Message = {
          id: 'msg_' + Date.now() + '_req_' + Math.random().toString(36).slice(2, 6),
          orderId: id,
          senderId: buyer.id,
          senderName: buyer.name,
          type: 'message',
          text: `Project requirements: ${requirements}`,
          timestamp: new Date(Date.now() + 1).toISOString(),
          metadata: { action: 'requirements_logged' }
        };
        await recordMessage(reqMsg);
      }
    }

    res.status(201).json(enriched);
  } catch (err: any) {
    const msg = String(err?.message || 'Failed to create order');
    const status = err?.status || (/conflict|idempotency/i.test(msg) ? 409 : 400);
    res.status(status).json({ error: msg });
  }
});

// Extend Order Deadline (Admin)
const handleOrderExtendTime = async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;
  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (['completed', 'cancelled', 'refunded'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot extend deadline: Order is already ${order.status}.` });
    }

    const { days, newDueDate, reason } = req.body;
    const oldDate = order.dueDate;
    let targetDate = newDueDate;

    if (days && Number(days) > 0) {
      const current = new Date(order.dueDate || Date.now());
      current.setDate(current.getDate() + Number(days));
      targetDate = current.toISOString().split('T')[0];
    } else if (!targetDate) {
      targetDate = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];
    }

    order.dueDate = targetDate;
    await postgresStore.getPool().query('UPDATE orders SET due_date = $1 WHERE id = $2', [targetDate, order.id]);

    const sysMsg: Message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      orderId: order.id,
      senderId: 'system',
      senderName: 'System / Admin Notice',
      text: `⏱️ Deadline extended from ${oldDate} to ${order.dueDate}. ${reason ? 'Reason: ' + reason : 'Admin approved time extension.'}`,
      timestamp: new Date().toISOString(),
      type: 'system',
      metadata: { action: 'order_deadline_extended', oldDate, newDueDate: order.dueDate, reason } as any
    };

    await recordMessage(sysMsg);

    registerAuditLog({
      id: 'log_' + randomUUID(),
      actor: adminActor(req),
      role: (req as any).authenticatedUser?.role || 'admin',
      action: 'ORDER_DEADLINE_EXTENDED',
      target: `Order #${order.id}`,
      details: `Extended deadline to ${order.dueDate} (${days || 'custom'} days). ${reason || ''}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, order: enrichOrderWithServiceInfo(order), message: sysMsg });
  } finally {
    releaseOrderLock(orderId);
  }
};
router.patch('/orders/:id/extend-time', requireAdmin, handleOrderExtendTime);
router.patch('/admin/orders/:id/extend-time', requireAdmin, handleOrderExtendTime);

// Request Delivery Extension (Seller)
router.post('/orders/:id/extension-request', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const userId = (req as any).authenticatedUserId;
    if (userId !== order.sellerId) return res.status(403).json({ error: 'Only the seller can request more time.' });
    if (['completed', 'cancelled', 'disputed', 'payment_pending'].includes(order.status)) {
      return res.status(409).json({ error: 'Cannot request an extension for this order.' });
    }

    if (order.extensionRequests) {
      for (const r of order.extensionRequests) {
        if (r.status === 'pending' && r.responseDeadline && new Date().getTime() >= new Date(r.responseDeadline).getTime()) {
          r.status = 'expired';
        }
      }
    }

    const pending = order.extensionRequests?.find(r => r.status === 'pending');
    if (pending) return res.json({ request: pending });
    if (order.freeExtensionUsed) return res.status(409).json({ error: 'Free extension already used.' });

    const { days, reason } = req.body;
    const numDays = Number(days);
    if (!Number.isInteger(numDays) || numDays < 1 || numDays > 14) return res.status(400).json({ error: 'Days must be 1-14.' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required.' });

    const newRequest: ExtensionRequest = {
      id: 'ext_' + randomUUID().slice(0, 12),
      requestedBy: 'seller',
      days: numDays,
      reason: reason.trim(),
      originalDueDate: order.dueDate,
      requestedDueDate: new Date(new Date(order.dueDate).getTime() + numDays * 86400000).toISOString().split('T')[0],
      requestedAt: new Date().toISOString(),
      responseDeadline: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      status: 'pending'
    };

    if (!order.extensionRequests) order.extensionRequests = [];
    order.extensionRequests.push(newRequest);
    const extUpdated = await store.updateOrderStatus(
      order.id,
      { extension_requests: JSON.stringify(order.extensionRequests) },
      ['funded_in_escrow', 'in_progress', 'delivered', 'revision', 'draft_review', 'work_in_progress']
    );
    if (!extUpdated) {
      return res.status(409).json({ error: 'Order status changed concurrently; cannot request an extension.' });
    }

    const sysMsg: Message = {
      id: `msg_${randomUUID()}`,
      orderId: order.id,
      senderId: 'system',
      senderName: 'System',
      text: 'System: The seller requested additional delivery time. Please review the extension request.',
      timestamp: new Date().toISOString(),
      type: 'system',
      metadata: { action: 'time_extension_requested' } as any
    };

    await recordMessage(sysMsg);

    createNotification({
      userId: order.buyerId,
      type: 'order',
      title: 'Time Extension Requested',
      message: `The seller requested ${numDays} more days.`,
      link: `/workstream/${order.id}`
    });

    res.json({ request: newRequest });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Respond to Extension Request (Buyer)
router.post('/orders/:id/extension-request/respond', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const userId = (req as any).authenticatedUserId;
    if (userId !== order.buyerId) return res.status(403).json({ error: 'Only the buyer can respond.' });
    const request = order.extensionRequests?.find(r => r.status === 'pending');
    if (!request) return res.status(404).json({ error: 'No pending request.' });

    if (request.responseDeadline && new Date() > new Date(request.responseDeadline)) {
      request.status = 'expired';
      await postgresStore.getPool().query(
        'UPDATE orders SET extension_requests = $1 WHERE id = $2',
        [JSON.stringify(order.extensionRequests), order.id]
      );

      const expireMsg: Message = {
        id: `msg_${randomUUID()}`,
        orderId: order.id,
        senderId: 'system',
        senderName: 'System',
        text: 'System: The delivery extension request has expired without a response.',
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'time_extension_expired' } as any
      };
      await recordMessage(expireMsg);

      return res.status(410).json({ error: 'This extension request has expired.' });
    }

    const { action, reason } = req.body;
    const allowedExtRespondStatuses = ['funded_in_escrow', 'in_progress', 'delivered', 'revision', 'draft_review', 'work_in_progress'];
    if (action === 'approve') {
      request.status = 'approved';
      request.respondedBy = userId;
      request.respondedAt = new Date().toISOString();
      request.resultingDueDate = request.requestedDueDate;
      order.dueDate = request.requestedDueDate;
      order.freeExtensionUsed = true;
      const updated = await store.updateOrderStatus(
        order.id,
        {
          extension_requests: JSON.stringify(order.extensionRequests),
          due_date: order.dueDate,
          free_extension_used: true
        },
        allowedExtRespondStatuses
      );
      if (!updated) {
        return res.status(409).json({ error: 'Order status changed concurrently; cannot approve extension.' });
      }

      const sysMsg: Message = {
        id: `msg_${randomUUID()}`,
        orderId: order.id,
        senderId: 'system',
        senderName: 'System',
        text: 'System: The delivery extension was approved. The deadline has been updated.',
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'time_extension_approved' } as any
      };
      await recordMessage(sysMsg);
      createNotification({ userId: order.sellerId, type: 'order', title: 'Extension Approved', message: 'The buyer approved the extension.', link: `/workstream/${order.id}` });
    } else if (action === 'reject') {
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required.' });
      request.status = 'rejected';
      request.rejectionReason = reason.trim();
      request.respondedBy = userId;
      request.respondedAt = new Date().toISOString();
      const updated = await store.updateOrderStatus(
        order.id,
        { extension_requests: JSON.stringify(order.extensionRequests) },
        allowedExtRespondStatuses
      );
      if (!updated) {
        return res.status(409).json({ error: 'Order status changed concurrently; cannot reject extension.' });
      }

      const sysMsg: Message = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        orderId: order.id,
        senderId: 'system',
        senderName: 'System',
        text: 'System: The delivery extension was rejected. The original deadline remains unchanged.',
        timestamp: new Date().toISOString(),
        type: 'system',
        metadata: { action: 'time_extension_rejected' } as any
      };
      await recordMessage(sysMsg);
      createNotification({ userId: order.sellerId, type: 'order', title: 'Extension Rejected', message: 'The buyer rejected the extension.', link: `/workstream/${order.id}` });
    } else {
      return res.status(400).json({ error: 'Invalid action.' });
    }

    res.json({ success: true, order: enrichOrderWithServiceInfo(order) });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Admin Private Notes
const handleOrderAdminNotes = async (req: Request, res: Response) => {
  const order = await store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.adminNotes = req.body.notes || '';
  await postgresStore.getPool().query('UPDATE orders SET admin_notes = $1 WHERE id = $2', [order.adminNotes, order.id]);
  res.json({ success: true, adminNotes: order.adminNotes });
};
router.post('/orders/:id/admin-notes', requireAdmin, handleOrderAdminNotes);
router.post('/admin/orders/:id/admin-notes', requireAdmin, handleOrderAdminNotes);

// Upload Deliverable
router.post('/orders/:id/deliverable', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const authUserId = (req as any).authenticatedUserId;
    const caller = await store.getUser(authUserId);
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && order.sellerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only the seller or an administrator can submit deliverables.' });
    }

    const allowedStatuses = ['funded_in_escrow', 'in_progress', 'revision', 'draft_review', 'delivered', 'work_in_progress', 'late'];
    if (!allowedStatuses.includes(order.status)) {
      return res.status(409).json({ error: `Cannot submit a deliverable for an order in "${order.status}" status.` });
    }
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot submit a deliverable for a completed order.' });
    }

    if (!order.deliverableFiles) order.deliverableFiles = [];
    if (!order.deliveryHistory) order.deliveryHistory = [];

    const rawFiles = Array.isArray(req.body.files) && req.body.files.length > 0 
      ? req.body.files 
      : (req.body.name ? [{ name: req.body.name, size: req.body.size, url: req.body.url }] : []);

    const rawNotes = typeof req.body.notes === 'string' ? req.body.notes
      : (typeof req.body.message === 'string' ? req.body.message : '');
    const rawReference = typeof req.body.reference === 'string' ? req.body.reference
      : (typeof req.body.referenceUrl === 'string' ? req.body.referenceUrl
      : (!req.body.name && typeof req.body.url === 'string' ? req.body.url : ''));
    const trimmedNotes = rawNotes.trim();
    const trimmedReference = rawReference.trim();

    if (rawFiles.length === 0 && !trimmedNotes && !trimmedReference) {
      return res.status(400).json({ error: 'Add a file, a URL/reference, or a written completion message to submit a delivery.' });
    }

    let validatedFiles: Array<{ name: string; size: string; url: string }> = [];
    if (rawFiles.length > 0) {
      const validation = await validateStoredWorkstreamFiles(rawFiles, caller, order.id);
      if (!validation.ok) {
        return res.status((validation as any).status || 400).json({ error: (validation as any).error });
      }
      validatedFiles = validation.files;
    }

    const isDraft = Boolean(req.body.isDraft);
    const uploadedFiles = validatedFiles.map((f: any, idx: number) => ({
      id: 'deliv_' + Date.now() + '_' + idx,
      name: f.name,
      size: f.size,
      url: f.url,
      uploadedAt: new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
      type: isDraft ? 'draft' : 'deliverable'
    }));

    const version = order.deliveryHistory.length + 1;
    const deliveredAt = new Date().toISOString();
    const projectResponseDeadline = order.orderType === 'project'
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    order.deliveryHistory.push({
      version,
      notes: trimmedNotes,
      reference: trimmedReference || undefined,
      files: uploadedFiles,
      deliveredAt,
      ...(projectResponseDeadline ? { responseDeadline: projectResponseDeadline } : {})
    });
    if (projectResponseDeadline) {
      order.responseDeadline = projectResponseDeadline;
    }

    let resolvedRevisionCount = 0;
    if (order.revisions && order.revisions.length > 0) {
      for (const rev of order.revisions) {
        if (rev.status === 'requested') {
          rev.status = 'resolved';
          resolvedRevisionCount++;
        }
      }
    }

    if (resolvedRevisionCount > 0) {
      await emitSystemEvent(order.id, 'revision_resolved', `📝 Revision resolved via Delivery #v${version}.`, {
        deliveryVersion: version
      });
    }

    const summaryParts: string[] = [];
    if (uploadedFiles.length > 0) summaryParts.push(uploadedFiles.map((f: any) => `"${f.name}" (${f.size})`).join(', '));
    if (trimmedReference) summaryParts.push(`Reference: ${trimmedReference}`);
    const fileSummary = summaryParts.length > 0 ? summaryParts.join(' | ') : 'written completion update';

    await emitSystemEvent(
      order.id,
      'deliverable_submitted',
      isDraft
        ? `📦 Draft Delivery #v${version} submitted (${fileSummary}).`
        : `📦 Delivery / Final Invoice #v${version} submitted (${fileSummary}).`,
      {
        version,
        isDraft,
        notes: trimmedNotes,
        reference: trimmedReference || undefined,
        files: uploadedFiles
      }
    );

    let createdInvoiceOffer: any = undefined;
    if (!isDraft && req.body.createInvoiceOffer && (await orderHasEscrow(order.id))) {
      const activeEsc = await getActiveEscrowRemaining(order);
      const requestedAmt = Math.round(Number(req.body.invoiceAmount || activeEsc || order.amount || 0) * 100) / 100;
      const invAmt = requestedAmt >= activeEsc && requestedAmt > 0 ? requestedAmt : (activeEsc || Number(order.amount || 0));
      const invTitle = (typeof req.body.invoiceTitle === 'string' && req.body.invoiceTitle.trim().length >= 3)
        ? req.body.invoiceTitle.trim().slice(0, 120)
        : `Final Invoice: ${order.title}`.slice(0, 120);

      const existingRes = await postgresStore.getPool().query(
        "SELECT * FROM workstream_offers WHERE order_id = $1 AND kind = 'invoice' AND status = 'pending'",
        [order.id]
      );
      if (existingRes.rows.length > 0) {
        const row = existingRes.rows[0];
        const prevMeta = row.metadata || {};
        const updatedMeta = {
          ...prevMeta,
          note: trimmedNotes || prevMeta.note,
          files: uploadedFiles.length > 0 ? uploadedFiles : prevMeta.files,
          reference: trimmedReference || prevMeta.reference
        };
        await postgresStore.getPool().query(
          `UPDATE workstream_offers 
           SET title = $1, amount = $2, metadata = $3 
           WHERE id = $4`,
          [invTitle, invAmt, JSON.stringify(updatedMeta), row.id]
        );
        createdInvoiceOffer = await viewOffer({
          id: row.id,
          number: row.number,
          orderId: row.order_id,
          kind: row.kind,
          title: invTitle,
          amount: invAmt,
          note: updatedMeta.note,
          files: updatedMeta.files,
          reference: updatedMeta.reference,
          status: row.status,
          createdBy: row.created_by,
          createdAt: row.created_at
        });
      } else if (invAmt > 0) {
        const invNum = generateCollisionSafeOfferNumber('invoice');
        const newInvId = 'off_' + randomUUID().slice(0, 12);
        const meta = {
          note: trimmedNotes || undefined,
          files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
          reference: trimmedReference || undefined
        };
        await postgresStore.getPool().query(
          `INSERT INTO workstream_offers (id, order_id, kind, number, title, amount, status, created_by, created_at, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [newInvId, order.id, 'invoice', invNum, invTitle, invAmt, 'pending', caller?.id || order.sellerId, new Date().toISOString(), JSON.stringify(meta)]
        );
        const newInv: WorkstreamOffer = {
          id: newInvId,
          number: invNum,
          orderId: order.id,
          kind: 'invoice',
          title: invTitle,
          amount: invAmt,
          note: meta.note,
          files: meta.files,
          reference: meta.reference,
          status: 'pending',
          createdBy: caller?.id || order.sellerId,
          createdAt: new Date().toISOString()
        };
        await postOfferMessage(order, newInv, { id: caller?.id || order.sellerId, name: caller?.name || 'Seller' }, `New invoice ${newInv.number}: ${invTitle}`, 'offer_created');
        createdInvoiceOffer = await viewOffer(newInv);
      }
    }

    const success = await store.updateOrderStatus(orderId, {
      status: isDraft ? 'draft_review' : 'delivered',
      deliverable_files: JSON.stringify(order.deliverableFiles),
      delivery_history: JSON.stringify(order.deliveryHistory),
      delivery_notes: trimmedNotes,
      delivery_reference: trimmedReference,
      revisions: JSON.stringify(order.revisions),
      response_deadline: order.responseDeadline || null
    }, allowedStatuses);

    if (!success) return res.status(409).json({ error: 'Order state changed concurrently. Please retry.' });

    res.json({ success: true, files: uploadedFiles, file: uploadedFiles[0], offer: createdInvoiceOffer, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Request Revision on Deliverable
router.post('/orders/:id/revision', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const authUserId = (req as any).authenticatedUserId;
    const caller = await store.getUser(authUserId);
    const isAdmin = caller?.role === 'admin' || caller?.role === 'super_admin';
    if (!isAdmin && order.buyerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only the order buyer or an administrator can request revisions.' });
    }

    const allowedRevisionStatuses = ['delivered', 'in_progress', 'funded_in_escrow', 'revision', 'draft_review', 'work_in_progress'];
    if (!allowedRevisionStatuses.includes(order.status)) {
      return res.status(409).json({ error: `Cannot request revisions for an order in "${order.status}" status.` });
    }

    const hasDelivery = (Array.isArray(order.deliverableFiles) && order.deliverableFiles.length > 0) || (Array.isArray(order.deliveryHistory) && order.deliveryHistory.length > 0) || ['delivered', 'revision', 'draft_review', 'work_in_progress'].includes(order.status);
    if (!hasDelivery) {
      return res.status(409).json({ error: 'Cannot request revisions before work or a draft has been delivered by the freelancer.' });
    }

    const rawReason = (req.body.reason || '').trim();
    if (!rawReason) {
      return res.status(400).json({ error: 'A revision reason is required.' });
    }
    const reason = escapeHtml(rawReason);
    if (!order.revisions) order.revisions = [];
    const revisionEntry = {
      id: 'rev_' + Date.now() + '_' + randomUUID().slice(0, 8),
      requestedAt: new Date().toISOString(),
      reason,
      status: 'requested',
      deliveryVersion: order.deliveryHistory?.length || 1
    };
    order.revisions.push(revisionEntry);
    order.status = 'revision';

    const revUpdated = await store.updateOrderStatus(
      order.id,
      { status: 'revision', revisions: JSON.stringify(order.revisions) },
      allowedRevisionStatuses
    );
    if (!revUpdated) {
      return res.status(409).json({ error: 'Order status changed concurrently; cannot request revisions.' });
    }

    await emitSystemEvent(order.id, 'revision_requested', `Revision requested: "${reason}"`, {
      revisionId: revisionEntry.id,
      deliveryVersion: revisionEntry.deliveryVersion
    });

    res.json({ success: true, revision: revisionEntry, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Participant (Buyer or Seller) Dispute Creation Flow
const handleOpenDispute = async (req: Request, res: Response) => {
  const orderId = String(req.params.id || req.body?.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const authUserId = (req as any).authenticatedUserId;
    if (order.buyerId !== authUserId && order.sellerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only order participants can open a dispute.' });
    }
    if (order.status === 'completed' || order.status === 'cancelled') {
      return res.status(409).json({ error: `Cannot open a dispute: this order is already ${order.status}.` });
    }
    if (order.status === 'disputed') {
      return res.status(409).json({ error: 'This order is already under dispute.' });
    }
    const disputeEscrow = await financialRepository.getEscrow(order.id);
    if (!disputeEscrow || disputeEscrow.status !== 'held' || disputeEscrow.remaining <= 0) {
      return res.status(409).json({ error: 'Cannot open a dispute: there is no active escrow held for this order.' });
    }
    const rawReason = (req.body.reason || '').trim().slice(0, 2000);
    if (!rawReason) {
      return res.status(400).json({ error: 'A dispute reason is required.' });
    }
    const reason = escapeHtml(rawReason);

    const existingDispute = await store.getDisputeByOrderId(order.id);
    if (existingDispute && (existingDispute.status === 'open' || existingDispute.status === 'under_investigation')) {
      return res.status(400).json({ error: 'An active dispute already exists for this order.' });
    }

    const newDisputeId = 'disp_' + Date.now() + '_' + randomUUID().slice(0, 8);
    const raisedBy = authUserId === order.buyerId ? 'buyer' : 'seller';
    const evidence = escapeHtml((req.body.evidence || '').slice(0, 5000));
    const createdAt = new Date().toISOString();

    const newDispute: Dispute = {
      id: newDisputeId,
      orderId: order.id,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      raisedBy,
      reason,
      evidence,
      status: 'open',
      createdAt
    };

    const allowedDisputeStatuses = ['funded_in_escrow', 'in_progress', 'delivered', 'revision', 'draft_review', 'work_in_progress'];
    const dispUpdated = await store.updateOrderStatus(order.id, { status: 'disputed' }, allowedDisputeStatuses);
    if (!dispUpdated) {
      return res.status(409).json({ error: 'Cannot open a dispute: order status changed concurrently.' });
    }
    await store.saveDispute(newDispute);
    order.status = 'disputed';

    const sysMsg: Message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      orderId: order.id,
      senderId: 'system',
      senderName: 'WorkSphere Dispute Resolution Desk',
      text: `🚨 Dispute opened by ${newDispute.raisedBy}: "${reason}". Order placed under review.`,
      timestamp: new Date().toISOString(),
      type: 'system',
      metadata: {
        action: 'dispute_opened',
        disputeId: newDispute.id,
        raisedBy: newDispute.raisedBy
      }
    };

    await recordMessage(sysMsg);
    notifyOrderParties(order.id, 'dispute_opened', sysMsg.text, sysMsg.id);

    res.json({ success: true, dispute: newDispute, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
};

router.post('/orders/:id/dispute', requireAuth, requireActiveStatus, handleOpenDispute);
router.post('/disputes/open', requireAuth, requireActiveStatus, handleOpenDispute);
router.post('/disputes', requireAuth, requireActiveStatus, handleOpenDispute);

// Toggle Chat Mute (Admin / Support)
const handleOrderMute = async (req: Request, res: Response) => {
  const order = await store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.isMuted = req.body?.isMuted !== undefined ? Boolean(req.body.isMuted) : !order.isMuted;
  await postgresStore.getPool().query('UPDATE orders SET is_muted = $1 WHERE id = $2', [order.isMuted, order.id]);

  const sysMsg: Message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId: order.id,
    senderId: 'system',
    senderName: 'Administration Alert',
    text: order.isMuted 
      ? `🔒 Chat paused by Administrator during case review. Neither party may send messages.`
      : `🔓 Chat unlocked by Administrator. Standard messaging resumed.`,
    timestamp: new Date().toISOString(),
    type: 'system',
    metadata: { action: order.isMuted ? 'chat_muted' : 'chat_unmuted' }
  };

  await recordMessage(sysMsg);

  res.json({ success: true, isMuted: order.isMuted });
};

router.patch('/orders/:id/mute', requireRole(['admin', 'super_admin', 'support']), handleOrderMute);
router.patch('/admin/orders/:id/mute', requireRole(['admin', 'super_admin', 'support']), handleOrderMute);

// Toggle Pause Order Timer (Admin / Support)
const handleOrderPauseTimer = async (req: Request, res: Response) => {
  const order = await store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.isTimerPaused = !order.isTimerPaused;
  await postgresStore.getPool().query('UPDATE orders SET is_timer_paused = $1 WHERE id = $2', [order.isTimerPaused, order.id]);

  const sysMsg: Message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    orderId: order.id,
    senderId: 'system',
    senderName: 'Administration Alert',
    text: order.isTimerPaused 
      ? `⏸️ Delivery countdown paused by Administrator pending dispute/clarification.`
      : `▶️ Delivery countdown resumed by Administrator. Normal timer active.`,
    timestamp: new Date().toISOString(),
    type: 'system',
    metadata: { action: order.isTimerPaused ? 'timer_paused' : 'timer_resumed' }
  };

  await recordMessage(sysMsg);

  registerAuditLog({
    id: 'log_' + Date.now(),
    actor: adminActor(req),
    role: (req as any).authenticatedUser?.role || 'admin',
    action: order.isTimerPaused ? 'ORDER_TIMER_PAUSED' : 'ORDER_TIMER_RESUMED',
    target: `Order #${order.id}`,
    details: order.isTimerPaused ? 'Timer paused by Admin' : 'Timer resumed by Admin',
    timestamp: new Date().toLocaleString()
  });

  res.json({ success: true, isTimerPaused: order.isTimerPaused, order: enrichOrderWithServiceInfo(order) });
};
router.patch('/orders/:id/pause-timer', requireRole(['admin', 'super_admin', 'support']), handleOrderPauseTimer);
router.patch('/admin/orders/:id/pause-timer', requireRole(['admin', 'super_admin', 'support']), handleOrderPauseTimer);

// Force Complete & Release Funds (admin only)
const handleOrderForceComplete = async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Order is already completed; funds were already released.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot force-complete a cancelled/refunded order.' });
    }

    const reason = String(req.body.reason || 'Admin administrative force-release in seller favor.');
    const result = await releaseOrderFunds(order, adminActor(req), reason, false, req.body.requestKey);
    await closeActiveDispute(order.id, 'resolved_release', reason);

    res.json({ success: true, order: enrichOrderWithServiceInfo(order), result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
};
router.post('/orders/:id/force-complete', requireAdmin, handleOrderForceComplete);
router.post('/admin/orders/:id/force-complete', requireAdmin, handleOrderForceComplete);

// Force Cancel & Refund Buyer (admin only)
const handleOrderForceCancel = async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot force-cancel an already completed order.' });
    }
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Order is already cancelled/refunded.' });
    }

    const reason = String(req.body.reason || 'Admin cancelled order and refunded buyer wallet');
    const isPartial = req.body.refundType === 'partial';
    let result: any;
    let refundAmount: number;

    if (isPartial) {
      refundAmount = Number(req.body.customAmount);
      result = await splitOrderFunds(order, refundAmount, adminActor(req), reason);
      await closeActiveDispute(order.id, 'resolved_partial', reason);
      await pushSystemMessage(order.id, `⚖️ Order resolved by Administration. $${refundAmount} refunded to buyer; the remainder was released to the freelancer. Reason: ${reason}`, 'dispute_resolved');
    } else {
      result = await refundOrderFunds(order, undefined, adminActor(req), reason, req.body.requestKey);
      refundAmount = result.refunded;
      await closeActiveDispute(order.id, 'resolved_refund', reason);
    }

    res.json({ success: true, order: enrichOrderWithServiceInfo(order), result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
};
router.post('/orders/:id/force-cancel', requireAdmin, handleOrderForceCancel);
router.post('/admin/orders/:id/force-cancel', requireAdmin, handleOrderForceCancel);

// Gig Cancellation Request
router.post('/orders/:id/cancel-request', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const userId = (req as any).authenticatedUserId;
    const caller = await store.getUser(userId);
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.orderType !== 'gig' && !order.gigOrderId) {
      return res.status(400).json({ error: 'Cancellation request flow is for gigs only.' });
    }
    if (order.status === 'completed' || order.status === 'cancelled' || order.status === 'disputed') {
      return res.status(400).json({ error: `Cannot request cancellation for order in status "${order.status}".` });
    }

    const isBuyer = userId === order.buyerId;
    const isSeller = userId === order.sellerId;
    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: 'Forbidden: Only buyer or seller can request cancellation.' });
    }
    if (order.cancellationRequest && order.cancellationRequest.status === 'pending') {
      return res.status(409).json({ error: 'A cancellation request is already pending for this order.' });
    }

    const { reason, details } = req.body;
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'Cancellation reason is required.' });
    }

    const now = new Date().toISOString();
    const respondBy = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const requestedBy = isBuyer ? 'buyer' : 'seller';

    order.cancellationRequest = {
      requestedBy,
      requesterId: userId,
      reason: reason.trim(),
      details: details ? String(details).trim() : undefined,
      requestedAt: now,
      respondBy,
      status: 'pending'
    };
    if (!order.cancellationHistory) order.cancellationHistory = [];
    order.cancellationHistory.push(order.cancellationRequest);

    const cancelReqUpdated = await store.updateOrderStatus(
      order.id,
      {
        cancellation_request: JSON.stringify(order.cancellationRequest),
        cancellation_history: JSON.stringify(order.cancellationHistory)
      },
      ['payment_pending', 'funded_in_escrow', 'in_progress', 'delivered', 'revision', 'draft_review', 'work_in_progress']
    );
    if (!cancelReqUpdated) {
      return res.status(409).json({ error: 'Order status changed concurrently; cannot submit cancellation request.' });
    }

    const recipientId = isBuyer ? order.sellerId : order.buyerId;
    createNotification({
      userId: recipientId,
      title: 'Cancellation Requested',
      message: `${requestedBy === 'buyer' ? 'Buyer' : 'Seller'} requested cancellation of order #${order.id}. Reason: ${reason}. You have 48 hours to respond.`,
      type: 'order',
      link: `/messages/${order.id}`
    });

    const requestsLast24h = (order.cancellationHistory || []).filter(h => Date.now() - new Date(h.requestedAt).getTime() < 24 * 3600 * 1000).length;
    if (requestsLast24h <= 2) {
      sendOrderEmail(
        recipientId,
        'Action needed: cancellation requested on your order',
        `${requestedBy === 'buyer' ? 'The buyer' : 'The seller'} asked to cancel order #${order.id}.\n\nReason: ${String(reason).trim().slice(0, 300)}\n\nYou have 48 hours to accept or decline. If you do not respond, the order is cancelled automatically and the payment is refunded.`,
        `/messages/${order.id}`
      );
    }

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller?.name || requestedBy,
      role: caller?.role || requestedBy,
      action: 'GIG_CANCELLATION_REQUESTED',
      target: `Order #${order.id}`,
      details: `${requestedBy} requested cancellation. Reason: ${reason}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

// Respond to Gig Cancellation Request
router.post('/orders/:id/cancel-request/respond', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const userId = (req as any).authenticatedUserId;
    const caller = await store.getUser(userId);
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.cancellationRequest || order.cancellationRequest.status !== 'pending') {
      return res.status(400).json({ error: 'No pending cancellation request found for this order.' });
    }

    const isBuyer = userId === order.buyerId;
    const isSeller = userId === order.sellerId;
    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (userId === order.cancellationRequest.requesterId) {
      return res.status(403).json({ error: 'You cannot respond to your own cancellation request.' });
    }

    const { action, reason } = req.body;
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be "accept" or "reject".' });
    }
    if (action === 'reject' && (!reason || !String(reason).trim())) {
      return res.status(400).json({ error: 'Rejection reason is required when rejecting a cancellation request.' });
    }

    const isExpired = Boolean(
      order.cancellationRequest.respondBy &&
      new Date() > new Date(order.cancellationRequest.respondBy)
    );
    if (isExpired && action === 'reject') {
      return res.status(400).json({
        error: 'The 48-hour response window for this cancellation request has expired and it can no longer be rejected.'
      });
    }

    const now = new Date().toISOString();
    order.cancellationRequest.respondedBy = userId;
    order.cancellationRequest.respondedAt = now;

    if (action === 'accept') {
      const actorName = caller?.name || (isBuyer ? 'Buyer' : 'Seller');
      const requestKey = `cancel_accept_${order.id}_${order.cancellationRequest.requestedAt}`;
      const refundRes = await refundOrderFunds(order, undefined, actorName, `Mutual cancellation accepted: ${order.cancellationRequest.reason}`, requestKey);
      order.cancellationRequest.status = 'accepted';

      await postgresStore.getPool().query(
        'UPDATE orders SET cancellation_request = $1, cancellation_history = $2 WHERE id = $3',
        [JSON.stringify(order.cancellationRequest), JSON.stringify(order.cancellationHistory || []), order.id]
      );

      createNotification({
        userId: order.cancellationRequest.requesterId,
        title: 'Cancellation Accepted',
        message: `Your cancellation request for order #${order.id} was accepted. Full refund issued ($${refundRes.refunded}).`,
        type: 'order',
        link: `/messages/${order.id}`
      });

      registerAuditLog({
        id: 'log_' + Date.now(),
        actor: actorName,
        role: caller?.role || 'user',
        action: 'GIG_CANCELLATION_ACCEPTED',
        target: `Order #${order.id}`,
        details: `Cancellation accepted. Full refund of $${refundRes.refunded} issued.`,
        timestamp: new Date().toLocaleString()
      });

      return res.json({ success: true, order: enrichOrderWithServiceInfo(order), refunded: refundRes.refunded });
    } else {
      order.cancellationRequest.status = 'rejected';
      order.cancellationRequest.rejectionReason = String(reason).trim();
      if (order.status === 'delivered') {
        order.reviewWindowRestartedAt = now;
      }

      const rejectUpdated = await store.updateOrderStatus(
        order.id,
        {
          cancellation_request: JSON.stringify(order.cancellationRequest),
          cancellation_history: JSON.stringify(order.cancellationHistory || []),
          review_window_restarted_at: order.reviewWindowRestartedAt || null
        },
        ['payment_pending', 'funded_in_escrow', 'in_progress', 'delivered', 'revision', 'draft_review', 'work_in_progress']
      );
      if (!rejectUpdated) {
        return res.status(409).json({ error: 'Order status changed concurrently; cannot reject cancellation request.' });
      }

      const actorName = caller?.name || (isBuyer ? 'Buyer' : 'Seller');
      createNotification({
        userId: order.cancellationRequest.requesterId,
        title: 'Cancellation Rejected',
        message: `Your cancellation request for order #${order.id} was rejected. Reason: ${reason}. Order continues normally.`,
        type: 'order',
        link: `/messages/${order.id}`
      });

      registerAuditLog({
        id: 'log_' + randomUUID(),
        actor: actorName,
        role: caller?.role || 'user',
        action: 'GIG_CANCELLATION_REJECTED',
        target: `Order #${order.id}`,
        details: `Cancellation rejected. Reason: ${reason}`,
        timestamp: new Date().toLocaleString()
      });

      return res.json({ success: true, order: enrichOrderWithServiceInfo(order) });
    }
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(orderId);
  }
});

const handleOrderCancel = async (req: Request, res: Response) => {
  const orderId = req.params.id;
  if (!tryAcquireOrderLock(orderId, res)) return;

  try {
    const order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const authUserId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || (authUserId ? await store.getUser(authUserId) : null);

    const isStaff = isStaffUser(caller);
    const isBuyer = authUserId === order.buyerId;
    const isSeller = authUserId === order.sellerId;

    if (!isStaff && !isBuyer && !isSeller) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant of this order.' });
    }

    if (order.status === 'completed' || order.status === 'cancelled' || (order.status as string) === 'refunded') {
      return res.status(400).json({ error: `Cannot cancel order with status "${order.status}". Cancellation is not allowed for completed, cancelled, or refunded orders.` });
    }

    const pool = postgresStore.getPool();
    const dispRes = await pool.query(
      "SELECT 1 FROM disputes WHERE order_id = $1 AND status IN ('open', 'under_review') LIMIT 1",
      [order.id]
    );
    if (!isStaff && dispRes.rows.length > 0) {
      return res.status(400).json({ error: 'Direct cancellation is blocked because an active dispute is open. Please resolve the dispute or contact support.' });
    }

    const hasFundedEscrow = await orderHasEscrow(order.id);
    const isGigOrder = order.orderType === 'gig' || Boolean(order.gigOrderId) || Boolean(order.gigId);

    if (!isStaff && order.status !== 'payment_pending') {
      if (isSeller) {
        if (isGigOrder && (hasFundedEscrow || ['funded_in_escrow', 'in_progress', 'delivered', 'revision', 'revision_requested'].includes(order.status))) {
          return res.status(400).json({
            error: 'Direct cancellation is not allowed for funded gig orders. Please submit a cancellation request (POST /api/orders/:id/cancel-request).'
          });
        }
        if (!isGigOrder && !['funded_in_escrow', 'in_progress'].includes(order.status)) {
          return res.status(400).json({
            error: `Seller cannot directly cancel a project order in "${order.status}" status.`
          });
        }
      } else if (isBuyer) {
        if (['delivered', 'revision', 'revision_requested', 'draft_review', 'disputed'].includes(order.status)) {
          return res.status(403).json({
            error: 'Cannot directly cancel an active or delivered order. Please request a revision, submit a cancellation request, or open a dispute.'
          });
        }
        if (['funded_in_escrow', 'in_progress'].includes(order.status) || hasFundedEscrow) {
          const hasZeroDeliveries = (!order.deliveryHistory || order.deliveryHistory.length === 0) && (!order.deliverableFiles || order.deliverableFiles.length === 0);
          const isVeryLateGig = isGigOrder && Boolean(order.dueDate) && (Date.now() > new Date(order.dueDate).getTime() + LATE_ORDER_PROTECTION_HOURS * 3600 * 1000) && hasZeroDeliveries;
          if (!isVeryLateGig) {
            return res.status(403).json({
              error: 'Cannot directly cancel an active or delivered order. Please submit a cancellation request (POST /api/orders/:id/cancel-request) or open a dispute (POST /api/orders/:id/dispute).'
            });
          }
          order.cancellationType = 'very_late';
        }
      }
    }

    const actor = caller?.name || `user:${authUserId}`;
    const reason = (req.body?.reason || 'Order cancelled').trim();
    if (hasFundedEscrow) {
      await refundOrderFunds(order, undefined, actor, reason);
    } else {
      const cancelUpdated = await store.updateOrderStatus(
        order.id,
        { status: 'cancelled', cancellation_type: order.cancellationType || null },
        ['payment_pending', 'funded_in_escrow', 'in_progress']
      );
      if (!cancelUpdated) {
        return res.status(409).json({ error: 'Order status changed concurrently; cannot cancel order.' });
      }
      order.status = 'cancelled';
    }
    await cancelPendingOffersForOrder(order.id, caller?.id);
    await emitSystemEvent(order.id, 'order_cancelled', `Order was cancelled. Reason: ${reason}`);
    res.json({ success: true, order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to cancel order' });
  } finally {
    releaseOrderLock(orderId);
  }
};

router.post('/orders/:id/cancel', requireAuth, rateLimit(20, 60_000), handleOrderCancel);
router.post('/orders/:id/review', requireAuth, handleSubmitReview);

router.put('/orders/:id', requireAuth, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  if (req.body?.status === 'cancelled') {
    return handleOrderCancel(req, res);
  }
  const orderId = req.params.id;
  const order = await store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const authUserId = (req as any).authenticatedUserId || resolveAuthenticatedUserId(req);
  const caller = authUserId ? await store.getUser(authUserId) : null;
  if (!caller) return res.status(401).json({ error: 'Authentication required' });
  if (caller.id !== order.buyerId && caller.id !== order.sellerId && !isStaffUser(caller)) {
    return res.status(403).json({ error: 'Forbidden: You are not a participant in this order.' });
  }
  res.json(enrichOrderWithServiceInfo(order));
});

export default router;
