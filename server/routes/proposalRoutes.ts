import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  store,
  type Proposal,
  type Order,
  type WorkstreamOffer
} from '../store.js';
import { postgresStore } from '../db/postgresStore.js';
import {
  requireAuth,
  requireActiveStatus,
  requireAdmin,
  resolveAuthenticatedUserId,
  adminActor,
  rateLimit,
  isStaffUser,
  formatApiError
} from '../middleware/auth.js';
import { workspaceService } from '../../src/server/workspaceService.js';
import { calculateOrderFees } from '../domains/finance/fees.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { emitSystemEvent } from '../services/messagingService.js';
import { createNotification } from '../services/notificationService.js';
import {
  ensureWallet,
  recordOrder,
  tryAcquireOrderLock,
  releaseOrderLock,
  fundOrderEscrowWithEvent,
  syncUserBalances,
  enrichOrderWithServiceInfo,
  registerAuditLog
} from '../services/orderService.js';
import { postOfferMessage, viewOffer, generateCollisionSafeOfferNumber } from '../services/workstreamService.js';

export const proposalRouter = Router();

export async function enrichProposalWithWorkstream(p: Proposal): Promise<Proposal> {
  let workstreamOrderId = p.workstreamOrderId;
  let offerId = p.offerId;
  if (!workstreamOrderId) {
    const ordRes = await postgresStore.getPool().query(
      "SELECT id FROM orders WHERE fee_breakdown->>'proposalId' = $1 OR requirements = $1 OR metadata->>'proposalId' = $1",
      [p.id]
    );
    if (ordRes.rows.length > 0) workstreamOrderId = ordRes.rows[0].id;
  }
  if (!offerId && workstreamOrderId) {
    const offRes = await postgresStore.getPool().query(
      "SELECT id FROM workstream_offers WHERE metadata->>'proposalId' = $1 OR (order_id = $2 AND kind = 'proposal')",
      [p.id, workstreamOrderId]
    );
    if (offRes.rows.length > 0) offerId = offRes.rows[0].id;
  }
  return {
    ...p,
    ...(workstreamOrderId ? { workstreamOrderId } : {}),
    ...(offerId ? { offerId } : {})
  };
}

// Proposals list
proposalRouter.get('/proposals', async (req: Request, res: Response) => {
  try {
    const authUserId = resolveAuthenticatedUserId(req);
    if (!authUserId) {
      return res.json([]);
    }
    const caller = await store.getUser(authUserId);
    const callerRole = caller?.role;
    const isAdmin = callerRole === 'admin' || callerRole === 'super_admin' || callerRole === 'support';

    const userProposals: Proposal[] = isAdmin ? await store.listProposals() : await store.listProposalsForUser(authUserId);
    const enriched = await Promise.all(userProposals.map(enrichProposalWithWorkstream));
    res.json(enriched);
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to list proposals'));
  }
});

// Submit proposal
proposalRouter.post('/proposals', requireAuth, requireActiveStatus, rateLimit(30, 60_000), async (req: Request, res: Response) => {
  try {
    const caller = (req as any).authenticatedUser;
    if (caller.status === 'restricted') return res.status(403).json({ error: 'Restricted: You cannot submit new proposals while your account is restricted.' });

    const proj = await store.getProject(req.body.projectId);
    if (!proj) return res.status(404).json({ error: 'Project not found.' });

    const buyerId = proj.buyerId || (proj as any).buyer_id;
    if (!['open', 'published', 'in_progress'].includes(proj.status)) {
      return res.status(400).json({ error: 'This project is completed and closed to new proposals.' });
    }
    if (buyerId === caller.id) {
      return res.status(400).json({ error: 'You cannot submit a proposal to your own project.' });
    }
    const bidAmount = Math.round(Number(req.body.bidAmount) * 100) / 100;
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
      return res.status(400).json({ error: 'Enter a valid USD bid amount.' });
    }
    const deliveryDays = Math.max(1, Math.min(365, Math.round(Number(req.body.deliveryDays) || 7)));

    const newPropId = 'prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const createdAt = new Date().toISOString().split('T')[0];
    const coverLetter = typeof req.body.coverLetter === 'string' ? req.body.coverLetter.trim().slice(0, 5000) : '';

    const newProp: Proposal = {
      id: newPropId,
      projectId: req.body.projectId,
      freelancerId: caller.id,
      freelancerName: caller.name,
      freelancerAvatar: caller.avatar,
      freelancerTitle: caller.title || 'Senior Engineer',
      coverLetter,
      bidAmount,
      deliveryDays,
      createdAt,
      status: 'pending'
    };

    await store.saveProposal(newProp);

    await postgresStore.getPool().query(
      'UPDATE projects SET proposals_count = proposals_count + 1 WHERE id = $1',
      [req.body.projectId]
    );

    createNotification({
      userId: buyerId,
      type: 'proposal',
      title: 'New Proposal Received',
      message: `${caller.name} submitted a $${bidAmount} proposal for your project "${proj.title}".`,
      link: `/projects/${proj.id}`,
      dedupKey: `proposal_${newProp.id}`,
      actorId: caller.id
    });

    res.json(newProp);
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to submit proposal'));
  }
});

