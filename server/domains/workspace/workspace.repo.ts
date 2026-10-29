import { RepoContext } from '../types.js';
import {
  type Message,
  type WorkstreamOffer,
  type CustomInvoice,
  type WorkstreamUploadRecord,
  mapOfferRow,
  mapCustomInvoiceRow
} from '../../store.js';

export class WorkspaceRepo {
  constructor(private ctx: RepoContext) {}

  // --- WORKSPACES ---
  async saveWorkspace(w: any): Promise<void> {
    if (!w?.workspaceId) return;
    const createdAt = w.createdAt || new Date().toISOString().split('T')[0];
    const updatedAt = w.updatedAt || new Date().toISOString();
    const title = w.title || w.originId || w.workspaceId;
    const orderIds = Array.isArray(w.orderIds) ? w.orderIds : (w.activeOrderId ? [w.activeOrderId] : []);
    const meta = {
      ...(w.metadata || {}),
      originType: w.originType || 'gig',
      originId: w.originId || title,
      status: w.status || 'active',
      activeOrderId: w.activeOrderId
    };
    await this.ctx.getPool().query(
      `INSERT INTO workspaces (
        workspace_id, buyer_id, seller_id, order_ids, title, created_at, updated_at, last_activity_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (workspace_id) DO UPDATE SET
        buyer_id = EXCLUDED.buyer_id,
        seller_id = EXCLUDED.seller_id,
        order_ids = (
          SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(workspaces.order_ids, '[]'::jsonb)) AS elem
            UNION
            SELECT jsonb_array_elements_text(EXCLUDED.order_ids) AS elem
          ) s
        ),
        title = EXCLUDED.title,
        updated_at = EXCLUDED.updated_at,
        last_activity_at = COALESCE(EXCLUDED.last_activity_at, workspaces.last_activity_at),
        metadata = EXCLUDED.metadata`,
      [
        w.workspaceId, w.buyerId, w.sellerId, JSON.stringify(orderIds),
        title, createdAt, updatedAt, w.lastActivityAt || null, JSON.stringify(meta)
      ]
    );
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    await this.ctx.getPool().query('DELETE FROM workspaces WHERE workspace_id = $1', [workspaceId]);
  }

  async saveWorkspaces(workspaces: any[]): Promise<void> {
    return this.ctx.withLock('workspaces', async () => {
      if (!workspaces) return;
      for (const w of workspaces) {
        if (!w?.workspaceId) continue;
        await this.saveWorkspace(w);
      }
    });
  }

