import { Router, Request, Response } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto, { randomUUID } from 'crypto';
import {
  store,
  mapOfferRow,
  type Order,
  type WorkstreamOffer,
  type WorkstreamOfferKind,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { calculateOrderFees } from '../domains/finance/fees.js';
import { financialRepository } from '../services/financialService.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { workspaceService } from '../../src/server/workspaceService.js';
import {
  requireAuth,
  requireActiveStatus,
  rateLimit,
  isStaffUser,
  canAccessOrderWorkstream,
  resolveAuthenticatedUserId,
  formatApiError
} from '../middleware/auth.js';
import {
  tryAcquireOrderLock,
  releaseOrderLock,
  recordOrder,
  enrichOrderWithServiceInfo,
  releaseOrderFunds,
  fundOrderEscrowWithEvent,
  topUpOrderEscrowWithEvent,
  syncUserBalances,
  ensureWallet,
  validateOrderReleasePreconditions,
  getActiveEscrowRemaining
} from '../services/orderService.js';
import { broadcastMessage } from '../websocket.js';
import { createNotification } from '../services/notificationService.js';
import {
  recordMessage,
  sanitizeAndCreateMessage,
  emitSystemEvent
} from '../services/messagingService.js';
import { uploadFileToCloudStorage, openCloudFileStream, deleteFileFromCloudStorage } from '../cloudStorage.js';
import {
  WORKSTREAM_UPLOADS_DIR,
  WORKSTREAM_FILE_URL_PREFIX,
  workstreamFileExists,
  WORKSTREAM_MAX_UPLOAD_BYTES,
  WORKSTREAM_INLINE_EXTENSIONS,
  WORKSTREAM_ALLOWED_EXTENSIONS,
  OFFER_LABEL,
  OFFER_PREFIX,
  orderHasEscrow,
  hasPaidInvoiceOrReleasedEscrow,
  findLinkedProposalForOffer,
  viewOffer,
  postOfferMessage,
  offerCaller,
  canAccessWorkstreamFile,
  validateMessageFileInfo,
  validateStoredWorkstreamFiles,
  workstreamFilenameFromUrl,
  generateCollisionSafeOfferNumber
} from '../services/workstreamService.js';

function escapeHtml(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function saveOfferToDb(offer: WorkstreamOffer): Promise<void> {
  await store.saveOffer(offer);
}

const router = Router();

// ==========================================
// WORKSPACES API
// ==========================================

router.get('/workspaces', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId || resolveAuthenticatedUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    const caller = await store.getUser(authUserId);
    const isAdmin = isStaffUser(caller);

    const [workspaces, allOrders] = await Promise.all([
      isAdmin ? workspaceService.listAllAsync() : workspaceService.getWorkspacesForUserAsync(authUserId),
      isAdmin ? store.listOrders() : store.listOrdersForUser(authUserId)
    ]);

    const ordersByWorkspace = new Map<string, Order[]>();
    for (const o of allOrders) {
      const wsId = o.workspaceId;
      if (wsId) {
        const list = ordersByWorkspace.get(wsId) || [];
        list.push(enrichOrderWithServiceInfo(o, isAdmin));
        ordersByWorkspace.set(wsId, list);
      }
    }

    const enrichedWorkspaces = workspaces.map(ws => {
      const candidateOrders = ordersByWorkspace.get(ws.workspaceId) || [];
      const wsOrders = candidateOrders.filter(o =>
        (o.buyerId === ws.buyerId && o.sellerId === ws.sellerId) ||
        (o.buyerId === ws.sellerId && o.sellerId === ws.buyerId)
      );
      return {
        ...ws,
        orders: wsOrders,
        orderIds: ws.orderIds && ws.orderIds.length > 0 ? ws.orderIds.filter(id => wsOrders.some(o => o.id === id)) : wsOrders.map(o => o.id),
        activeOrder: wsOrders.find(o => o.id === ws.activeOrderId) || wsOrders[0] || null
      };
    });

    res.json(enrichedWorkspaces);
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to fetch workspaces'));
  }
});

