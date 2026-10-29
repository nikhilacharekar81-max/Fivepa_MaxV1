import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import {
  store,
  mapProposalRow,
  type Order,
  type Proposal,
  type WorkstreamOffer,
  type WorkstreamOfferKind,
  type Message
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import { calculateOrderFees } from '../domains/finance/fees.js';
import { financialRepository } from './financialService.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { isStaffUser } from '../middleware/auth.js';
import { recordMessage } from './messagingService.js';
import { broadcastMessage } from '../websocket.js';
import { createNotification } from './notificationService.js';

export const WORKSTREAM_UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads', 'workstream');
if (!fs.existsSync(WORKSTREAM_UPLOADS_DIR)) {
  fs.mkdirSync(WORKSTREAM_UPLOADS_DIR, { recursive: true });
}

export const WORKSTREAM_FILE_URL_PREFIX = '/api/workstream/files/';
export const workstreamFileExists = (f: string) => fs.existsSync(path.join(WORKSTREAM_UPLOADS_DIR, f));
export const workstreamFileBytes = (f: string) => { try { return fs.statSync(path.join(WORKSTREAM_UPLOADS_DIR, f)).size; } catch { return 0; } };
export const WORKSTREAM_MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
export const WORKSTREAM_ABANDONED_UPLOAD_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

export const WORKSTREAM_ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.txt', '.md', '.csv', '.json',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z',
  '.mp4', '.mov', '.webm', '.mp3', '.wav', '.fig', '.psd', '.ai', '.sketch',
  '.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.css', '.scss',
  '.py', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.go', '.rs', '.sql', '.sh', '.xml', '.vue', '.svelte', '.yaml', '.yml'
]);

export const WORKSTREAM_INLINE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt']);

export const OFFER_LABEL: Record<WorkstreamOfferKind, string> = { proposal: 'proposal', invoice: 'invoice', deposit: 'deposit request' };
export const OFFER_PREFIX: Record<WorkstreamOfferKind, string> = { proposal: 'PRP', invoice: 'INV', deposit: 'DEP' };
export const FUNDED_STATUSES = ['funded_in_escrow', 'delivered', 'revision', 'completed', 'disputed'];

export function generateCollisionSafeOfferNumber(kind: WorkstreamOfferKind): string {
  const prefix = OFFER_PREFIX[kind] || 'OFF';
  const tsPart = Date.now().toString(36).toUpperCase();
  const rndPart = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
  return `${prefix}-${tsPart}-${rndPart}`;
}

export async function cancelPendingOffersForOrder(orderId: string, actorId?: string, client?: any): Promise<void> {
  try {
    const dbRunner = client || postgresStore.getPool();
    await dbRunner.query(
      `UPDATE workstream_offers
       SET status = 'cancelled', resolved_at = NOW(), resolved_by = COALESCE($2, created_by)
       WHERE order_id = $1 AND status = 'pending'`,
      [orderId, actorId || null]
    );
  } catch (err) {
    console.error(`[cancelPendingOffersForOrder] Failed for order ${orderId}:`, err);
  }
}

export async function orderHasEscrow(orderId: string, client?: any): Promise<boolean> {
  const esc = await financialRepository.getEscrow(orderId, client);
  return Boolean(esc && esc.status === 'held' && esc.remaining > 0);
}

export async function hasPaidInvoiceOrReleasedEscrow(order: Order, client?: any): Promise<boolean> {
  const esc = await financialRepository.getEscrow(order.id, client);
  if (order.status === 'completed' || (esc && esc.releasedGross > 0)) return true;
  try {
    const offers = await store.listOffersForOrder(order.id, client);
    return offers.some(o => o.kind === 'invoice' && o.status === 'paid');
  } catch {
    return false;
  }
}