// Accept Proposal Handler
export async function processProposalAccept(req: any, res: any) {
  const proposalId = req.params.id;
  const proposal = await store.getProposal(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const proj = await store.getProject(proposal.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const buyerId = proj.buyerId || (proj as any).buyer_id;

  if (!tryAcquireOrderLock(proposal.id, res)) return;
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || (await store.getUser(authUserId));
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Authentication required' });
    if (buyerId !== caller.id) return res.status(403).json({ error: 'Forbidden: Only the project buyer can accept proposals.' });

    const lockResult = await postgresStore.executeInTransaction(async (client) => {
      const projLockRes = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [proj.id]);
      if (projLockRes.rows.length === 0) {
        return { status: 404 as const, error: 'Project not found' };
      }
      const lockedProj = projLockRes.rows[0];
      const maxHires = Math.max(1, Number(lockedProj.max_hires || lockedProj.maxHires || lockedProj.freelancers_needed || proj.maxHires || (proj as any).freelancersNeeded || 1));

      const currentHiresRes = await client.query(
        "SELECT COUNT(*) FROM proposals WHERE project_id = $1 AND status IN ('accepted', 'accepting')",
        [proj.id]
      );
      const acceptedCount = parseInt(currentHiresRes.rows[0]?.count || '0', 10);
      if (acceptedCount >= maxHires) {
        return { status: 409 as const, error: 'Project hire capacity has already been reached.' };
      }

      const claimProposal = await client.query(
        "UPDATE proposals SET status = 'accepting' WHERE id = $1 AND status = 'pending' RETURNING *",
        [proposal.id]
      );
      if (claimProposal.rows.length === 0) {
        return { status: 409 as const, error: 'Proposal is already accepted or being processed', maxHires };
      }
      return { status: 200 as const, maxHires };
    });

    if (lockResult.status !== 200) {
      return res.status(lockResult.status).json({ error: lockResult.error });
    }
    const maxHires = lockResult.maxHires || Math.max(1, Number(proj.maxHires || (proj as any).freelancersNeeded || 1));

    try {
      await ensureWallet(buyerId);
      await ensureWallet(proposal.freelancerId);

      const workspace = await workspaceService.createWorkspaceAsync({
        buyerId,
        sellerId: proposal.freelancerId,
        originType: 'project',
        originId: proj.id
      });

      const orderId = 'ord_' + randomUUID().slice(0, 12);
      const today = new Date().toISOString().split('T')[0];
      const protectionDays = siteSettings.getSettings().commission.escrowProtectionDays;
      const deliveryDays = proposal.deliveryDays || 7;
      const dueDate = new Date(Date.now() + deliveryDays * 86400000).toISOString().split('T')[0];

      const order: Order = {
        id: orderId,
        projectOrderId: orderId,
        workspaceId: workspace.workspaceId,
        orderType: 'project',
        type: 'project',
        title: proj.title,
        buyerId,
        sellerId: proposal.freelancerId,
        amount: proposal.bidAmount,
        status: 'payment_pending',
        createdAt: today,
        dueDate,
        escrowProtectionStartDate: today,
        escrowProtectionEndDate: new Date(Date.now() + protectionDays * 86400000).toISOString().split('T')[0],
        projectId: proj.id,
        proposalId: proposal.id,
        feeBreakdown: calculateOrderFees(proposal.bidAmount)
      };

      await workspaceService.ensureWorkspaceForOrderAsync(order);

      const offerId = 'off_' + randomUUID().slice(0, 12);
      const offerNum = generateCollisionSafeOfferNumber('proposal');
      const offer: WorkstreamOffer = {
        id: offerId,
        number: offerNum,
        orderId: order.id,
        proposalId: proposal.id,
        kind: 'proposal',
        title: proj.title,
        amount: proposal.bidAmount,
        deliveryDays: proposal.deliveryDays,
        note: proposal.coverLetter ? proposal.coverLetter.slice(0, 1000) : undefined,
        status: 'pending',
        createdBy: proposal.freelancerId,
        createdAt: new Date().toISOString()
      };

      await postgresStore.getPool().query(
        `INSERT INTO workstream_offers (id, number, order_id, kind, title, amount, delivery_days, status, created_by, created_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [offer.id, offer.number, offer.orderId, offer.kind, offer.title, offer.amount, offer.deliveryDays, offer.status, offer.createdBy, offer.createdAt, JSON.stringify({ proposalId: proposal.id })]
      );

      await recordOrder(order);
      await store.saveOrder(order);

      try {
        await fundOrderEscrowWithEvent({
          orderId: order.id,
          orderTitle: order.title,
          amount: order.amount,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          actor: `user:${order.buyerId}`
        });

        order.status = 'funded_in_escrow';
        await store.saveOrder(order);
      } catch (fundingErr: any) {
        await postgresStore.getPool().query("UPDATE proposals SET status = 'pending', workstream_order_id = NULL, offer_id = NULL WHERE id = $1", [proposal.id]);
        await postgresStore.getPool().query("UPDATE projects SET status = 'open' WHERE id = $1", [proj.id]);
        const escCheck = await postgresStore.getPool().query('SELECT 1 FROM escrows WHERE order_id = $1', [order.id]);
        if (escCheck.rows.length === 0) {
          await postgresStore.getPool().query('DELETE FROM orders WHERE id = $1', [order.id]);
        } else {
          order.status = 'payment_pending';
          await store.saveOrder(order);
        }
        await postgresStore.getPool().query('DELETE FROM workstream_offers WHERE id = $1', [offer.id]);

        if (workspace) {
          await workspaceService.deleteWorkspace(workspace.workspaceId);
        }

        return res.status(400).json({ error: fundingErr.message || 'Failed to fund escrow for proposal.' });
      }

      await emitSystemEvent(order.id, 'order_created', `Order placed: ${order.title}. Payment is held in escrow until the work is approved.`);
      await postOfferMessage(order, offer, null, `Proposal ${offer.number} was created.`, 'offer_created');

      proposal.status = 'accepted';
      proposal.workstreamOrderId = order.id;
      proposal.offerId = offer.id;
      await postgresStore.getPool().query(
        'UPDATE proposals SET status = $1, workstream_order_id = $2, offer_id = $3 WHERE id = $4',
        ['accepted', order.id, offer.id, proposal.id]
      );

      const newHiresRes = await postgresStore.getPool().query(
        "SELECT COUNT(*) FROM proposals WHERE project_id = $1 AND status = 'accepted'",
        [proj.id]
      );
      const newHiresCount = parseInt(newHiresRes.rows[0]?.count || '0', 10);
      if (newHiresCount >= maxHires) {
        proj.status = 'in-progress';
        await postgresStore.getPool().query("UPDATE projects SET status = 'in-progress' WHERE id = $1", [proj.id]);
        await postgresStore.getPool().query("UPDATE proposals SET status = 'declined' WHERE project_id = $1 AND status = 'pending'", [proj.id]);
      } else {
        proj.status = 'open';
        await postgresStore.getPool().query("UPDATE projects SET status = 'open' WHERE id = $1", [proj.id]);
      }
      if (Array.isArray((proj as any).proposalsList)) {
        (proj as any).proposalsList = (proj as any).proposalsList.map((p: any) => p.id === proposal.id ? { ...p, status: 'accepted', workstreamOrderId: order.id, offerId: offer.id } : p);
      }
      await store.saveProject(proj);

      await syncUserBalances();

      offer.status = 'accepted';
      offer.resolvedAt = new Date().toISOString();
      offer.resolvedBy = caller.id;
      await postgresStore.getPool().query(
        'UPDATE workstream_offers SET status = $1, resolved_at = $2, resolved_by = $3 WHERE id = $4',
        ['accepted', offer.resolvedAt, offer.resolvedBy, offer.id]
      );

      await postOfferMessage(order, offer, null, `Proposal ${offer.number} was accepted and escrow funded ($${order.amount}).`, 'offer_accepted');

      createNotification({
        userId: proposal.freelancerId,
        type: 'proposal_accepted',
        title: 'Proposal accepted',
        message: `Your proposal for "${proj.title}" was accepted and escrow has been funded.`,
        link: `/workstream/${order.id}`,
        metadata: { orderId: order.id, projectId: proj.id, proposalId: proposal.id }
      });

      res.json({ success: true, proposal: await enrichProposalWithWorkstream(proposal), order: enrichOrderWithServiceInfo(order), workspace, offer: await viewOffer(offer) });
    } catch (acceptErr: any) {
      await postgresStore.getPool().query("UPDATE proposals SET status = 'pending', workstream_order_id = NULL, offer_id = NULL WHERE id = $1 AND status = 'accepting'", [proposal.id]);
      proposal.status = 'pending';
      return res.status(400).json({ error: acceptErr.message || 'Failed to accept proposal.' });
    }
  } finally {
    releaseOrderLock(proposal.id);
  }
}

// Decline Proposal Handler
export async function processProposalDecline(req: any, res: any) {
  const proposalId = req.params.id;
  const proposal = await store.getProposal(proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const proj = await store.getProject(proposal.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const buyerId = proj.buyerId || (proj as any).buyer_id;

  if (!tryAcquireOrderLock(proposal.id, res)) return;
  try {
    const authUserId = (req as any).authenticatedUserId;
    const caller = (req as any).authenticatedUser || (await store.getUser(authUserId));
    if (!caller || (caller.status !== 'active' && caller.status !== 'restricted')) return res.status(403).json({ error: 'Authentication required' });
    if (buyerId !== caller.id) return res.status(403).json({ error: 'Forbidden: Only the project buyer can decline proposals.' });
    if (proposal.status !== 'pending') return res.status(409).json({ error: `Proposal is already ${proposal.status}.` });

    proposal.status = 'rejected';
    await store.saveProposal(proposal);

    createNotification({
      userId: proposal.freelancerId,
      type: 'proposal_declined',
      title: 'Proposal declined',
      message: `Your proposal for "${proj.title}" was declined.`,
      link: `/projects/${proj.id}`,
      metadata: { projectId: proj.id, proposalId: proposal.id }
    });

    res.json({ success: true, proposal: await enrichProposalWithWorkstream(proposal) });
  } finally {
    releaseOrderLock(proposal.id);
  }
}

proposalRouter.post('/proposals/:id/accept', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  await processProposalAccept(req, res);
});

proposalRouter.post('/proposals/:id/decline', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  await processProposalDecline(req, res);
});

proposalRouter.post('/proposals/:id/:action(accept|decline)', requireAuth, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  if (req.params.action === 'accept') {
    return await processProposalAccept(req, res);
  } else {
    return await processProposalDecline(req, res);
  }
});

const handleProposalUpdate = async (req: Request, res: Response) => {
  try {
    const caller = (req as any).authenticatedUser;
    const proposal = await store.getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (!isStaffUser(caller) && proposal.freelancerId !== caller.id) {
      return res.status(403).json({ error: 'Forbidden: You can only edit your own proposals' });
    }
    if (proposal.status !== 'pending' && !isStaffUser(caller)) {
      return res.status(400).json({ error: `Cannot edit proposal with status "${proposal.status}"` });
    }

    if (req.body.coverLetter !== undefined) proposal.coverLetter = String(req.body.coverLetter).trim();
    if (req.body.bidAmount !== undefined) {
      const bid = Math.round(Number(req.body.bidAmount) * 100) / 100;
      if (!Number.isFinite(bid) || bid <= 0) return res.status(400).json({ error: 'Enter a valid bid amount' });
      proposal.bidAmount = bid;
    }
    if (req.body.deliveryDays !== undefined) {
      proposal.deliveryDays = Math.max(1, Math.min(365, Math.round(Number(req.body.deliveryDays)) || 7));
    }
    await store.saveProposal(proposal);

    // Keep project-embedded proposal snapshot consistent
    if (proposal.projectId) {
      const proj = await store.getProject(proposal.projectId);
      if (proj && Array.isArray((proj as any).proposalsList)) {
        (proj as any).proposalsList = (proj as any).proposalsList.map((p: any) => p.id === proposal.id ? { ...p, ...proposal } : p);
        await store.saveProject(proj);
      }
    }

    res.json(await enrichProposalWithWorkstream(proposal));
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to update proposal'));
  }
};

proposalRouter.put('/proposals/:id', requireAuth, requireActiveStatus, rateLimit(30, 60_000), handleProposalUpdate);
proposalRouter.patch('/proposals/:id', requireAuth, requireActiveStatus, rateLimit(30, 60_000), handleProposalUpdate);

proposalRouter.post('/proposals/:id/withdraw', requireAuth, requireActiveStatus, rateLimit(20, 60_000), async (req: Request, res: Response) => {
  try {
    const caller = (req as any).authenticatedUser;
    const proposal = await store.getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (!isStaffUser(caller) && proposal.freelancerId !== caller.id) {
      return res.status(403).json({ error: 'Forbidden: You can only withdraw your own proposals' });
    }
    if (proposal.status !== 'pending') {
      return res.status(400).json({ error: `Cannot withdraw proposal with status "${proposal.status}"` });
    }

    proposal.status = 'withdrawn' as any;
    await store.saveProposal(proposal);
    await postgresStore.getPool().query("UPDATE projects SET proposals_count = GREATEST(0, proposals_count - 1) WHERE id = $1", [proposal.projectId]);

    if (proposal.projectId) {
      const proj = await store.getProject(proposal.projectId);
      if (proj && Array.isArray((proj as any).proposalsList)) {
        (proj as any).proposalsList = (proj as any).proposalsList.map((p: any) => p.id === proposal.id ? { ...p, status: 'withdrawn' } : p);
        await store.saveProject(proj);
      }
    }

    res.json({ success: true, proposal: await enrichProposalWithWorkstream(proposal) });
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to withdraw proposal'));
  }
});

// Admin Proposals Management
proposalRouter.patch('/admin/proposals/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const p = await store.getProposal(req.params.id);
    if (!p) return res.status(404).json({ error: 'Proposal not found' });

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (req.body.coverLetter !== undefined) {
      updates.push(`cover_letter = $${idx++}`);
      values.push(req.body.coverLetter);
    }
    if (req.body.bidAmount !== undefined) {
      updates.push(`bid_amount = $${idx++}`);
      values.push(Number(req.body.bidAmount));
    }
    if (req.body.deliveryDays !== undefined) {
      updates.push(`delivery_days = $${idx++}`);
      values.push(Number(req.body.deliveryDays));
    }
    if (req.body.status !== undefined) {
      updates.push(`status = $${idx++}`);
      values.push(req.body.status);
    }

    if (updates.length > 0) {
      values.push(req.params.id);
      await postgresStore.getPool().query(
        `UPDATE proposals SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: (req as any).authenticatedUser?.role || 'admin',
      action: 'PROPOSAL_EDITED',
      target: `Proposal #${p.id}`,
      details: `Updated bid parameters ($${req.body.bidAmount || p.bidAmount}) for freelancer ${p.freelancerName}`,
      timestamp: new Date().toLocaleString()
    });

    const updated = await store.getProposal(req.params.id);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to update proposal'));
  }
});