router.get('/workspaces/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId || resolveAuthenticatedUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    const caller = await store.getUser(authUserId);
    const isAdmin = isStaffUser(caller);

    const ws = await workspaceService.getWorkspaceAsync(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    if (!isAdmin && ws.buyerId !== authUserId && ws.sellerId !== authUserId) {
      return res.status(403).json({ error: 'Forbidden: Only workspace participants may view this workspace.' });
    }

    const allOrders = await store.listOrders();
    const wsOrders = allOrders
      .filter(o =>
        (o.workspaceId === ws.workspaceId || (ws.orderIds && ws.orderIds.includes(o.id))) &&
        ((o.buyerId === ws.buyerId && o.sellerId === ws.sellerId) || (o.buyerId === ws.sellerId && o.sellerId === ws.buyerId))
      )
      .map(o => enrichOrderWithServiceInfo(o, isAdmin));

    res.json({
      ...ws,
      orders: wsOrders,
      orderIds: ws.orderIds && ws.orderIds.length > 0 ? ws.orderIds.filter(id => wsOrders.some(o => o.id === id)) : wsOrders.map(o => o.id),
      activeOrder: wsOrders.find(o => o.id === ws.activeOrderId) || wsOrders[0] || null
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to fetch workspace details'));
  }
});

// ==========================================
// FILE UPLOAD AND SERVING
// ==========================================

router.post(
  ['/workstream/upload', '/workstream/uploads'],
  requireAuth,
  rateLimit(10, 60_000),
  express.raw({ type: '*/*', limit: WORKSTREAM_MAX_UPLOAD_BYTES }),
  async (req: Request, res: Response) => {
    try {
      const caller = (req as any).authenticatedUser;
      const rawName = (req.query.name as string) || (req.body?.name as string) || 'attachment';
      let decodedName: string;
      try { decodedName = decodeURIComponent(rawName); } catch { decodedName = rawName; }
      const safeBase = path.basename(decodedName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
      const ext = path.extname(safeBase).toLowerCase();
      if (!WORKSTREAM_ALLOWED_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: `File extension "${ext}" is not permitted.` });
      }

      const nameWithoutExt = path.basename(safeBase, path.extname(safeBase));
      const storedFilename = `${Date.now()}_${randomUUID().slice(0, 8)}_${nameWithoutExt}${ext}`;

      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'No file data received' });
      }
      if (buffer.length > WORKSTREAM_MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: 'File is too large (25 MB maximum).' });
      }

      // Magic byte validation
      if (ext === '.pdf') {
        if (buffer.length < 4 || buffer.toString('utf8', 0, 4) !== '%PDF') {
          return res.status(400).json({ error: 'Invalid file signature: PDF files must start with %PDF.' });
        }
      } else if (ext === '.png') {
        if (buffer.length < 4 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
          return res.status(400).json({ error: 'Invalid file signature: PNG files must start with \\x89PNG.' });
        }
      } else if (ext === '.jpg' || ext === '.jpeg') {
        if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
          return res.status(400).json({ error: 'Invalid file signature: JPEG files must start with \\xFF\\xD8\\xFF.' });
        }
      } else if (ext === '.gif') {
        if (buffer.length < 4 || buffer.toString('utf8', 0, 4) !== 'GIF8') {
          return res.status(400).json({ error: 'Invalid file signature: GIF files must start with GIF8.' });
        }
      } else if (ext === '.webp') {
        if (buffer.length < 12 || buffer.toString('utf8', 0, 4) !== 'RIFF' || buffer.toString('utf8', 8, 12) !== 'WEBP') {
          return res.status(400).json({ error: 'Invalid file signature: WebP files must start with RIFF...WEBP.' });
        }
      } else if (ext === '.zip') {
        if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
          return res.status(400).json({ error: 'Invalid file signature: ZIP files must start with PK\\x03\\x04.' });
        }
      }

      const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : (typeof req.body?.orderId === 'string' ? req.body.orderId : (req.headers['x-order-id'] as string || undefined));
      const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : (typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : (req.headers['x-workspace-id'] as string || undefined));

      if (!orderId && !workspaceId) {
        return res.status(400).json({ error: 'Context required: must provide orderId or workspaceId' });
      }

      let targetOrder: Order | null = null;
      if (orderId) {
        targetOrder = (await store.getOrder(orderId)) || null;
        if (!targetOrder) {
          return res.status(404).json({ error: 'Associated order not found' });
        }
        const isParticipant = targetOrder.buyerId === caller.id || targetOrder.sellerId === caller.id || (targetOrder as any).clientId === caller.id || (targetOrder as any).freelancerId === caller.id;
        if (!isStaffUser(caller) && !isParticipant) {
          return res.status(403).json({ error: 'Forbidden: You are not a participant of the specified order' });
        }
      }

      if (workspaceId) {
        const wsRes = await postgresStore.getPool().query('SELECT workspace_id, buyer_id, seller_id FROM workspaces WHERE workspace_id = $1', [workspaceId]);
        if (wsRes.rows.length === 0) {
          if (targetOrder && (workspaceId === `ws-${targetOrder.id}` || workspaceId === targetOrder.workspaceId)) {
            // Valid legacy workspace reference matching order
          } else if (!targetOrder && workspaceId.startsWith('ws-')) {
            const maybeOrder = await store.getOrder(workspaceId.slice(3));
            if (maybeOrder) {
              const isParticipant = maybeOrder.buyerId === caller.id || maybeOrder.sellerId === caller.id || (maybeOrder as any).clientId === caller.id || (maybeOrder as any).freelancerId === caller.id;
              if (!isStaffUser(caller) && !isParticipant) {
                return res.status(403).json({ error: 'Forbidden: You are not a participant of the specified workspace' });
              }
            } else {
              return res.status(404).json({ error: 'Associated workspace not found' });
            }
          } else {
            return res.status(404).json({ error: 'Associated workspace not found' });
          }
        } else {
          const wsRow = wsRes.rows[0];
          if (!isStaffUser(caller) && wsRow.buyer_id !== caller.id && wsRow.seller_id !== caller.id) {
            return res.status(403).json({ error: 'Forbidden: You are not a participant of the specified workspace' });
          }
          if (targetOrder) {
            const orderMatchesWs = targetOrder.workspaceId === workspaceId ||
              ((targetOrder.buyerId === wsRow.buyer_id && targetOrder.sellerId === wsRow.seller_id) ||
               (targetOrder.buyerId === wsRow.seller_id && targetOrder.sellerId === wsRow.buyer_id));
            if (!orderMatchesWs) {
              return res.status(400).json({ error: 'Mismatched orderId and workspaceId context.' });
            }
          }
        }
      }

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const mimeType = (req.headers['content-type'] as string) || 'application/octet-stream';
      await uploadFileToCloudStorage(storedFilename, buffer, mimeType);
      const fileUrl = `${WORKSTREAM_FILE_URL_PREFIX}${storedFilename}`;

      try {
        await store.saveUploadRecord(storedFilename, {
          ownerId: caller.id,
          originalName: safeBase,
          mime: mimeType,
          size: buffer.length,
          sha256,
          createdAt: new Date().toISOString(),
          orderId: orderId || undefined,
          workspaceId: workspaceId || undefined
        });
      } catch (recErr) {
        try { await deleteFileFromCloudStorage(storedFilename); } catch {}
        throw recErr;
      }

      const bytes = buffer.length;
      const sizeStr = bytes > 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;

      res.json({
        name: safeBase,
        size: sizeStr,
        url: fileUrl,
        type: mimeType
      });
    } catch (err: any) {
      console.error('Workstream file upload error:', err);
      res.status(500).json(formatApiError(err, 'Failed to save uploaded file'));
    }
  }
);

router.get(['/workstream/files/:filename', '/uploads/workstream/:filename'], requireAuth, async (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(WORKSTREAM_UPLOADS_DIR, filename);
  const localExists = fs.existsSync(filePath);
  const dbRec = !localExists ? await store.getUploadRecord(filename) : null;
  if (!localExists && !dbRec) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!(await canAccessWorkstreamFile((req as any).authenticatedUser, filename))) {
    return res.status(403).json({ error: 'Forbidden: You do not have access to this file.' });
  }

  const parts = filename.split('_');
  const originalName = parts.length > 2 ? parts.slice(2).join('_') : filename;
  const ext = path.extname(filename).toLowerCase();

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Frame-Options', 'DENY');

  const isPotentiallyActive = ['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs'].includes(ext);
  if (isPotentiallyActive) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  }

  const forceDownload = req.query.download === '1' || !WORKSTREAM_INLINE_EXTENSIONS.has(ext) || ext === '.html' || ext === '.htm';
  if (!localExists) {
    if (forceDownload) res.attachment(originalName); else res.type(ext);
    const stream = openCloudFileStream(filename);
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'File not found' }); else res.end(); });
    return void stream.pipe(res);
  }

  if (forceDownload) {
    return res.download(filePath, originalName);
  }

  res.sendFile(filePath);
});

router.delete(
  ['/workstream/files/:filename', '/workstream/uploads/:filename', '/uploads/workstream/:filename', '/workstream/uploads'],
  requireAuth,
  (_req: Request, res: Response) => {
    return res.status(403).json({ error: 'Workstream uploads are permanent and cannot be deleted.' });
  }
);

// ==========================================
// MESSAGES
// ==========================================

router.delete(
  ['/messages/:id', '/workstream/messages/:id', '/messages'],
  requireAuth,
  (_req: Request, res: Response) => {
    return res.status(403).json({ error: 'Workstream messages are permanent and cannot be deleted.' });
  }
);

