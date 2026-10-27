import { financialTransactionService } from '../services/financialService.js';
import { processCancellationTimeouts, processAutoAcceptOrders } from '../services/orderService.js';
import { postgresStore, isPostgresEnabled } from '../db/postgresStore.js';

export async function runBackgroundJobs() {
  console.log('[BackgroundJobs] Starting financial and marketplace background jobs...');

  // 1. Earnings Clearing Job (Every 5 minutes with session advisory lock)
  setInterval(async () => {
    let client: any = null;
    let hasLock = false;
    try {
      if (isPostgresEnabled()) {
        client = await postgresStore.getPool().connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock(74218932) AS locked');
        if (!lockRes.rows[0]?.locked) {
          return; // Another worker holds the advisory lock
        }
        hasLock = true;
      }

      const clearableIds = await financialTransactionService.getClearableEarnings();
      if (clearableIds.length > 0) {
        console.log(`[BackgroundJobs] Found ${clearableIds.length} earnings to clear.`);
        for (const id of clearableIds) {
          try {
            await financialTransactionService.processEarningsClearing({ clearingId: id, actor: 'system:background_job' });
          } catch (itemErr) {
            console.error(`[BackgroundJobs] Failed to clear earning ${id}:`, itemErr);
          }
        }
      }
    } catch (err) {
      console.error('[BackgroundJobs] Error in earnings clearing job:', err);
    } finally {
      if (client) {
        if (hasLock) {
          try { await client.query('SELECT pg_advisory_unlock(74218932)'); } catch {}
        }
        try { client.release(); } catch {}
      }
    }
  }, 5 * 60 * 1000);

  // 2. Cancellation Timeouts Job (Every 60 seconds with session advisory lock)
  setInterval(async () => {
    let client: any = null;
    let hasLock = false;
    try {
      if (isPostgresEnabled()) {
        client = await postgresStore.getPool().connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock(74218933) AS locked');
        if (!lockRes.rows[0]?.locked) {
          return;
        }
        hasLock = true;
      }
      await processCancellationTimeouts();
    } catch (err) {
      console.error('[BackgroundJobs] Error in cancellation timeouts job:', err);
    } finally {
      if (client) {
        if (hasLock) {
          try { await client.query('SELECT pg_advisory_unlock(74218933)'); } catch {}
        }
        try { client.release(); } catch {}
      }
    }
  }, 60 * 1000);

  // 3. Buyer Review Window & Auto-Accept Job (Every 60 seconds with session advisory lock)
  setInterval(async () => {
    let client: any = null;
    let hasLock = false;
    try {
      if (isPostgresEnabled()) {
        client = await postgresStore.getPool().connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock(74218934) AS locked');
        if (!lockRes.rows[0]?.locked) {
          return;
        }
        hasLock = true;
      }
      await processAutoAcceptOrders();
    } catch (err) {
      console.error('[BackgroundJobs] Error in auto-accept job:', err);
    } finally {
      if (client) {
        if (hasLock) {
          try { await client.query('SELECT pg_advisory_unlock(74218934)'); } catch {}
        }
        try { client.release(); } catch {}
      }
    }
  }, 60 * 1000);
}