proposalRouter.patch('/admin/proposals/:id/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const p = await store.getProposal(req.params.id);
    if (!p) return res.status(404).json({ error: 'Proposal not found' });

    const oldStatus = p.status;
    await postgresStore.getPool().query('UPDATE proposals SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: (req as any).authenticatedUser?.role || 'admin',
      action: `PROPOSAL_STATUS_${req.body.status.toUpperCase()}`,
      target: `Proposal #${p.id}`,
      details: `Changed proposal status from "${oldStatus}" to "${req.body.status}" for freelancer ${p.freelancerName}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ ...p, status: req.body.status });
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to update status'));
  }
});

proposalRouter.delete('/admin/proposals/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await store.getProposal(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Proposal not found' });

    await postgresStore.getPool().query('DELETE FROM proposals WHERE id = $1', [req.params.id]);
    await postgresStore.getPool().query('UPDATE projects SET proposals_count = GREATEST(0, proposals_count - 1) WHERE id = $1', [deleted.projectId]);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: adminActor(req),
      role: (req as any).authenticatedUser?.role || 'admin',
      action: 'PROPOSAL_DELETED',
      target: `Proposal #${deleted.id}`,
      details: `Permanently removed proposal #${deleted.id} by freelancer ${deleted.freelancerName} from project #${deleted.projectId}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, id: deleted.id });
  } catch (err: any) {
    res.status(500).json(formatApiError(err, 'Failed to delete proposal'));
  }
});