router.get('/messages/:orderId', requireAuth, async (req: Request, res: Response) => {
  try {
    const order = await store.getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!canAccessOrderWorkstream((req as any).authenticatedUser, order)) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant of this Workstream.' });
    }
    let msgs = await store.listMessages(req.params.orderId);

    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : undefined;
    const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : undefined;

    if (before) {
      const beforeTime = new Date(before).getTime();
      if (!isNaN(beforeTime)) {
        msgs = msgs.filter(m => new Date(m.timestamp).getTime() < beforeTime);
      }
    }
    if (offset !== undefined) {
      msgs = msgs.slice(offset);
    }
    if (limit !== undefined) {
      msgs = msgs.slice(-limit);
    }

    res.json(msgs);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/messages', requireAuth, rateLimit(120, 60_000), async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = await store.getUser(authUserId);
    if (!caller) return res.status(401).json({ error: 'User not found' });
    const orderId = req.body.orderId;
    if (!orderId) return res.status(400).json({ error: 'Order ID is required' });

    let order = await store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    
    if (caller.status === 'suspended' && !orderId.startsWith('support_admin_')) {
      return res.status(403).json({ error: 'Action forbidden: Your account is suspended. You can only message Support.' });
    }

    if (!canAccessOrderWorkstream(caller, order)) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant of this Workstream.' });
    }

    if (order.isMuted && !isStaffUser(caller)) {
      return res.status(403).json({ error: 'Chat is currently paused.' });
    }

    const fileCheck = await validateMessageFileInfo(req.body.fileInfo, caller);
    if (!fileCheck.ok) return res.status(400).json({ error: (fileCheck as any).error });

    const clientMessageId = typeof req.body.clientMessageId === 'string' ? req.body.clientMessageId : undefined;
    if (clientMessageId) {
      const pool = postgresStore.getPool();
      const existingRes = await pool.query(
        "SELECT * FROM messages WHERE order_id = $1 AND sender_id = $2 AND metadata->>'clientMessageId' = $3 LIMIT 1",
        [orderId, caller.id, clientMessageId]
      );
      if (existingRes.rows.length > 0) {
        const r = existingRes.rows[0];
        return res.json({
          success: true,
          message: {
            id: r.id,
            orderId: r.order_id,
            senderId: r.sender_id,
            senderName: r.sender_name,
            text: r.text,
            timestamp: r.timestamp,
            type: r.type,
            fileInfo: typeof r.file_info === 'string' ? JSON.parse(r.file_info) : r.file_info,
            metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata
          },
          deduplicated: true
        });
      }
    }

    const newMsg = sanitizeAndCreateMessage(caller, order, req.body, fileCheck);
    if (newMsg.fileInfo?.url) {
      const fn = workstreamFilenameFromUrl(newMsg.fileInfo.url);
      if (fn) {
        await postgresStore.getPool().query("UPDATE uploads SET order_id = $1 WHERE filename = $2 AND order_id IS NULL", [order.id, fn]);
      }
    }
    try {
      await recordMessage(newMsg);
    } catch (msgErr: any) {
      if (clientMessageId) {
        const existingMsg = await store.getMessageByClientMsgId(order.id, caller.id, clientMessageId);
        if (existingMsg) {
          return res.json({ success: true, message: existingMsg, deduplicated: true });
        }
      }
      throw msgErr;
    }

    const otherUserId = order.buyerId === caller.id ? order.sellerId : order.buyerId;
    createNotification({
      userId: otherUserId,
      type: 'message',
      title: 'New Message',
      message: `${caller.name} sent a message regarding order "${order.title}".`,
      link: `/messages/${order.id}`,
      dedupKey: `msg_${newMsg.id}`,
      actorId: caller.id
    });

    res.json(newMsg);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to send message' });
  }
});

router.post('/orders/:id/message', requireAuth, rateLimit(120, 60_000), async (req: Request, res: Response) => {
  try {
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const userId = (req as any).authenticatedUserId;
    const user = await store.getUser(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    if (user.status === 'suspended' && !order.id.startsWith('support_admin_')) {
      return res.status(403).json({ error: 'Action forbidden: Your account is suspended. You can only message Support.' });
    }

    if (!canAccessOrderWorkstream(user, order)) {
      return res.status(403).json({ error: 'Forbidden: You are not a participant of this Workstream.' });
    }
    if (order.isMuted && !isStaffUser(user)) {
      return res.status(403).json({ error: 'Chat is currently paused.' });
    }
    const fileCheck = await validateMessageFileInfo(req.body.fileInfo, user);
    if (!fileCheck.ok) return res.status(400).json({ error: (fileCheck as any).error });

    const clientMessageId = typeof req.body.clientMessageId === 'string' ? req.body.clientMessageId : undefined;
    if (clientMessageId) {
      const pool = postgresStore.getPool();
      const existingRes = await pool.query(
        "SELECT * FROM messages WHERE order_id = $1 AND sender_id = $2 AND metadata->>'clientMessageId' = $3 LIMIT 1",
        [order.id, user.id, clientMessageId]
      );
      if (existingRes.rows.length > 0) {
        const r = existingRes.rows[0];
        return res.json({
          success: true,
          message: {
            id: r.id,
            orderId: r.order_id,
            senderId: r.sender_id,
            senderName: r.sender_name,
            text: r.text,
            timestamp: r.timestamp,
            type: r.type,
            fileInfo: typeof r.file_info === 'string' ? JSON.parse(r.file_info) : r.file_info,
            metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata
          },
          deduplicated: true
        });
      }
    }

    const newMsg = sanitizeAndCreateMessage(user, order, req.body, fileCheck);
    if (newMsg.fileInfo?.url) {
      const fn = workstreamFilenameFromUrl(newMsg.fileInfo.url);
      if (fn) {
        await postgresStore.getPool().query("UPDATE uploads SET order_id = $1 WHERE filename = $2 AND order_id IS NULL", [order.id, fn]);
      }
    }
    try {
      await recordMessage(newMsg);
    } catch (msgErr: any) {
      if (clientMessageId) {
        const existingMsg = await store.getMessageByClientMsgId(order.id, user.id, clientMessageId);
        if (existingMsg) {
          return res.json({ success: true, message: existingMsg, deduplicated: true });
        }
      }
      throw msgErr;
    }

    res.json({ success: true, message: newMsg });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to send message' });
  }
});

// ==========================================
// WORKSTREAM OFFERS (PROPOSALS, INVOICES, DEPOSITS)
// ==========================================

router.get('/offers', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const pool = postgresStore.getPool();
    const result = await pool.query(
      `SELECT wo.* FROM workstream_offers wo
       JOIN orders o ON wo.order_id = o.id
       WHERE o.buyer_id = $1 OR o.seller_id = $1
       ORDER BY wo.created_at DESC`,
      [authUserId]
    );
    const offers = result.rows.map(mapOfferRow);
    const viewed = await Promise.all(offers.map(viewOffer));
    res.json(viewed);
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.get('/orders/:id/offers', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = await offerCaller(req);
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!canAccessOrderWorkstream(caller, order)) return res.status(403).json({ error: 'Forbidden' });

    const orderOffers = await store.listOffersForOrder(order.id);
    const offers = await Promise.all(orderOffers.map(viewOffer));
    const esc = await financialRepository.getEscrow(order.id);
    res.json({
      offers,
      currencySymbol: siteSettings.getFlattenedSettings().currencySymbol || '$',
      escrowFunded: await orderHasEscrow(order.id),
      escrowRemaining: await getActiveEscrowRemaining(order),
      totalReleased: esc ? esc.releasedGross : (order.status === 'completed' ? Number(order.amount || 0) : 0),
      hasPaidInvoice: await hasPaidInvoiceOrReleasedEscrow(order)
    });
  } catch (err: any) {
    res.status(500).json(formatApiError(err));
  }
});