  async listWorkspaces(): Promise<any[]> {
    const res = await this.ctx.getPool().query('SELECT * FROM workspaces ORDER BY created_at DESC');
    return res.rows.map(r => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      const orderIds = typeof r.order_ids === 'string' ? JSON.parse(r.order_ids) : (r.order_ids || []);
      return {
        workspaceId: r.workspace_id,
        buyerId: r.buyer_id,
        sellerId: r.seller_id,
        orderIds,
        title: r.title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastActivityAt: r.last_activity_at || undefined,
        originType: meta.originType || 'gig',
        originId: meta.originId || r.title || r.workspace_id,
        status: meta.status || 'active',
        activeOrderId: meta.activeOrderId || (Array.isArray(orderIds) ? orderIds[0] : undefined),
        metadata: meta
      };
    });
  }

  async getWorkspace(id: string): Promise<any | null> {
    const res = await this.ctx.getPool().query('SELECT * FROM workspaces WHERE workspace_id = $1', [id]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    const orderIds = typeof r.order_ids === 'string' ? JSON.parse(r.order_ids) : (r.order_ids || []);
    return {
      workspaceId: r.workspace_id,
      buyerId: r.buyer_id,
      sellerId: r.seller_id,
      orderIds,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastActivityAt: r.last_activity_at || undefined,
      originType: meta.originType || 'gig',
      originId: meta.originId || r.title || r.workspace_id,
      status: meta.status || 'active',
      activeOrderId: meta.activeOrderId || (Array.isArray(orderIds) ? orderIds[0] : undefined),
      metadata: meta
    };
  }

  // --- MESSAGES ---
  async saveMessages(messages: Message[]): Promise<void> {
    return this.ctx.withLock('messages', async () => {
      if (!messages) return;
      const client = await this.ctx.getPool().connect();
      try {
        await client.query('BEGIN');
        const seen = new Set<string>();
        for (const m of messages) {
          if (!m?.id || seen.has(m.id)) continue;
          seen.add(m.id);
          if (m.senderId === 'system') {
            await client.query(
              `INSERT INTO users (id, name, username, email, role, status, verified, email_verified, mobile_verified, wallet_balance, created_at)
               VALUES ('system', 'WorkSphere System', 'system', 'system@worksphere.internal', 'internal', 'active', TRUE, TRUE, TRUE, 0, $1)
               ON CONFLICT (id) DO NOTHING`,
              [m.timestamp || new Date().toISOString()]
            );
          }
          await client.query(
            `INSERT INTO messages (id, order_id, sender_id, sender_name, text, timestamp, type, file_info, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               order_id = EXCLUDED.order_id,
               sender_id = EXCLUDED.sender_id,
               sender_name = EXCLUDED.sender_name,
               text = EXCLUDED.text,
               timestamp = EXCLUDED.timestamp,
               type = EXCLUDED.type,
               file_info = EXCLUDED.file_info,
               metadata = EXCLUDED.metadata`,
            [
              m.id, m.orderId, m.senderId, m.senderName, m.text, m.timestamp,
              m.type || 'message', JSON.stringify(m.fileInfo || null), JSON.stringify(m.metadata || null)
            ]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }

  async addMessage(m: Message): Promise<void> {
    return this.saveMessages([m]);
  }

  async listMessages(orderId?: string): Promise<Message[]> {
    const res = orderId
      ? await this.ctx.getPool().query('SELECT * FROM messages WHERE order_id = $1 ORDER BY timestamp ASC', [orderId])
      : await this.ctx.getPool().query('SELECT * FROM messages ORDER BY timestamp ASC');
    return res.rows.map(r => ({
      id: r.id,
      orderId: r.order_id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      text: r.text,
      timestamp: r.timestamp,
      type: r.type || undefined,
      fileInfo: r.file_info || undefined,
      metadata: r.metadata || undefined
    }));
  }

  // --- OFFERS ---
  async saveOffers(offers: WorkstreamOffer[]): Promise<void> {
    return this.ctx.withLock('offers', async () => {
      if (!offers) return;
      const client = await this.ctx.getPool().connect();
      try {
        await client.query('BEGIN');
        const seen = new Set<string>();
        for (const o of offers) {
          if (!o?.id || seen.has(o.id)) continue;
          seen.add(o.id);
          const mergedMetadata = {
            ...(o.metadata || {}),
            ...(o.note !== undefined ? { note: o.note } : {}),
            ...(o.files !== undefined ? { files: o.files } : {}),
            ...(o.reference !== undefined ? { reference: o.reference } : {}),
            ...(o.responseDeadline !== undefined ? { responseDeadline: o.responseDeadline } : {}),
            ...(o.rejectionReason !== undefined ? { rejectionReason: o.rejectionReason } : {}),
            ...(o.rejectedBy !== undefined ? { rejectedBy: o.rejectedBy } : {}),
            ...(o.rejectedAt !== undefined ? { rejectedAt: o.rejectedAt } : {}),
            ...(o.proposalId !== undefined ? { proposalId: o.proposalId } : {})
          };
          await client.query(
            `INSERT INTO workstream_offers (
              id, number, order_id, workspace_id, kind, title, amount, delivery_days, status, 
              created_by, created_at, resolved_at, resolved_by, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (id) DO UPDATE SET
              number = EXCLUDED.number,
              order_id = EXCLUDED.order_id,
              workspace_id = EXCLUDED.workspace_id,
              kind = EXCLUDED.kind,
              title = EXCLUDED.title,
              amount = EXCLUDED.amount,
              delivery_days = EXCLUDED.delivery_days,
              status = EXCLUDED.status,
              created_by = EXCLUDED.created_by,
              created_at = EXCLUDED.created_at,
              resolved_at = EXCLUDED.resolved_at,
              resolved_by = EXCLUDED.resolved_by,
              metadata = EXCLUDED.metadata`,
            [
              o.id, o.number, o.orderId, o.workspaceId || null, o.kind, o.title, o.amount,
              o.deliveryDays ?? null, o.status, o.createdBy, o.createdAt,
              o.resolvedAt || null, o.resolvedBy || null, JSON.stringify(mergedMetadata)
            ]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }

  async saveOffer(offer: WorkstreamOffer): Promise<void> {
    return this.saveOffers([offer]);
  }

  async listOffers(): Promise<WorkstreamOffer[]> {
    const res = await this.ctx.getPool().query('SELECT * FROM workstream_offers');
    return res.rows.map(mapOfferRow);
  }

  async getOfferById(id: string): Promise<WorkstreamOffer | undefined> {
    const res = await this.ctx.getPool().query('SELECT * FROM workstream_offers WHERE id = $1', [id]);
    if (res.rows.length === 0) return undefined;
    return mapOfferRow(res.rows[0]);
  }

  async listOffersForOrder(orderId: string): Promise<WorkstreamOffer[]> {
    const res = await this.ctx.getPool().query(
      'SELECT * FROM workstream_offers WHERE order_id = $1 ORDER BY created_at DESC',
      [orderId]
    );
    return res.rows.map(mapOfferRow);
  }

  // --- CUSTOM INVOICES ---
  async saveCustomInvoices(invoices: CustomInvoice[]): Promise<void> {
    return this.ctx.withLock('custom_invoices', async () => {
      if (!invoices) return;
      const client = await this.ctx.getPool().connect();
      try {
        await client.query('BEGIN');
        const seen = new Set<string>();
        for (const inv of invoices) {
          if (!inv?.id || seen.has(inv.id)) continue;
          seen.add(inv.id);
          const buyerId = inv.buyerId || (inv as any).userId || 'unknown';
          const sellerId = inv.sellerId || (inv as any).freelancerId || 'unknown';
          const amount = Number(inv.amount || 0);
          await client.query(
            `INSERT INTO custom_invoices (
              id, invoice_number, buyer_id, seller_id, amount, status, description, created_at, paid_at, related_order_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
              invoice_number = EXCLUDED.invoice_number,
              buyer_id = EXCLUDED.buyer_id,
              seller_id = EXCLUDED.seller_id,
              amount = EXCLUDED.amount,
              status = EXCLUDED.status,
              description = EXCLUDED.description,
              created_at = EXCLUDED.created_at,
              paid_at = EXCLUDED.paid_at,
              related_order_id = EXCLUDED.related_order_id`,
            [
              inv.id, inv.invoiceNumber || inv.id, buyerId, sellerId, amount, inv.status || 'unpaid',
              inv.description || null, inv.createdAt || new Date().toISOString(), inv.paidAt || null, inv.relatedOrderId || null
            ]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  }

  async saveCustomInvoice(inv: CustomInvoice): Promise<void> {
    const buyerId = inv.buyerId || inv.userId || 'unknown';
    const sellerId = inv.sellerId || (inv as any).freelancerId || 'unknown';
    const amount = Number(inv.amount || inv.total || 0);
    await this.ctx.getPool().query(
      `INSERT INTO custom_invoices (
        id, invoice_number, buyer_id, seller_id, amount, status, description, created_at, paid_at, related_order_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        invoice_number = EXCLUDED.invoice_number,
        buyer_id = EXCLUDED.buyer_id,
        seller_id = EXCLUDED.seller_id,
        amount = EXCLUDED.amount,
        status = EXCLUDED.status,
        description = EXCLUDED.description,
        created_at = EXCLUDED.created_at,
        paid_at = EXCLUDED.paid_at,
        related_order_id = EXCLUDED.related_order_id`,
      [
        inv.id, inv.invoiceNumber || (inv as any).invoice_number || inv.id, buyerId, sellerId, amount, inv.status || 'unpaid',
        inv.description || inv.title || null, inv.createdAt || inv.issueDate || new Date().toISOString(), inv.paidAt || null, inv.relatedOrderId || null
      ]
    );
  }

  async listCustomInvoices(): Promise<CustomInvoice[]> {
    const res = await this.ctx.getPool().query('SELECT * FROM custom_invoices');
    return res.rows.map(mapCustomInvoiceRow);
  }

  async getCustomInvoiceById(id: string): Promise<CustomInvoice | undefined> {
    const res = await this.ctx.getPool().query('SELECT * FROM custom_invoices WHERE id = $1', [id]);
    if (res.rows.length === 0) return undefined;
    return mapCustomInvoiceRow(res.rows[0]);
  }

  async listCustomInvoicesForUser(userId: string): Promise<CustomInvoice[]> {
    const res = await this.ctx.getPool().query(
      'SELECT * FROM custom_invoices WHERE buyer_id = $1 OR seller_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return res.rows.map(mapCustomInvoiceRow);
  }

  // --- UPLOADS ---
  async saveUploadRecord(filename: string, record: WorkstreamUploadRecord): Promise<void> {
    return this.ctx.withLock('uploads', async () => {
      await this.ctx.getPool().query(
        `INSERT INTO uploads (filename, owner_id, original_name, mime, size, created_at, sha256, order_id, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (filename) DO UPDATE SET 
           owner_id = EXCLUDED.owner_id, 
           size = EXCLUDED.size, 
           original_name = EXCLUDED.original_name,
           order_id = COALESCE(EXCLUDED.order_id, uploads.order_id),
           workspace_id = COALESCE(EXCLUDED.workspace_id, uploads.workspace_id)`,
        [
          filename,
          record.ownerId,
          record.originalName || null,
          record.mime || null,
          record.size || 0,
          record.createdAt,
          record.sha256 || null,
          record.orderId || null,
          record.workspaceId || null
        ]
      );
    });
  }

  async deleteUploadRecord(_filename: string): Promise<void> {
    // Workstream uploads are permanently retained and cannot be deleted.
    return;
  }

  async getUploadRecord(filename: string): Promise<WorkstreamUploadRecord | undefined> {
    if (!filename) return undefined;
    const res = await this.ctx.getPool().query('SELECT * FROM uploads WHERE filename = $1 LIMIT 1', [filename]);
    if (res.rows.length === 0) return undefined;
    const r = res.rows[0];
    return {
      ownerId: r.owner_id,
      originalName: r.original_name || undefined,
      mime: r.mime || undefined,
      size: Number(r.size),
      createdAt: r.created_at,
      sha256: r.sha256 || undefined,
      orderId: r.order_id || undefined,
      workspaceId: r.workspace_id || undefined
    };
  }

  async listUploadRecords(): Promise<Record<string, WorkstreamUploadRecord>> {
    const res = await this.ctx.getPool().query('SELECT * FROM uploads');
    const out: Record<string, WorkstreamUploadRecord> = {};
    for (const r of res.rows) {
      out[r.filename] = {
        ownerId: r.owner_id,
        originalName: r.original_name || undefined,
        mime: r.mime || undefined,
        size: Number(r.size),
        createdAt: r.created_at,
        sha256: r.sha256 || undefined,
        orderId: r.order_id || undefined,
        workspaceId: r.workspace_id || undefined
      };
    }
    return out;
  }
}
