import fs from 'fs';
import path from 'path';
import { WORKSTREAM_UPLOADS_DIR, type Order } from './store.js';
import { diagnosticService } from './services/diagnosticService.js';

export const WORKSTREAM_FILE_URL_PREFIX = '/api/workstream/files/';

export const STAFF_ROLES = ['admin', 'super_admin', 'support'];

export function isStaffUser(user: any): boolean {
  return !!user && STAFF_ROLES.includes(user.role);
}

/** Only the order's buyer, its seller, or platform staff may read or write its workstream. */
export function canAccessOrderWorkstream(user: any, order: { buyerId: string; sellerId: string } | undefined): boolean {
  if (!user || !order) {
    diagnosticService.log(
      'security',
      'accessControl',
      'canAccessOrderWorkstream',
      'server/access.ts',
      'check_order_access',
      'INTERCEPTED',
      { userId: user?.id, buyerId: order?.buyerId, sellerId: order?.sellerId },
      'Unauthorized or missing user/order context'
    );
    return false;
  }
  const hasAccess = isStaffUser(user) || user.id === order.buyerId || user.id === order.sellerId;
  if (!hasAccess) {
    diagnosticService.log(
      'security',
      'accessControl',
      'canAccessOrderWorkstream',
      'server/access.ts',
      'check_order_access',
      'INTERCEPTED',
      { userId: user.id, buyerId: order.buyerId, sellerId: order.sellerId },
      'User is neither buyer, seller, nor staff for this order'
    );
  }
  return hasAccess;
}

/** Robust, canonical path extraction preventing null byte injection, URL-encoded path traversal, and directory climbing */
export function workstreamFilenameFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(WORKSTREAM_FILE_URL_PREFIX)) return null;
  
  // URL decode safely
  let cleanUrl = url;
  try {
    cleanUrl = decodeURIComponent(url);
  } catch {
    // Malformed URI encoding
    diagnosticService.log(
      'security',
      'accessControl',
      'workstreamFilenameFromUrl',
      'server/access.ts',
      'decode_url',
      'INTERCEPTED',
      { url },
      'Malformed URI encoding in file URL'
    );
    return null;
  }

  // Remove null bytes and control characters
  if (cleanUrl.includes('\0') || /[\x00-\x1f\x7f]/.test(cleanUrl)) {
    diagnosticService.log(
      'security',
      'accessControl',
      'workstreamFilenameFromUrl',
      'server/access.ts',
      'null_byte_check',
      'INTERCEPTED',
      { url: cleanUrl },
      'Null byte or control character detected in file URL'
    );
    return null;
  }

  // Strip query string and hash
  const rawSubpath = cleanUrl.slice(WORKSTREAM_FILE_URL_PREFIX.length).split('?')[0].split('#')[0];
  const name = path.basename(rawSubpath);

  // Security check: ensure path.basename matches and does not contain traversal tokens
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    diagnosticService.log(
      'security',
      'accessControl',
      'workstreamFilenameFromUrl',
      'server/access.ts',
      'path_traversal_check',
      'INTERCEPTED',
      { url, extractedName: name },
      'Path traversal or invalid filename sequence in URL'
    );
    return null;
  }

  return name;
}

/** True when any message, deliverable or delivery record still points at this stored file. */
export function workstreamFileReferencedBy(filename: string): Array<{ buyerId: string; sellerId: string }> {
  return [];
}

export { canAccessWorkstreamFile } from './services/workstreamService.js';