router.post('/orders/:id/offers', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const caller = await offerCaller(req);
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (caller.id !== order.sellerId) return res.status(403).json({ error: 'Only the seller of this workstream can send this.' });
    if (order.status === 'cancelled' && order.orderType !== 'gig' && !order.gigOrderId) return res.status(409).json({ error: 'Cannot send offers on a cancelled order.' });

    const kind = req.body?.kind as WorkstreamOfferKind;
    if (!['proposal', 'invoice', 'deposit'].includes(kind)) return res.status(400).json({ error: 'Invalid type.' });

    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const minAmount = Number(siteSettings.getFlattenedSettings().minOrderAmount) || 0;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });
    if (amount > 100000) return res.status(400).json({ error: 'Amount is too large.' });
    if (amount < minAmount) return res.status(400).json({ error: `Minimum amount is ${siteSettings.getFlattenedSettings().currencySymbol || '$'}${minAmount}.` });

    const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const title = kind === 'deposit' ? (rawTitle || 'Escrow deposit') : rawTitle;
    if (title.length < 3 || title.length > 120) return res.status(400).json({ error: 'Title must be 3-120 characters.' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
    const rawRef = typeof req.body?.reference === 'string' ? req.body.reference.trim().slice(0, 2000) : '';
    let deliveryDays: number | undefined;
    if (kind === 'proposal') {
      deliveryDays = Math.round(Number(req.body?.deliveryDays));
      if (!Number.isFinite(deliveryDays) || deliveryDays < 1 || deliveryDays > 365) return res.status(400).json({ error: 'Delivery time must be 1-365 days.' });
    }

    const funded = await orderHasEscrow(order.id);
    const activeEscrow = await getActiveEscrowRemaining(order);
    const hasPaidFirstInvoice = await hasPaidInvoiceOrReleasedEscrow(order);

    const existingOffers = await store.listOffersForOrder(order.id);

    if (kind === 'invoice') {
      if (!funded || activeEscrow <= 0) return res.status(400).json({ error: 'Final invoices are for completed work on a funded workstream.' });
      if (activeEscrow > 0 && amount < activeEscrow) {
        return res.status(400).json({ error: `Final invoice amount cannot be less than the funded escrow price ($${activeEscrow}).` });
      }
      if (existingOffers.filter(o => o.kind === 'invoice' && o.status === 'pending').length >= 1) {
        return res.status(409).json({ error: 'A final invoice is already pending for this workstream.' });
      }
    } else if (kind === 'proposal' || kind === 'deposit') {
      if (existingOffers.some(o => o.kind === 'invoice' && o.status === 'pending')) {
        return res.status(409).json({ error: 'A seller must not raise a new proposal when a previous proposal/order has a pending invoice.' });
      }
      if ((order.orderType === 'gig' || (order.gigId && !order.projectId)) && activeEscrow > 0 && !hasPaidFirstInvoice) {
        return res.status(409).json({ error: 'This Gig is already funded in escrow. Please raise and get your first invoice paid before sending a follow-on proposal.' });
      }
    }

    let uploadedFiles: Array<{ id: string; name: string; size: string; url: string; uploadedAt: string; type: string }> = [];
    if (kind === 'invoice' && Array.isArray(req.body?.files) && req.body.files.length > 0) {
      const validation = await validateStoredWorkstreamFiles(req.body.files, caller, order.id);
      if (!validation.ok) {
        return res.status((validation as any).status || 400).json({ error: (validation as any).error });
      }
      uploadedFiles = validation.files.map((f: any, idx: number) => ({
        id: 'deliv_' + Date.now() + '_' + idx,
        name: f.name,
        size: f.size,
        url: f.url,
        uploadedAt: new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
        type: 'deliverable'
      }));
    }

    const responseDeadline = (order.orderType === 'project' && kind === 'invoice')
      ? new Date(Date.now() + 7 * 86400000).toISOString()
      : undefined;

    const offer: WorkstreamOffer = {
      id: 'off_' + randomUUID().slice(0, 12),
      number: generateCollisionSafeOfferNumber(kind),
      orderId: order.id,
      kind,
      title,
      amount,
      deliveryDays,
      note: note || undefined,
      files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
      reference: rawRef || undefined,
      responseDeadline,
      status: 'pending',
      createdBy: caller.id,
      createdAt: new Date().toISOString()
    };
    await saveOfferToDb(offer);

    if (order.orderType === 'project' && kind === 'invoice') {
      createNotification({
        userId: order.buyerId,
        type: 'invoice_received',
        title: 'Invoice received',
        message: `You received an invoice of $${offer.amount} for "${order.title}". Please review within 7 days.`,
        link: `/workstream/${order.id}`,
        metadata: { orderId: order.id, offerId: offer.id }
      });
    } else if (order.orderType === 'project' && kind === 'proposal') {
      createNotification({
        userId: order.buyerId,
        type: 'proposal_received',
        title: 'Proposal received',
        message: `You received a proposal of $${offer.amount} for "${order.title}".`,
        link: `/workstream/${order.id}`,
        metadata: { orderId: order.id, offerId: offer.id }
      });
    }

    const deliverWorkRequested = Boolean(req.body?.deliverWork);
    const hasDeliveryEvidence = uploadedFiles.length > 0 || Boolean(rawRef) || (Array.isArray(order.deliverableFiles) && order.deliverableFiles.length > 0) || (Array.isArray(order.deliveryHistory) && order.deliveryHistory.length > 0);
    const isWorkableStatus = ['funded_in_escrow', 'in_progress', 'accepted'].includes(order.status);

    if (kind === 'invoice' && deliverWorkRequested && hasDeliveryEvidence && isWorkableStatus) {
      if (!order.deliverableFiles) order.deliverableFiles = [];
      if (!order.deliveryHistory) order.deliveryHistory = [];
      if (uploadedFiles.length > 0) order.deliverableFiles.push(...uploadedFiles);
      const version = order.deliveryHistory.length + 1;
      const sanitizedNotes = note ? escapeHtml(note) : escapeHtml(title);
      order.deliveryNotes = sanitizedNotes;
      if (rawRef) order.deliveryReference = rawRef;
      order.deliveryHistory.push({
        version,
        notes: sanitizedNotes,
        reference: rawRef || undefined,
        files: uploadedFiles,
        deliveredAt: new Date().toISOString()
      });
      order.status = 'delivered';
      if (Array.isArray(order.revisions)) {
        for (const rev of order.revisions) {
          if (rev.status === 'requested') rev.status = 'resolved';
        }
      }
      await store.saveOrder(order);
    }

    await postOfferMessage(order, offer, { id: caller.id, name: caller.name }, `New ${OFFER_LABEL[kind]} ${offer.number}: ${title}`, 'offer_created');
    res.status(201).json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/offers/:id/:action(accept|decline|cancel)', requireAuth, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  const initialOffer = await store.getOfferById(req.params.id);
  if (!initialOffer) return res.status(404).json({ error: 'Not found' });
  const initialOrder = await store.getOrder(initialOffer.orderId);
  if (!initialOrder) return res.status(404).json({ error: 'Not found' });

  const lockedOrderId = initialOrder.id;
  if (!tryAcquireOrderLock(lockedOrderId, res)) return;
  try {
    const offer = await store.getOfferById(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Not found' });
    const order = await store.getOrder(offer.orderId);
    if (!order) return res.status(404).json({ error: 'Not found' });

    const caller = await offerCaller(req);
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Account is not active' });
    if (!canAccessOrderWorkstream(caller, order)) return res.status(403).json({ error: 'Forbidden' });
    if (offer.status !== 'pending') {
      if (offer.status === 'accepted' || offer.status === 'paid') {
        const associatedOrder = await store.getOrder(offer.orderId) || order;
        return res.json({ 
          offer: await viewOffer(offer), 
          order: enrichOrderWithServiceInfo(associatedOrder) 
        });
      }
      return res.status(409).json({ error: `This ${OFFER_LABEL[offer.kind]} is already ${offer.status}.` });
    }

    const action = req.params.action;
    const now = new Date().toISOString();
    const idempotencyKey = req.body?.idempotencyKey || (req.headers['x-idempotency-key'] as string) || `offer-accept-${offer.id}`;

    if (action === 'cancel') {
      if (caller.id !== order.sellerId) return res.status(403).json({ error: 'Only the seller can cancel this.' });
      offer.status = 'cancelled';
      offer.resolvedAt = now;
      offer.resolvedBy = caller.id;

      if (offer.kind === 'proposal') {
        const linkedProp = await findLinkedProposalForOffer(offer, order);
        if (linkedProp && linkedProp.status === 'pending') {
          linkedProp.status = 'rejected';
          await store.saveProposal(linkedProp);
        }
      }
      if (offer.kind === 'invoice' && (order.status === 'delivered' || order.status === 'draft_review')) {
        const otherOffers = await store.listOffersForOrder(order.id);
        const hasOtherPending = otherOffers.some(o => o.id !== offer.id && o.kind === 'invoice' && o.status === 'pending');
        if (!hasOtherPending && (await orderHasEscrow(order.id))) {
          order.status = 'in_progress';
          await store.saveOrder(order);
        }
      }
      await saveOfferToDb(offer);
      await postOfferMessage(order, offer, null, `${offer.number} was cancelled by the seller.`, 'offer_cancelled');
      if (order.orderType === 'project') {
        createNotification({
          userId: order.buyerId,
          type: offer.kind === 'invoice' ? 'invoice_cancelled' : 'proposal_cancelled',
          title: `${OFFER_LABEL[offer.kind]} cancelled`,
          message: `The ${offer.kind} for "${order.title}" was cancelled by the seller.`,
          link: `/workstream/${order.id}`,
          metadata: { orderId: order.id, offerId: offer.id }
        });
      }
      return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
    }

    if (caller.id !== order.buyerId) return res.status(403).json({ error: 'Only the buyer can respond to this.' });

    if (action === 'accept') {
      const isTerminal = ['completed', 'cancelled', 'refunded'].includes(order.status);
      const isDisputed = order.status === 'disputed';
      if ((isTerminal || isDisputed) && offer.kind !== 'proposal') {
        return res.status(400).json({ error: `Cannot accept ${OFFER_LABEL[offer.kind]} on an order that is ${order.status}.` });
      }
    }
    if (order.orderType === 'project' && (order.status === 'completed' || order.status === 'cancelled') && offer.kind !== 'proposal') {
      return res.status(400).json({ error: `Cannot accept ${offer.kind} on a ${order.status} project order.` });
    }
    if (order.status === 'cancelled' && order.orderType !== 'gig' && !order.gigOrderId && offer.kind !== 'proposal') {
      return res.status(400).json({ error: 'Cannot accept offers on a cancelled order (escrow has already been refunded).' });
    }
    if (order.status === 'completed' && offer.kind === 'invoice') {
      return res.status(400).json({ error: 'Cannot accept an invoice on a completed order (escrow has already been released).' });
    }

    if (action === 'decline') {
      if (order.orderType === 'project' && offer.kind === 'invoice') {
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
        if (!reason) {
          return res.status(400).json({ error: 'A reason is required when rejecting a project invoice.' });
        }
        offer.rejectionReason = reason;
        offer.rejectedBy = caller.id;
        offer.rejectedAt = now;
        order.status = 'in_progress';
        await store.saveOrder(order);
        createNotification({
          userId: order.sellerId,
          type: 'invoice_rejected',
          title: 'Invoice rejected',
          message: `Your invoice for "${order.title}" was rejected. Reason: ${reason}`,
          link: `/workstream/${order.id}`,
          metadata: { orderId: order.id, offerId: offer.id, reason }
        });
      }

      offer.status = 'declined';
      offer.resolvedAt = now;
      offer.resolvedBy = caller.id;

      if (offer.kind === 'proposal') {
        const linkedProp = await findLinkedProposalForOffer(offer, order);
        if (linkedProp) {
          linkedProp.status = 'rejected';
          await store.saveProposal(linkedProp);
        }
        if (order.orderType === 'project') {
          createNotification({
            userId: order.sellerId,
            type: 'proposal_declined',
            title: 'Proposal declined',
            message: `Your proposal "${offer.title}" was declined by the buyer.`,
            link: `/workstream/${order.id}`,
            metadata: { orderId: order.id, offerId: offer.id }
          });
        }
      } else if (offer.kind === 'invoice' && order.orderType !== 'project' && (order.status === 'delivered' || order.status === 'draft_review')) {
        const otherOffers = await store.listOffersForOrder(order.id);
        const hasOtherPending = otherOffers.some(o => o.id !== offer.id && o.kind === 'invoice' && o.status === 'pending');
        if (!hasOtherPending && (await orderHasEscrow(order.id))) {
          order.status = 'revision';
          await store.saveOrder(order);
        }
      }
      await saveOfferToDb(offer);
      await postOfferMessage(order, offer, null, `${offer.number} was declined by the buyer.${offer.rejectionReason ? ` Reason: ${offer.rejectionReason}` : ''}`, 'offer_declined');
      return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
    }

    // accept: real money movement through the ledger
    await ensureWallet(order.buyerId);
    await ensureWallet(order.sellerId);
    const today = now.split('T')[0];
    const protectionEnd = new Date(Date.now() + siteSettings.getSettings().commission.escrowProtectionDays * 86400000).toISOString().split('T')[0];
    const isInitialFunding = !(await orderHasEscrow(order.id));
    const isFollowOnAfterCompletion = (await orderHasEscrow(order.id)) && (order.status === 'completed' || (await getActiveEscrowRemaining(order)) === 0);
    const isCancelledGigFollowOn = order.status === 'cancelled' && (order.orderType === 'gig' || order.gigOrderId);

    if (offer.kind === 'invoice') {
      const validationError = validateOrderReleasePreconditions(order, false, true);
      if (validationError) {
        return res.status(validationError.status).json({ error: validationError.error });
      }

      const esc = await financialRepository.getEscrow(order.id);
      const currentEscrow = esc ? esc.remaining : Number(order.amount || 0);
      const invoiceAmount = Number(offer.amount);
      const additionalAmount = Math.round((invoiceAmount - currentEscrow) * 100) / 100;

      if (additionalAmount < 0) {
        return res.status(400).json({ error: `Final invoice amount ($${invoiceAmount}) cannot be less than the current order escrow ($${currentEscrow}).` });
      }

      if (additionalAmount > 0) {
        await topUpOrderEscrowWithEvent({
          orderId: order.id,
          orderTitle: `Invoice Top-up: ${offer.title}`,
          amount: additionalAmount,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          actor: `user:${order.buyerId}`,
          idempotencyKey: `${idempotencyKey}-topup`
        });
        order.amount = invoiceAmount;
      }

      let invoiceRevisionsResolved = false;
      if (Array.isArray(order.revisions)) {
        for (const rev of order.revisions) {
          if (rev.status === 'requested') {
            rev.status = 'resolved';
            invoiceRevisionsResolved = true;
          }
        }
      }
      if (invoiceRevisionsResolved) {
        await emitSystemEvent(order.id, 'revision_resolved', `📝 Revision resolved via accepted invoice ${offer.number}.`);
      }

      await releaseOrderFunds(order, caller.name, `Final invoice ${offer.number} accepted by buyer and escrow released`, false);

      offer.status = 'paid';
      offer.resolvedAt = now;
      offer.resolvedBy = caller.id;

      if (order.orderType === 'project') {
        createNotification({
          userId: order.sellerId,
          type: 'invoice_paid',
          title: 'Invoice paid',
          message: `Invoice ${offer.number} for "${order.title}" ($${invoiceAmount}) was approved and paid.`,
          link: `/workstream/${order.id}`,
          metadata: { orderId: order.id, offerId: offer.id, amount: invoiceAmount }
        });
      }

      await syncUserBalances();
      await saveOfferToDb(offer);
      await store.saveOrder(order);
      const completionNote = additionalAmount > 0
        ? `${offer.number} ($${invoiceAmount.toLocaleString()}) was paid (+$${additionalAmount.toLocaleString()} funded from wallet) and full escrow ($${invoiceAmount.toLocaleString()}) was released to the seller. Order completed!`
        : `${offer.number} was accepted and escrow funds ($${invoiceAmount.toLocaleString()}) were released to the seller. Order completed!`;
      await postOfferMessage(order, offer, null, completionNote, 'offer_paid');
      return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });

    } else if (isInitialFunding) {
      if (order.status === 'funded_in_escrow' || (await orderHasEscrow(order.id))) {
        return res.status(409).json({ error: 'Order escrow is already funded.' });
      }
      if (order.status !== 'in_progress' && order.status !== 'payment_pending') {
        return res.status(409).json({ error: 'Cannot fund escrow for order in current status.' });
      }
      const newTitle = offer.kind === 'proposal' && (/^inquiry:/i.test(order.title) || !order.amount) ? offer.title : order.title;
      const prevStatus = order.status;
      order.previousStatus = prevStatus;
      order.status = 'payment_pending';
      await store.saveOrder(order);

      let escrowFunded = false;
      try {
        await fundOrderEscrowWithEvent({
          orderId: order.id,
          orderTitle: newTitle,
          amount: offer.amount,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          actor: `user:${order.buyerId}`,
          idempotencyKey
        });
        escrowFunded = true;
        order.title = newTitle;
        order.amount = offer.amount;
        order.status = 'funded_in_escrow';
        order.escrowProtectionStartDate = today;
        order.escrowProtectionEndDate = protectionEnd;
        if (offer.kind === 'proposal' && offer.deliveryDays) {
          order.dueDate = new Date(Date.now() + offer.deliveryDays * 86400000).toISOString();
        }
        offer.orderId = order.id;
        offer.status = 'accepted';
        if (offer.kind === 'proposal') {
          const linkedProp = await findLinkedProposalForOffer(offer, order);
          if (linkedProp) {
            linkedProp.status = 'accepted';
            linkedProp.workstreamOrderId = order.id;
            linkedProp.offerId = offer.id;
            order.proposalId = linkedProp.id;
            await store.saveProposal(linkedProp);
          }
        }
        await store.saveOrder(order);
        await saveOfferToDb(offer);
        await postOfferMessage(order, offer, null, `${offer.number} was accepted and escrow was funded ($${offer.amount}).`, 'offer_accepted');
      } catch (fundingErr: any) {
        if (!escrowFunded) {
          order.status = prevStatus;
          await store.saveOrder(order);
          return res.status(400).json({ error: fundingErr.message || 'Failed to fund escrow for offer.' });
        }
        order.status = 'in_progress';
        offer.status = 'accepted';
        await store.saveOrder(order);
        await saveOfferToDb(offer);
        return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
      }
    } else if (isFollowOnAfterCompletion || isCancelledGigFollowOn || (order.orderType === 'project' && (order.status === 'completed' || order.status === 'cancelled') && offer.kind === 'proposal')) {
      const newOrderId = 'ord_' + randomUUID().slice(0, 12);
      const isGigFollowOn = order.orderType === 'gig' || (Boolean(order.gigId) && !order.projectId);
      const orderType: 'gig' | 'project' = isGigFollowOn ? 'gig' : 'project';
      const gigOrderId = orderType === 'gig' ? newOrderId : undefined;
      const projectOrderId = orderType === 'project' ? newOrderId : undefined;

      const newOrder: Order = {
        id: newOrderId,
        workspaceId: order.workspaceId,
        orderType,
        ...(gigOrderId ? { gigOrderId } : {}),
        ...(projectOrderId ? { projectOrderId } : {}),
        title: offer.title,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        amount: offer.amount,
        status: 'payment_pending',
        createdAt: today,
        dueDate: offer.kind === 'proposal' && offer.deliveryDays
          ? new Date(Date.now() + offer.deliveryDays * 86400000).toISOString()
          : new Date(Date.now() + 7 * 86400000).toISOString(),
        escrowProtectionStartDate: today,
        escrowProtectionEndDate: protectionEnd,
        feeBreakdown: calculateOrderFees(offer.amount),
        projectId: order.projectId,
        gigId: order.gigId
      };

      const enrichedOrder = enrichOrderWithServiceInfo(newOrder);
      await recordOrder(enrichedOrder);
      await store.saveOrder(enrichedOrder);

      let followOnEscrowFunded = false;
      try {
        await fundOrderEscrowWithEvent({
          orderId: newOrder.id,
          orderTitle: newOrder.title,
          amount: newOrder.amount,
          buyerId: newOrder.buyerId,
          sellerId: newOrder.sellerId,
          actor: `user:${newOrder.buyerId}`,
          idempotencyKey
        });
        followOnEscrowFunded = true;
        
        enrichedOrder.status = 'funded_in_escrow';
        await store.saveOrder(enrichedOrder);
        await syncUserBalances();
      } catch (fundingErr: any) {
        if (!followOnEscrowFunded) {
          const pool = postgresStore.getPool();
          const escCheck = await pool.query('SELECT 1 FROM escrows WHERE order_id = $1', [newOrder.id]);
          if (escCheck.rows.length === 0) {
            await pool.query('DELETE FROM orders WHERE id = $1', [newOrder.id]);
          } else {
            enrichedOrder.status = 'payment_pending';
            await store.saveOrder(enrichedOrder);
          }
          return res.status(400).json({ error: fundingErr.message || 'Failed to fund escrow for follow-on order.' });
        }
        enrichedOrder.status = 'in_progress';
        await store.saveOrder(enrichedOrder);
        return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(enrichedOrder) });
      }

      await emitSystemEvent(newOrder.id, 'order_created', `Order placed: ${newOrder.title}. Payment is held in escrow until the work is approved.`);

      offer.orderId = newOrder.id;
      offer.status = 'accepted';

      if (orderType === 'project') {
        createNotification({
          userId: newOrder.sellerId,
          type: 'proposal_accepted',
          title: 'Follow-on proposal accepted',
          message: `Your follow-on proposal "${offer.title}" was accepted and escrow has been funded.`,
          link: `/workstream/${newOrderId}`,
          metadata: { orderId: newOrderId, offerId: offer.id }
        });
      }

      await saveOfferToDb(offer);
      await postOfferMessage(enrichedOrder, offer, null, `Follow-on ${OFFER_LABEL[offer.kind]} ${offer.number} ("${offer.title}") was accepted and $${offer.amount.toLocaleString()} was funded into escrow in a new Order (#${newOrderId}).`, 'offer_accepted');
      return res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(enrichedOrder) });
    } else {
      await topUpOrderEscrowWithEvent({
        orderId: order.id,
        orderTitle: offer.title,
        amount: offer.amount,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        actor: `user:${order.buyerId}`,
        idempotencyKey
      });
      order.amount = Math.round((Number(order.amount || 0) + offer.amount) * 100) / 100;
      if (offer.kind === 'proposal' && offer.deliveryDays) {
        order.dueDate = new Date(Date.now() + offer.deliveryDays * 86400000).toISOString();
      }
      offer.orderId = order.id;
      offer.status = 'accepted';
      if (offer.kind === 'proposal') {
        const linkedProp = await findLinkedProposalForOffer(offer, order);
        if (linkedProp) {
          linkedProp.status = 'accepted';
          linkedProp.workstreamOrderId = order.id;
          linkedProp.offerId = offer.id;
          await store.saveProposal(linkedProp);
        }
      }
      await postOfferMessage(order, offer, null, `${offer.number} was accepted and escrow was topped up with $${offer.amount}. All funds and milestones remain unified under Order #${order.id}.`, 'offer_accepted');
    }

    offer.resolvedAt = now;
    offer.resolvedBy = caller.id;
    await syncUserBalances();
    await store.saveOrder(order);
    await saveOfferToDb(offer);
    res.json({ offer: await viewOffer(offer), order: enrichOrderWithServiceInfo(order) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  } finally {
    releaseOrderLock(lockedOrderId);
  }
});

