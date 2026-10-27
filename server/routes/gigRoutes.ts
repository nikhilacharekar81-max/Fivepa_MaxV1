/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { postgresStore } from '../db/postgresStore.js';
import { store } from '../store.js';
import { isGigPublic, sanitizePublicGig } from '../publicData.js';
import {
  requireAuth,
  requireActiveStatus,
  requireAdmin,
  adminActor,
  resolveAuthenticatedUserId,
  escapeHtml
} from '../middleware/auth.js';
import { siteSettings } from '../../src/server/siteSettings.js';
import { financialTransactionService } from '../services/financialService.js';
import { registerAuditLog } from '../services/orderService.js';
import { diagnosticService } from '../services/diagnosticService.js';
import type { Gig } from '../../src/types.js';

export const gigRouter = Router();

// Public gigs list
gigRouter.get('/gigs', async (req: Request, res: Response) => {
  try {
    const rawGigs = await store.listGigs();
    const publicGigs = rawGigs.filter(isGigPublic).map(sanitizePublicGig);
    res.json(publicGigs);
  } catch (err) {
    console.error('[GET /gigs] Error:', err);
    res.status(500).json({ error: 'Failed to fetch gigs' });
  }
});

// Single Gig Detail
gigRouter.get('/gigs/:id', async (req: Request, res: Response) => {
  try {
    const gig = await store.getGig(req.params.id);
    if (!gig) return res.status(404).json({ error: 'Gig not found' });

    const authUserId = resolveAuthenticatedUserId(req);
    let callerRole = null;
    if (authUserId) {
      const user = await store.getUser(authUserId);
      if (user) callerRole = user.role;
    }
    const isAdmin = callerRole === 'admin' || callerRole === 'super_admin';
    const isOwner = authUserId && gig.freelancerId === authUserId;

    if (isGigPublic(gig)) {
      if (isAdmin || isOwner) return res.json(gig);
      return res.json(sanitizePublicGig(gig));
    }

    if (isAdmin || isOwner) {
      return res.json(gig);
    }
    return res.status(404).json({ error: 'Gig not found or unavailable' });
  } catch (err) {
    console.error('[GET /gigs/:id] Error:', err);
    res.status(500).json({ error: 'Failed to fetch gig detail' });
  }
});

// Authenticated Owner Listings
gigRouter.get('/my/gigs', requireAuth, async (req: Request, res: Response) => {
  try {
    const authUserId = (req as any).authenticatedUserId;
    const myGigs = await store.listGigsForFreelancer(authUserId);
    res.json(myGigs);
  } catch (err) {
    console.error('[GET /my/gigs] Error:', err);
    res.status(500).json({ error: 'Failed to fetch user gigs' });
  }
});