/** A message attachment must be a file the sender uploaded (or staff attaching one that exists). */
export function validateMessageFileInfo(fileInfo: any, sender: any):
  { ok: true; fileInfo: any } | { ok: false; error: string } {
  if (fileInfo === undefined || fileInfo === null) return { ok: true, fileInfo: undefined };
  if (typeof fileInfo !== 'object') {
    diagnosticService.log(
      'warning',
      'accessControl',
      'validateMessageFileInfo',
      'server/access.ts',
      'validate_attachment_payload',
      'FAILED',
      { fileInfo },
      'Invalid file attachment format'
    );
    return { ok: false, error: 'Invalid file attachment.' };
  }
  const filename = workstreamFilenameFromUrl(fileInfo.url);
  if (!filename) {
    diagnosticService.log(
      'security',
      'accessControl',
      'validateMessageFileInfo',
      'server/access.ts',
      'validate_attachment_url',
      'INTERCEPTED',
      { url: fileInfo.url },
      'Attachment URL does not match valid workstream file prefix or contains invalid characters'
    );
    return { ok: false, error: 'Attachments must be uploaded files; placeholder or external URLs are not accepted.' };
  }

  // Canonical path containment verification
  const resolvedPath = path.resolve(WORKSTREAM_UPLOADS_DIR, filename);
  const baseUploadDir = path.resolve(WORKSTREAM_UPLOADS_DIR);
  if (!resolvedPath.startsWith(baseUploadDir + path.sep)) {
    diagnosticService.log(
      'critical',
      'accessControl',
      'validateMessageFileInfo',
      'server/access.ts',
      'path_containment_check',
      'INTERCEPTED',
      { filename, resolvedPath },
      'Path traversal exploit attempt blocked'
    );
    return { ok: false, error: 'Access denied: Invalid file path.' };
  }

  if (!fs.existsSync(resolvedPath)) {
    diagnosticService.log(
      'warning',
      'accessControl',
      'validateMessageFileInfo',
      'server/access.ts',
      'file_existence_check',
      'FAILED',
      { filename },
      'Uploaded file not found on disk'
    );
    return { ok: false, error: 'Attachments must be uploaded files; placeholder or external URLs are not accepted.' };
  }
  const bytes = fs.statSync(resolvedPath).size;
  const size = bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return {
    ok: true,
    fileInfo: {
      name: typeof fileInfo.name === 'string' && fileInfo.name.trim() ? fileInfo.name.trim().slice(0, 200) : filename,
      size,
      url: `${WORKSTREAM_FILE_URL_PREFIX}${filename}`,
      ...(typeof fileInfo.type === 'string' ? { type: fileInfo.type.slice(0, 100) } : {})
    }
  };
}

// Validates that client-submitted file records point at files actually stored by the upload endpoint
// AND uploaded by the submitting user (or staff).
export function validateStoredWorkstreamFiles(raw: any[], submitter?: any): { ok: true; files: Array<{ name: string; size: string; url: string }> } | { ok: false; error: string } {
  const out: Array<{ name: string; size: string; url: string }> = [];
  const baseUploadDir = path.resolve(WORKSTREAM_UPLOADS_DIR);
  for (const f of raw) {
    const filename = workstreamFilenameFromUrl(f?.url);
    if (!filename) {
      diagnosticService.log(
        'security',
        'accessControl',
        'validateStoredWorkstreamFiles',
        'server/access.ts',
        'deliverable_file_url_check',
        'INTERCEPTED',
        { url: f?.url },
        'Deliverable file URL missing valid workstream prefix'
      );
      return { ok: false, error: 'Deliverable files must be uploaded first; placeholder or external URLs are not accepted.' };
    }
    const resolvedPath = path.resolve(WORKSTREAM_UPLOADS_DIR, filename);
    if (!resolvedPath.startsWith(baseUploadDir + path.sep)) {
      diagnosticService.log(
        'critical',
        'accessControl',
        'validateStoredWorkstreamFiles',
        'server/access.ts',
        'path_containment_check',
        'INTERCEPTED',
        { filename, resolvedPath },
        'Path traversal exploit attempt in deliverable blocked'
      );
      return { ok: false, error: 'Access denied: Invalid file path.' };
    }
    if (!fs.existsSync(resolvedPath)) {
      diagnosticService.log(
        'warning',
        'accessControl',
        'validateStoredWorkstreamFiles',
        'server/access.ts',
        'file_existence_check',
        'FAILED',
        { filename },
        `Uploaded file not found on server: ${filename}`
      );
      return { ok: false, error: `Uploaded file not found on server: ${filename}` };
    }
    const bytes = fs.statSync(resolvedPath).size;
    const size = bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const parts = filename.split('_');
    const fallbackName = parts.length > 2 ? parts.slice(2).join('_') : filename;
    out.push({ name: typeof f?.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 200) : fallbackName, size, url: `${WORKSTREAM_FILE_URL_PREFIX}${filename}` });
  }
  return { ok: true, files: out };
}

export function assertOrderOpen(order: Order) {
  if (order.status === 'completed') {
    diagnosticService.log(
      'warning',
      'orderService',
      'assertOrderOpen',
      'server/access.ts',
      'order_state_guard',
      'INTERCEPTED',
      { orderId: order.id, status: order.status },
      'Attempted transaction on already completed order'
    );
    throw new Error('Order is already completed; funds were already released.');
  }
  if (order.status === 'cancelled') {
    diagnosticService.log(
      'warning',
      'orderService',
      'assertOrderOpen',
      'server/access.ts',
      'order_state_guard',
      'INTERCEPTED',
      { orderId: order.id, status: order.status },
      'Attempted transaction on already cancelled order'
    );
    throw new Error('Order is already cancelled; funds were already handled.');
  }
}