export async function findLinkedProposalForOffer(offer: WorkstreamOffer, order: Order, client?: any): Promise<Proposal | undefined> {
  try {
    const dbRunner = client || postgresStore.getPool();
    if (offer.proposalId) {
      const res = await dbRunner.query('SELECT * FROM proposals WHERE id = $1', [offer.proposalId]);
      if (res.rows.length > 0) return mapProposalRow(res.rows[0]);
    }
    const offerRes = await dbRunner.query('SELECT * FROM proposals WHERE offer_id = $1', [offer.id]);
    if (offerRes.rows.length > 0) return mapProposalRow(offerRes.rows[0]);

    if (order.projectId && order.sellerId) {
      const fallbackRes = await dbRunner.query(
        `SELECT * FROM proposals 
         WHERE project_id = $1 AND freelancer_id = $2 AND status IN ('accepted', 'accepting', 'pending')
         ORDER BY created_at DESC LIMIT 1`,
        [order.projectId, order.sellerId]
      );
      if (fallbackRes.rows.length > 0) return mapProposalRow(fallbackRes.rows[0]);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function viewOffer(o: WorkstreamOffer) {
  let clientTotal: number | undefined;
  let additionalAmount: number | undefined;
  let clientAdditionalTotal: number | undefined;
  try {
    clientTotal = calculateOrderFees(o.amount)?.clientTotal;
    if (o.kind === 'invoice') {
      const ord = await store.getOrder(o.orderId);
      const escrow = ord ? await financialRepository.getEscrow(ord.id) : null;
      const curr = ord ? (o.status === 'pending' ? (escrow?.remaining ?? (ord.status === 'completed' || ord.status === 'cancelled' ? 0 : Number(ord.amount || 0))) : Number(ord.amount || 0)) : 0;
      additionalAmount = Math.max(0, Math.round((o.amount - curr) * 100) / 100);
      if (additionalAmount > 0) {
        clientAdditionalTotal = calculateOrderFees(additionalAmount)?.clientTotal;
      } else {
        clientAdditionalTotal = 0;
      }
    }
  } catch { /* quote is informational only */ }
  return {
    ...o,
    clientTotal,
    additionalAmount,
    clientAdditionalTotal,
    currencySymbol: siteSettings.getFlattenedSettings().currencySymbol || '$'
  };
}

export async function postOfferMessage(order: Order, offer: WorkstreamOffer, sender: { id: string; name: string } | null, text: string, action: string, client?: any) {
  const msg: Message = {
    id: `msg_${randomUUID()}`,
    orderId: order.id,
    senderId: sender?.id || 'system',
    senderName: sender?.name || 'Workstream',
    text,
    timestamp: new Date().toISOString(),
    type: sender ? 'message' : 'system',
    metadata: { action, offerId: offer.id, offerKind: offer.kind }
  };
  await recordMessage(msg, client);

  const recipientIds: string[] = [];
  if (sender?.id) {
    const other = sender.id === order.buyerId ? order.sellerId : order.buyerId;
    if (other) recipientIds.push(other);
  } else {
    if (order.buyerId) recipientIds.push(order.buyerId);
    if (order.sellerId && order.sellerId !== order.buyerId) recipientIds.push(order.sellerId);
  }
  for (const userId of recipientIds) {
    await createNotification({
      userId,
      type: 'offer',
      title: 'New Offer Activity',
      message: text,
      link: `/workstream/${order.id}`,
      dedupKey: `offer_${action}_${msg.id}_${userId}`,
      actorId: sender?.id,
      client
    }, client);
  }
}

export async function offerCaller(req: Request) {
  const authUserId = (req as any).authenticatedUserId;
  if ((req as any).authenticatedUser) return (req as any).authenticatedUser;
  if (!authUserId) return null;
  return await store.getUser(authUserId);
}

export function workstreamFilenameFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith(WORKSTREAM_FILE_URL_PREFIX)) {
    const name = path.basename(trimmed.slice(WORKSTREAM_FILE_URL_PREFIX.length).split('?')[0]);
    if (name && name !== '.' && name !== '..') return name;
  }
  if (trimmed.startsWith('/uploads/workstream/')) {
    const name = path.basename(trimmed.slice('/uploads/workstream/'.length).split('?')[0]);
    if (name && name !== '.' && name !== '..') return name;
  }
  if (trimmed.includes('workstream/')) {
    const parts = trimmed.split('workstream/');
    const lastPart = parts[parts.length - 1].split('?')[0];
    const name = path.basename(lastPart);
    if (name && name !== '.' && name !== '..') {
      return name;
    }
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    const baseName = path.basename(trimmed.split('?')[0]);
    if (baseName && workstreamFileExists(baseName)) {
      return baseName;
    }
  }
  return null;
}

export async function workstreamFileExistsAsync(f: string): Promise<boolean> {
  if (!f) return false;
  const safeBase = path.basename(f);
  if (fs.existsSync(path.join(WORKSTREAM_UPLOADS_DIR, safeBase))) return true;
  try {
    const rec = await store.getUploadRecord(safeBase);
    if (rec) return true;
  } catch {}
  return false;
}

export async function canAccessWorkstreamFile(user: any, filename: string): Promise<boolean> {
  if (!user) return false;
  if (isStaffUser(user)) return true;

  try {
    const rec = await store.getUploadRecord(filename);
    if (!rec) return false;

    if (rec.ownerId === user.id) {
      return true;
    }

    if (rec.orderId) {
      const order = await store.getOrder(rec.orderId);
      if (order && (user.id === order.buyerId || user.id === order.sellerId)) {
        return true;
      }
    }

    if (rec.workspaceId) {
      const ws = await postgresStore.getPool().query('SELECT buyer_id, seller_id FROM workspaces WHERE workspace_id = $1', [rec.workspaceId]);
      if (ws.rows.length > 0) {
        const row = ws.rows[0];
        if (user.id === row.buyer_id || user.id === row.seller_id) {
          return true;
        }
      }
    }
  } catch (err) {
    console.error(`[canAccessWorkstreamFile] Authorization check error for file ${filename}:`, err);
  }

  return false;
}

export const canAccessWorkstreamUpload = canAccessWorkstreamFile;

export async function validateMessageFileInfo(fileInfo: any, sender: any):
  Promise<{ ok: true; fileInfo: any } | { ok: false; error: string }> {
  if (fileInfo === undefined || fileInfo === null) return { ok: true, fileInfo: undefined };
  if (typeof fileInfo !== 'object') return { ok: false, error: 'Invalid file attachment.' };

  if (typeof fileInfo.url === 'string') {
    const urlStr = fileInfo.url.trim().toLowerCase();
    if (urlStr.startsWith('javascript:') || urlStr.startsWith('data:') || urlStr.startsWith('file:') || urlStr.startsWith('http:')) {
      return { ok: false, error: 'Insecure URL scheme. Only https:// or internal /api/workstream/files/ links are accepted.' };
    }
  }

  const filename = workstreamFilenameFromUrl(fileInfo.url);
  if (!filename || !(await workstreamFileExistsAsync(filename))) {
    return { ok: false, error: 'Attachments must be uploaded files; placeholder or external URLs are not accepted.' };
  }
  const dbRec = await store.getUploadRecord(filename).catch(() => undefined);
  if (dbRec && sender && !isStaffUser(sender) && dbRec.ownerId && dbRec.ownerId !== sender.id) {
    return { ok: false, error: 'Forbidden: You do not own this uploaded file.' };
  }
  const bytes = workstreamFileBytes(filename) || Number(dbRec?.size || 0);
  const size = bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return {
    ok: true,
    fileInfo: {
      name: typeof fileInfo.name === 'string' && fileInfo.name.trim() ? fileInfo.name.trim().slice(0, 200) : (dbRec?.originalName || filename),
      size,
      url: `${WORKSTREAM_FILE_URL_PREFIX}${filename}`,
      ...(typeof fileInfo.type === 'string' ? { type: fileInfo.type.slice(0, 100) } : {})
    }
  };
}

export async function validateStoredWorkstreamFiles(
  raw: any[],
  submitter?: any,
  targetOrderId?: string
): Promise<{ ok: true; files: Array<{ name: string; size: string; url: string }> } | { ok: false; error: string; status?: number }> {
  if (!Array.isArray(raw)) return { ok: true, files: [] };
  const out: Array<{ name: string; size: string; url: string }> = [];
  const baseUploadDir = path.resolve(WORKSTREAM_UPLOADS_DIR);

  for (const f of raw) {
    const filename = workstreamFilenameFromUrl(f?.url);
    if (!filename) {
      if (typeof f?.url !== 'string') {
        return { ok: false, error: 'Invalid deliverable link.' };
      }
      const extUrl = f.url.trim();
      if (!extUrl.startsWith('https://')) {
        return { ok: false, error: 'Deliverable external links must use https:// scheme.' };
      }
      out.push({
        name: typeof f?.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 200) : 'External Deliverable',
        size: typeof f?.size === 'string' ? f.size : '1.0 MB',
        url: extUrl
      });
      continue;
    }

    const resolvedPath = path.resolve(WORKSTREAM_UPLOADS_DIR, filename);
    if (!resolvedPath.startsWith(baseUploadDir + path.sep) && resolvedPath !== baseUploadDir) {
      return { ok: false, error: 'Access denied: Invalid file path.' };
    }

    if (!(await workstreamFileExistsAsync(filename))) {
      return { ok: false, error: `Uploaded file not found on server: ${filename}` };
    }

    let dbSize = 0;
    // Verify upload ownership and order/workspace binding in PostgreSQL
    try {
      const pool = postgresStore.getPool();
      const res = await pool.query('SELECT * FROM uploads WHERE filename = $1', [filename]);
      if (res.rows.length > 0) {
        const row = res.rows[0];
        dbSize = Number(row.size || 0);
        if (submitter && !isStaffUser(submitter)) {
          if (row.owner_id && row.owner_id !== submitter.id) {
            return { ok: false, error: 'Forbidden: You do not have ownership of this uploaded file.', status: 403 };
          }
        }
        if (targetOrderId && row.order_id && row.order_id !== targetOrderId) {
          return { ok: false, error: 'Forbidden: File is bound to a different order.', status: 403 };
        }
      }
    } catch (err: any) {
      console.error('[validateStoredWorkstreamFiles] DB verification error:', err);
      return { ok: false, error: 'Failed to verify uploaded file ownership', status: 500 };
    }

    const bytes = workstreamFileBytes(filename) || dbSize;
    const size = bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const parts = filename.split('_');
    const fallbackName = parts.length > 2 ? parts.slice(2).join('_') : filename;
    out.push({ name: typeof f?.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 200) : fallbackName, size, url: `${WORKSTREAM_FILE_URL_PREFIX}${filename}` });
  }
  return { ok: true, files: out };
}

export async function cleanupAbandonedWorkstreamUploads() {
  // Workstream messages and uploads are permanently retained and must never be deleted.
  return;
}