// Create Gig
gigRouter.post('/gigs', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  if (caller.status === 'restricted') return res.status(403).json({ error: 'Restricted: You cannot post new services while your account is restricted.' });

  const activeSettings = siteSettings.getSettings();

  const gigPrice = Number(req.body.price);
  if (!Number.isFinite(gigPrice)) return res.status(400).json({ error: 'Gig price must be a valid number.' });
  const minGigPrice = activeSettings.marketplace.minimumGigPrice ?? 1;
  const maxGigPrice = activeSettings.marketplace.maximumGigPrice ?? 10000;
  if (gigPrice < minGigPrice) {
    return res.status(400).json({ error: `Gig price ($${gigPrice}) cannot be lower than the platform minimum of $${minGigPrice}.` });
  }
  if (gigPrice > maxGigPrice) {
    return res.status(400).json({ error: `Gig price ($${gigPrice}) cannot exceed the platform maximum of $${maxGigPrice}.` });
  }

  // Validate package tiers
  if (req.body.packages && typeof req.body.packages === 'object') {
    for (const tier of ['basic', 'standard', 'premium']) {
      if (req.body.packages[tier]) {
        const p = Number(req.body.packages[tier].price);
        if (!Number.isFinite(p) || p < minGigPrice) {
          return res.status(400).json({ error: `Package tier '${tier}' price ($${p}) must be a valid number >= $${minGigPrice}.` });
        }
      }
    }
  }
  if (Array.isArray(req.body.tiers)) {
    for (const tier of req.body.tiers) {
      if (tier && tier.price !== undefined) {
        const p = Number(tier.price);
        if (!Number.isFinite(p) || p < minGigPrice) {
          return res.status(400).json({ error: `Package tier price must be >= $${minGigPrice}.` });
        }
      }
    }
  }

  const deliveryDays = Math.min(365, Math.max(1, Math.round(Number(req.body.deliveryDays)) || 7));
  const category = typeof req.body.category === 'string' ? req.body.category.trim().slice(0, 100) || 'Development & IT' : 'Development & IT';
  const subcategory = typeof req.body.subcategory === 'string' ? req.body.subcategory.trim().slice(0, 100) || 'General' : 'General';
  const rawImage = req.body.image;
  const defaultImage = 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800&h=500&fit=crop';
  const image = (typeof rawImage === 'string' && !/^\s*(javascript:|vbscript:|data:(?!image\/))/i.test(rawImage)) ? rawImage : defaultImage;
  let extras: { id: string; title: string; price: number }[] = [];
  if (Array.isArray(req.body.extras)) {
    extras = req.body.extras.slice(0, 20).map((ex: any, idx: number) => ({
      id: String(ex?.id || `extra_${Date.now()}_${idx}`),
      title: String(ex?.title || '').slice(0, 200),
      price: Math.round(Math.min(100000, Math.max(0, Number(ex?.price) || 0)) * 100) / 100
    }));
  }

  const initialStatus = activeSettings.marketplace.gigModerationRequired ? 'moderation' : 'active';

  const newGig: Gig = {
    id: 'gig_' + Date.now() + '_' + randomUUID().slice(0, 8),
    freelancerId: caller.id,
    freelancerName: caller.name,
    freelancerUsername: caller.username || caller.name.toLowerCase().replace(/\s+/g, '_'),
    freelancerAvatar: caller.avatar,
    freelancerLevel: 'Level 1 ★',
    title: escapeHtml(req.body.title || 'Untitled Gig'),
    slug: req.body.title ? req.body.title.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') : 'custom-gig',
    category,
    subcategory,
    description: escapeHtml(req.body.description || ''),
    price: gigPrice,
    deliveryDays,
    rating: 0,
    reviewsCount: 0,
    image,
    status: initialStatus,
    featured: false,
    isFeatured: false,
    isUrgent: false,
    packages: req.body.packages || undefined,
    extras,
    moderationStatus: activeSettings.marketplace.gigModerationRequired ? 'pending' : 'approved'
  } as any;

  try {
    await store.saveGig(newGig);
    res.json(newGig);
  } catch (err) {
    console.error('[CreateGig] Failed to persist to PostgreSQL:', err);
    res.status(500).json({ error: 'Could not save gig. Please try again.' });
  }
});