router.post(
  ['/workstream/messages/:id/accept-offer', '/messages/:id/accept-offer'],
  requireAuth,
  requireActiveStatus,
  rateLimit(20, 60_000),
  async (req: Request, res: Response) => {
    try {
      const msgId = req.params.id;
      const caller = (req as any).authenticatedUser;
      if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) {
        return res.status(403).json({ error: 'Account is not active' });
      }
      const pool = postgresStore.getPool();

      let offer = await store.getOfferById(msgId);
      let msg: any = null;
      if (!offer) {
        const msgRes = await pool.query("SELECT * FROM messages WHERE id = $1", [msgId]);
        if (msgRes.rows.length > 0) {
          msg = msgRes.rows[0];
          const offerId = msg.metadata?.offerId || msg.metadata?.offer?.id || msg.metadata?.id;
          if (offerId) {
            offer = await store.getOfferById(offerId);
          }
        }
      }

      if (!offer) {
        return res.status(404).json({ error: 'Offer not found' });
      }
      if (caller.id === offer.createdBy) {
        return res.status(403).json({ error: 'You cannot accept your own offer.' });
      }
      if (offer.status !== 'pending') {
        if (offer.status === 'accepted' || offer.status === 'paid') {
          const existingOrder = offer.orderId ? await store.getOrder(offer.orderId) : null;
          return res.json({
            success: true,
            order: existingOrder ? enrichOrderWithServiceInfo(existingOrder) : null,
            offer: await viewOffer(offer)
          });
        }
        return res.status(409).json({ error: `This offer is already ${offer.status}.` });
      }

      const idempotencyKey = req.body?.idempotencyKey || (req.headers['x-idempotency-key'] as string) || `offer-accept-${offer.id}`;

      let order = offer.orderId ? await store.getOrder(offer.orderId) : null;
      if (!order && msg?.order_id) {
        order = await store.getOrder(msg.order_id);
      }

      if (!order) {
        const clientId = caller.id;
        const sellerId = offer.createdBy;
        const offerAmount = Number(offer.amount);
        const offerTitle = offer.title || 'Custom Offer';

        if (!sellerId || !Number.isFinite(offerAmount) || offerAmount <= 0) {
          return res.status(400).json({ error: 'Invalid custom offer details.' });
        }

        await ensureWallet(clientId);
        await ensureWallet(sellerId);

        const newOrderId = 'ord_' + randomUUID().slice(0, 12);
        const today = new Date().toISOString().split('T')[0];
        const protectionDays = siteSettings.getSettings().commission.escrowProtectionDays || 14;

        const newOrder: Order = {
          id: newOrderId,
          workspaceId: newOrderId,
          title: offerTitle,
          buyerId: clientId,
          sellerId: sellerId,
          amount: offerAmount,
          status: 'payment_pending',
          createdAt: today,
          dueDate: new Date(Date.now() + 7 * 86400000).toISOString(),
          escrowProtectionStartDate: today,
          escrowProtectionEndDate: new Date(Date.now() + protectionDays * 86400000).toISOString().split('T')[0],
          feeBreakdown: calculateOrderFees(offerAmount)
        };

        await workspaceService.ensureWorkspaceForOrderAsync(newOrder);
        await store.saveOrder(newOrder);

        let customOfferEscrowFunded = false;
        try {
          await fundOrderEscrowWithEvent({
            orderId: newOrder.id,
            orderTitle: newOrder.title,
            amount: newOrder.amount,
            buyerId: newOrder.buyerId,
            sellerId: newOrder.sellerId,
            actor: `user:${caller.id}`,
            idempotencyKey
          });
          customOfferEscrowFunded = true;

          newOrder.status = 'in_progress';
          await store.saveOrder(newOrder);
          await syncUserBalances();

          offer.status = 'accepted';
          offer.orderId = newOrder.id;
          offer.resolvedAt = new Date().toISOString();
          offer.resolvedBy = caller.id;
          await saveOfferToDb(offer);

          return res.json({ success: true, order: enrichOrderWithServiceInfo(newOrder), offer: await viewOffer(offer) });
        } catch (err: any) {
          if (!customOfferEscrowFunded) {
            const escCheck = await pool.query("SELECT 1 FROM escrows WHERE order_id = $1", [newOrder.id]);
            if (escCheck.rows.length === 0) {
              await pool.query("DELETE FROM orders WHERE id = $1", [newOrder.id]);
            } else {
              newOrder.status = 'payment_pending';
              await store.saveOrder(newOrder);
            }
            return res.status(400).json({ error: err.message || 'Failed to fund escrow for custom offer' });
          }
          newOrder.status = 'in_progress';
          await store.saveOrder(newOrder);
          return res.json({ success: true, order: enrichOrderWithServiceInfo(newOrder), offer: await viewOffer(offer) });
        }
      }

      if (caller.id !== order.buyerId) {
        return res.status(403).json({ error: 'Only the buyer can accept this offer.' });
      }

      const lockedExistingOrderId = order.id;
      if (!tryAcquireOrderLock(lockedExistingOrderId, res)) return;
      try {
        const freshOrder = await store.getOrder(lockedExistingOrderId);
        if (!freshOrder) return res.status(404).json({ error: 'Order not found' });
        const targetOffer = await store.getOfferById(offer.id);
        if (!targetOffer) return res.status(404).json({ error: 'Offer not found' });

        if (targetOffer.status !== 'pending') {
          if (targetOffer.status === 'accepted' || targetOffer.status === 'paid') {
            return res.json({
              success: true,
              order: enrichOrderWithServiceInfo(freshOrder),
              offer: await viewOffer(targetOffer)
            });
          }
          return res.status(409).json({ error: `This offer is already ${targetOffer.status}.` });
        }

        if (targetOffer.kind === 'invoice') {
          const validationError = validateOrderReleasePreconditions(freshOrder, false, true);
          if (validationError) {
            return res.status(validationError.status).json({ error: validationError.error });
          }

          const esc = await financialRepository.getEscrow(freshOrder.id);
          const currentEscrow = esc ? esc.remaining : (freshOrder.escrowBalance ?? Number(freshOrder.amount || 0));
          const invoiceAmount = Number(targetOffer.amount);
          const additionalAmount = Math.round((invoiceAmount - currentEscrow) * 100) / 100;

          if (additionalAmount < 0) {
            return res.status(400).json({ error: `Final invoice amount ($${invoiceAmount}) cannot be less than the current order escrow ($${currentEscrow}).` });
          }

          await ensureWallet(freshOrder.buyerId);
          await ensureWallet(freshOrder.sellerId);

          if (additionalAmount > 0) {
            await topUpOrderEscrowWithEvent({
              orderId: freshOrder.id,
              orderTitle: `Invoice Top-up: ${targetOffer.title}`,
              amount: additionalAmount,
              buyerId: freshOrder.buyerId,
              sellerId: freshOrder.sellerId,
              actor: `user:${caller.id}`,
              idempotencyKey: `${idempotencyKey}-topup`
            });
            freshOrder.amount = invoiceAmount;
          }

          let invoiceRevisionsResolved = false;
          if (Array.isArray(freshOrder.revisions)) {
            for (const rev of freshOrder.revisions) {
              if (rev.status === 'requested') {
                rev.status = 'resolved';
                invoiceRevisionsResolved = true;
              }
            }
          }
          if (invoiceRevisionsResolved) {
            await emitSystemEvent(freshOrder.id, 'revision_resolved', `📝 Revision resolved via accepted invoice ${targetOffer.number || targetOffer.id}.`);
          }

          await releaseOrderFunds(freshOrder, caller.name, `Final invoice ${targetOffer.number || targetOffer.id} accepted by buyer and escrow released`, false);

          targetOffer.status = 'paid';
          targetOffer.resolvedAt = new Date().toISOString();
          targetOffer.resolvedBy = caller.id;
          await saveOfferToDb(targetOffer);

          freshOrder.status = 'completed';
          freshOrder.completedAt = new Date().toISOString();
          freshOrder.escrowReleased = true;
          await store.saveOrder(freshOrder);
          await syncUserBalances();

          return res.json({ success: true, order: enrichOrderWithServiceInfo(freshOrder), offer: await viewOffer(targetOffer) });
        } else {
          const amountToFund = Number(targetOffer.amount);
          if (!Number.isFinite(amountToFund) || amountToFund <= 0) {
            return res.status(400).json({ error: 'Invalid offer amount.' });
          }

          await ensureWallet(freshOrder.buyerId);
          await ensureWallet(freshOrder.sellerId);

          await topUpOrderEscrowWithEvent({
            orderId: freshOrder.id,
            orderTitle: targetOffer.title || freshOrder.title,
            amount: amountToFund,
            buyerId: freshOrder.buyerId,
            sellerId: freshOrder.sellerId,
            actor: `user:${caller.id}`,
            idempotencyKey
          });

          targetOffer.status = 'accepted';
          targetOffer.resolvedAt = new Date().toISOString();
          targetOffer.resolvedBy = caller.id;
          await saveOfferToDb(targetOffer);

          freshOrder.amount = Math.round((Number(freshOrder.amount || 0) + amountToFund) * 100) / 100;
          freshOrder.status = 'in_progress';
          await store.saveOrder(freshOrder);
          await syncUserBalances();

          return res.json({ success: true, order: enrichOrderWithServiceInfo(freshOrder), offer: await viewOffer(targetOffer) });
        }
      } finally {
        releaseOrderLock(lockedExistingOrderId);
      }
    } catch (err: any) {
      return res.status(500).json(formatApiError(err, 'Failed to accept offer'));
    }
  }
);

export default router;