// Update Gig
const handleGigUpdate = async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  try {
    const g = await store.getGig(req.params.id);
    if (!g) return res.status(404).json({ error: 'Gig/Service not found' });

    if (g.freelancerId !== caller.id) {
      return res.status(403).json({ error: 'Forbidden: You can only edit your own gigs.' });
    }

    if (g.status === 'deleted') {
      return res.status(400).json({ error: 'Deleted gigs cannot be edited or restored.' });
    }

    let title = g.title;
    let category = g.category;
    let subcategory = g.subcategory;
    let description = g.description;
    let price = g.price;
    let deliveryDays = g.deliveryDays;
    let extras = g.extras;
    let image = g.image;
    let status: Gig['status'] = g.status;
    let moderationStatus = g.moderationStatus;

    if (req.body.title !== undefined) title = escapeHtml(req.body.title);
    if (req.body.category !== undefined && typeof req.body.category === 'string') category = req.body.category.trim().slice(0, 100);
    if (req.body.subcategory !== undefined && typeof req.body.subcategory === 'string') subcategory = req.body.subcategory.trim().slice(0, 100);
    if (req.body.description !== undefined) description = escapeHtml(req.body.description);
    if (req.body.price !== undefined) {
      const newPrice = Number(req.body.price);
      if (!Number.isFinite(newPrice)) return res.status(400).json({ error: 'Gig price must be a valid number.' });
      const activeSettings = siteSettings.getSettings();
      const minGigPrice = activeSettings.marketplace.minimumGigPrice ?? 1;
      const maxGigPrice = activeSettings.marketplace.maximumGigPrice ?? 10000;
      if (newPrice < minGigPrice) {
        return res.status(400).json({ error: `Gig price ($${newPrice}) cannot be lower than the platform minimum of $${minGigPrice}.` });
      }
      if (newPrice > maxGigPrice) {
        return res.status(400).json({ error: `Gig price ($${newPrice}) cannot exceed the platform maximum of $${maxGigPrice}.` });
      }
      price = newPrice;
    }
    if (req.body.deliveryDays !== undefined) {
      deliveryDays = Math.min(365, Math.max(1, Math.round(Number(req.body.deliveryDays)) || 7));
    }
    if (req.body.extras !== undefined && Array.isArray(req.body.extras)) {
      extras = req.body.extras.slice(0, 20).map((ex: any, idx: number) => ({
        id: String(ex?.id || `extra_${Date.now()}_${idx}`),
        title: String(ex?.title || '').slice(0, 200),
        price: Math.round(Math.min(100000, Math.max(0, Number(ex?.price) || 0)) * 100) / 100
      }));
    }
    if (req.body.image !== undefined && typeof req.body.image === 'string') {
      const defaultImage = 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=800&h=500&fit=crop';
      image = /^\s*(javascript:|vbscript:|data:(?!image\/))/i.test(req.body.image) ? defaultImage : req.body.image;
    }

    if (req.body.status !== undefined) {
      const requestedStatus = String(req.body.status).toLowerCase().trim();
      if (!['active', 'paused', 'deleted'].includes(requestedStatus)) {
        return res.status(400).json({ error: 'Invalid status. Sellers can only set status to active, paused, or deleted.' });
      }

      const activeSettings = siteSettings.getSettings();

      if (requestedStatus === 'active') {
        if (moderationStatus === 'rejected' || moderationStatus === 'flagged') {
          return res.status(400).json({ error: 'This gig has been rejected or flagged by moderators and cannot be activated until reviewed and approved by an administrator.' });
        }

        if (activeSettings.marketplace?.gigModerationRequired && moderationStatus !== 'approved') {
          status = 'moderation';
          moderationStatus = 'pending';
        } else {
          status = 'active';
        }
      } else if (requestedStatus === 'paused') {
        status = 'paused';
      } else if (requestedStatus === 'deleted') {
        status = 'deleted';
      }
    } else {
      // Editing details preserves existing status
      status = g.status;
    }

    const updatedGig: Gig = { ...g, title, category, subcategory, description, price, deliveryDays, extras, image, status, moderationStatus };
    await store.saveGig(updatedGig);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller.name,
      role: caller.role,
      action: 'GIG_UPDATED',
      target: `Gig "${title}"`,
      details: `Updated gig details/status to "${status}" (moderation: ${moderationStatus || 'approved'})`,
      timestamp: new Date().toLocaleString()
    });

    res.json(updatedGig);
  } catch (err) {
    console.error('[UpdateGig] Error:', err);
    res.status(500).json({ error: 'Failed to update gig' });
  }
};

gigRouter.patch('/gigs/:id', requireAuth, requireActiveStatus, handleGigUpdate);
gigRouter.put('/gigs/:id', requireAuth, requireActiveStatus, handleGigUpdate);

// Delete Gig
gigRouter.delete('/gigs/:id', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  try {
    const g = await store.getGig(req.params.id);
    if (!g) return res.status(404).json({ error: 'Gig/Service not found' });

    if (g.freelancerId !== caller.id) {
      return res.status(403).json({ error: 'Forbidden: You can only delete your own gigs.' });
    }

    await store.deleteGig(req.params.id);

    registerAuditLog({
      id: 'log_' + Date.now(),
      actor: caller.name,
      role: caller.role,
      action: 'GIG_DELETED',
      target: `Gig "${g.title}"`,
      details: `Permanently deleted freelancer gig #${g.id} by ${g.freelancerName}`,
      timestamp: new Date().toLocaleString()
    });

    res.json({ success: true, id: g.id });
  } catch (err) {
    console.error('[DeleteGig] Error:', err);
    res.status(500).json({ error: 'Failed to delete gig' });
  }
});

// Feature Gig
gigRouter.patch('/gigs/:id/feature', requireAuth, requireActiveStatus, async (req: Request, res: Response) => {
  const caller = (req as any).authenticatedUser;
  try {
    const activeSettings = siteSettings.getSettings();
    const fee = activeSettings.marketplace.featuredGigFee;
    if (!fee || fee <= 0) {
      return res.status(500).json({ error: 'Feature fee is not configured.' });
    }

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = await financialTransactionService.chargeFeaturedGigFee({
      gigId: req.params.id,
      sellerId: caller.id,
      feeAmount: fee,
      featuredUntil: expiresAt,
      actor: `user:${caller.id}`
    });

    res.json(result);
  } catch (err: any) {
    console.error('[FeatureGig] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to feature gig' });
  }
});
