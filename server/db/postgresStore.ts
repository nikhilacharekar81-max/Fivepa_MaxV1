import pkg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { 
  Order, 
  Message, 
  Review, 
  WorkstreamUploadRecord, 
  User, 
  Gig, 
  Project, 
  Proposal, 
  Dispute, 
  Refund, 
  Payout, 
  SupportTicket, 
  AuditLog, 
  UserEmail,
  WorkstreamOffer,
  CustomInvoice,
  Notification,
  ProjectClarification,
  PaymentMethodRecord,
  ClearingEarning
} from '../../src/types.js';
import {
  IdentityRepo,
  MarketplaceRepo,
  OrdersRepo,
  WorkspaceRepo,
  FinanceRepo,
  TrustSafetyRepo,
  NotificationsRepo,
  AdminRepo
} from '../domains/index.js';

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function isRemotePostgresConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.SQL_HOST);
}

export function isPostgresEnabled(): boolean {
  return true;
}

export function getDatabaseName(): string {
  if (process.env.NODE_ENV === 'test') {
    return 'cloud_sql_test_database';
  }
  return process.env.SQL_DB_NAME || 'cloud_sql_development_database';
}

export function createPgPool(databaseName?: string): pkg.Pool {
  const connectionString = process.env.DATABASE_URL;
  const isSslEnabled = process.env.PGSSL === 'true' || process.env.PGSSLMODE === 'require';
  const rejectUnauthorized = process.env.NODE_ENV === 'production' ? (process.env.PGSSLREJECTUNAUTHORIZED !== 'false') : false;
  const sslMode = isSslEnabled ? { rejectUnauthorized } : false;
  if (connectionString) {
    return new Pool({
      connectionString,
      ssl: sslMode,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  const db = databaseName || getDatabaseName();
  return new Pool({
    host: process.env.SQL_HOST || process.env.PGHOST || 'localhost',
    port: Number(process.env.SQL_PORT || process.env.PGPORT || 5432),
    user: process.env.SQL_USER || process.env.PGUSER || 'postgres',
    password: process.env.SQL_PASSWORD || process.env.PGPASSWORD || '',
    database: process.env.SQL_DB_NAME || process.env.PGDATABASE || db,
    ssl: sslMode,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

export function createAdminPgPool(databaseName?: string): pkg.Pool {
  const connectionString = process.env.DATABASE_URL;
  const isSslEnabled = process.env.PGSSL === 'true' || process.env.PGSSLMODE === 'require';
  const rejectUnauthorized = process.env.NODE_ENV === 'production' ? (process.env.PGSSLREJECTUNAUTHORIZED !== 'false') : false;
  const sslMode = isSslEnabled ? { rejectUnauthorized } : false;
  if (connectionString) {
    return new Pool({
      connectionString,
      ssl: sslMode,
      max: 5,
      idleTimeoutMillis: 10000,
    });
  }
  const db = databaseName || getDatabaseName();
  return new Pool({
    host: process.env.SQL_HOST || process.env.PGHOST || 'localhost',
    port: Number(process.env.SQL_PORT || process.env.PGPORT || 5432),
    user: process.env.SQL_ADMIN_USER || process.env.PGUSER || 'postgres',
    password: process.env.SQL_ADMIN_PASSWORD || process.env.PGPASSWORD || '',
    database: process.env.SQL_DB_NAME || process.env.PGDATABASE || db,
    ssl: sslMode,
    max: 5,
    idleTimeoutMillis: 10000,
  });
}

// Global cached pool
declare global {
  var _appPostgresPool: pkg.Pool | undefined;
  var _appMockPool: any | undefined;
}

class PGlitePool {
  private pglite: PGlite;
  private isReadyPromise: Promise<void>;
  private txLock: Promise<void> = Promise.resolve();

  constructor(dataDir?: string) {
    try {
      if (dataDir) {
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        this.pglite = new PGlite(dataDir);
      } else {
        this.pglite = new PGlite();
      }
    } catch (e) {
      console.warn('WARNING: Failed to init PGlite with dataDir, falling back to in-memory PGlite:', e);
      this.pglite = new PGlite();
    }
    this.isReadyPromise = this.init().catch(async (err) => {
      console.warn('WARNING: PGlite waitReady failed, falling back to in-memory PGlite:', err);
      this.pglite = new PGlite();
      await this.pglite.waitReady;
    });
  }

  private async init() {
    await this.pglite.waitReady;
  }

  async query(text: string, params?: any[]) {
    await this.isReadyPromise;
    const trimmed = text.trim();
    if ((!params || params.length === 0) && trimmed.includes(';') && trimmed.indexOf(';') < trimmed.length - 1) {
      const results = await this.pglite.exec(text);
      const last = results[results.length - 1];
      return {
        rows: last?.rows || [],
        fields: last?.fields || [],
        rowCount: last?.affectedRows ?? last?.rows?.length ?? 0
      };
    }
    const res = await this.pglite.query(text, params || []);
    return {
      rows: res.rows || [],
      fields: res.fields || [],
      rowCount: res.affectedRows ?? res.rows?.length ?? 0
    };
  }

  async connect() {
    await this.isReadyPromise;
    let releaseLock!: () => void;
    const prevLock = this.txLock;
    this.txLock = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    await prevLock;

    let released = false;
    return {
      query: async (text: string, params?: any[]) => this.query(text, params),
      release: () => {
        if (!released) {
          released = true;
          releaseLock();
        }
      }
    };
  }

  async end() {
    await this.isReadyPromise;
    await this.pglite.close();
  }
}

export function getPool(): pkg.Pool {
  if (!isRemotePostgresConfigured()) {
    if (process.env.NODE_ENV === 'production' && !global._appMockPool) {
      throw new Error('FATAL: Production environment requires a configured PostgreSQL database (DATABASE_URL or SQL_HOST). Fallback to local PGlite is disabled in production.');
    }
    if (!global._appMockPool) {
      try {
        const pgDataDir = process.env.NODE_ENV === 'test'
          ? undefined
          : (process.env.PGLITE_DATA_DIR || path.join(os.tmpdir(), 'wph-pglite-data'));
        global._appMockPool = new PGlitePool(pgDataDir);
      } catch (err) {
        console.warn('WARNING: PGlite disk storage failed to init, falling back to in-memory PGlite:', err);
        global._appMockPool = new PGlitePool();
      }
    }
    return global._appMockPool as unknown as pkg.Pool;
  }
  if (!global._appPostgresPool) {
    global._appPostgresPool = createPgPool();
  }
  return global._appPostgresPool;
}

export class PostgresStore {
  public isHydrated: boolean = process.env.NODE_ENV === 'test';
  private locks = new Map<string, Promise<any>>();
  private pending = new Map<string, Promise<any>>();

  public readonly identityRepo: IdentityRepo;
  public readonly marketplaceRepo: MarketplaceRepo;
  public readonly ordersRepo: OrdersRepo;
  public readonly workspaceRepo: WorkspaceRepo;
  public readonly financeRepo: FinanceRepo;
  public readonly trustSafetyRepo: TrustSafetyRepo;
  public readonly notificationsRepo: NotificationsRepo;
  public readonly adminRepo: AdminRepo;

  constructor(pool?: pkg.Pool) {
    if (pool) {
      (this as any)._customPool = pool;
    }
    this.identityRepo = new IdentityRepo(this);
    this.marketplaceRepo = new MarketplaceRepo(this);
    this.ordersRepo = new OrdersRepo(this);
    this.workspaceRepo = new WorkspaceRepo(this);
    this.financeRepo = new FinanceRepo(this);
    this.trustSafetyRepo = new TrustSafetyRepo(this);
    this.notificationsRepo = new NotificationsRepo(this);
    this.adminRepo = new AdminRepo(this);
  }

  getPool(): pkg.Pool {
    if ((this as any)._customPool) return (this as any)._customPool;
    return getPool();
  }

  public isEnabled(): boolean {
    return isPostgresEnabled();
  }

  public withLock<T = void>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!isPostgresEnabled()) return Promise.resolve(undefined as any);
    if (!this.isHydrated && key !== 'initialization' && !key.startsWith('meta_')) return Promise.resolve(undefined as any);
    const prev = this.locks.get(key) || Promise.resolve();
    const tail = prev.catch(() => {}).then(() => fn());
    this.locks.set(key, tail as any);
    this.pending.set(key, tail as any);
    return tail.finally(() => {
      if (this.pending.get(key) === tail) {
        this.pending.delete(key);
      }
    });
  }

  public async executeInTransaction<T>(fn: (client: pkg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all(Array.from(this.locks.values()).map(p => p.catch(() => {})));
  }

  async runMigrations(): Promise<void> {
    if (!isPostgresEnabled()) return;
    const candidatePaths = [
      path.join(__dirname, 'migration.sql'),
      path.resolve(process.cwd(), 'server', 'db', 'migration.sql')
    ];
    const migrationPath = candidatePaths.find(p => fs.existsSync(p));
    if (!migrationPath) {
      throw new Error(
        `FATAL: Required database migration file (migration.sql) is missing. Searched paths: ${candidatePaths.join(', ')}`
      );
    }
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    if (!sql || !sql.trim()) {
      throw new Error(`FATAL: Database migration file (${migrationPath}) is empty.`);
    }

    if (!isRemotePostgresConfigured()) {
      await this.getPool().query(sql);
      console.log(`[PostgresStore] Migrations executed successfully on embedded PostgreSQL (${getDatabaseName()}).`);
      return;
    }

    const adminPool = createAdminPgPool(getDatabaseName());
    try {
      await adminPool.query(sql);
      const appUser = process.env.SQL_USER || 'ai_studio_app_user';
      await adminPool.query(`
        GRANT ALL ON SCHEMA public TO ${appUser};
        GRANT ALL ON ALL TABLES IN SCHEMA public TO ${appUser};
        GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${appUser};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${appUser};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${appUser};
      `);
      console.log(`[PostgresStore] Migrations executed successfully on ${getDatabaseName()}.`);
    } finally {
      await adminPool.end();
    }
  }

  async isInitialized(): Promise<boolean> {
    if (!isPostgresEnabled()) return false;
    try {
      const res = await this.getPool().query("SELECT value FROM app_metadata WHERE key = 'seed_initialized'");
      return res.rows.length > 0 && !!res.rows[0].value;
    } catch {
      return false;
    }
  }

  async markInitialized(): Promise<void> {
    if (!isPostgresEnabled()) return;
    await this.getPool().query(
      `INSERT INTO app_metadata (key, value, updated_at) 
       VALUES ('seed_initialized', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ initializedAt: new Date().toISOString(), version: 1 })]
    );
  }

  async saveAppMetadata(key: string, value: any): Promise<void> {
    return this.withLock(`meta_${key}`, async () => {
      await this.getPool().query(
        `INSERT INTO app_metadata (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
    });
  }

  async loadAppMetadata<T = any>(key: string): Promise<T | null> {
    if (!isPostgresEnabled()) return null;
    const res = await this.getPool().query('SELECT value FROM app_metadata WHERE key = $1', [key]);
    return res.rows.length > 0 ? (res.rows[0].value as T) : null;
  }

  // --- ORDERS & REVIEWS (Delegated to OrdersRepo) ---
  async saveOrders(orders: Order[]): Promise<void> {
    return this.ordersRepo.saveOrders(orders);
  }

  async listOrders(): Promise<Order[]> {
    return this.ordersRepo.listOrders();
  }

  async saveReviews(reviews: Review[]): Promise<void> {
    return this.ordersRepo.saveReviews(reviews);
  }

  async listReviews(): Promise<Review[]> {
    return this.ordersRepo.listReviews();
  }

  async saveClearingEarning(e: ClearingEarning): Promise<void> {
    const id = 'clr_' + (e.orderId || Math.random().toString(36).substring(2));
    await this.getPool().query(
      `INSERT INTO earnings_clearing (id, order_id, seller_id, amount, clearance_end, status, payout_eligible)
       VALUES ($1, $2, $3, $4, $5, 'clearing', FALSE)
       ON CONFLICT (id) DO UPDATE SET
         amount = EXCLUDED.amount,
         clearance_end = EXCLUDED.clearance_end,
         status = EXCLUDED.status`,
      [id, e.orderId, e.sellerId, e.amount, e.clearsAt]
    );
  }

  async seedEscrow(orderId: string, orderTitle: string, buyerId: string, sellerId: string, amount: number, remaining: number, fundedAt: string): Promise<void> {
    await this.getPool().query(
      `INSERT INTO escrows (order_id, order_title, buyer_id, seller_id, amount, remaining, status, funded_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'held', $7)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, orderTitle, buyerId, sellerId, amount, remaining, fundedAt]
    );
  }

  async listUnclearedEarningsForUser(sellerId: string): Promise<ClearingEarning[]> {
    return this.ordersRepo.listUnclearedEarningsForUser(sellerId);
  }

  async getUnclearedEarningsAmount(sellerId: string): Promise<number> {
    return this.ordersRepo.getUnclearedEarningsAmount(sellerId);
  }

  // --- IDENTITY & USERS (Delegated to IdentityRepo) ---
  async saveUsers(users: User[]): Promise<void> {
    return this.identityRepo.saveUsers(users);
  }

  async listUsers(): Promise<User[]> {
    return this.identityRepo.listUsers();
  }

  async listPublicUsers(): Promise<User[]> {
    return this.identityRepo.listPublicUsers();
  }

  async addUserEmail(em: UserEmail): Promise<void> {
    return this.identityRepo.addUserEmail(em);
  }

  async saveUserEmails(emails: UserEmail[]): Promise<void> {
    return this.identityRepo.saveUserEmails(emails);
  }

  async listUserEmails(): Promise<UserEmail[]> {
    return this.identityRepo.listUserEmails();
  }

  // --- MARKETPLACE: GIGS, PROJECTS, PROPOSALS, CLARIFICATIONS (Delegated to MarketplaceRepo) ---
  async saveGigs(gigs: Gig[]): Promise<void> {
    return this.marketplaceRepo.saveGigs(gigs);
  }

  async listGigs(): Promise<Gig[]> {
    return this.marketplaceRepo.listGigs();
  }

  async saveProjects(projects: Project[]): Promise<void> {
    return this.marketplaceRepo.saveProjects(projects);
  }

  async listProjects(): Promise<Project[]> {
    return this.marketplaceRepo.listProjects();
  }

  async saveProposals(proposals: Proposal[]): Promise<void> {
    return this.marketplaceRepo.saveProposals(proposals);
  }

  async listProposals(): Promise<Proposal[]> {
    return this.marketplaceRepo.listProposals();
  }

  async saveProjectClarifications(clarifications: ProjectClarification[]): Promise<void> {
    return this.marketplaceRepo.saveProjectClarifications(clarifications);
  }

  async listProjectClarifications(): Promise<ProjectClarification[]> {
    return this.marketplaceRepo.listProjectClarifications();
  }

  // --- WORKSPACE, MESSAGES, OFFERS, INVOICES, UPLOADS (Delegated to WorkspaceRepo) ---
  async saveWorkspace(w: any): Promise<void> {
    return this.workspaceRepo.saveWorkspace(w);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    return this.workspaceRepo.deleteWorkspace(workspaceId);
  }

  async saveWorkspaces(workspaces: any[]): Promise<void> {
    return this.workspaceRepo.saveWorkspaces(workspaces);
  }

  async listWorkspaces(): Promise<any[]> {
    return this.workspaceRepo.listWorkspaces();
  }

  async getWorkspace(workspaceId: string): Promise<any | null> {
    return this.workspaceRepo.getWorkspace(workspaceId);
  }

  async saveMessages(messages: Message[]): Promise<void> {
    return this.workspaceRepo.saveMessages(messages);
  }

  async listMessages(): Promise<Message[]> {
    return this.workspaceRepo.listMessages();
  }

  async saveOffers(offers: WorkstreamOffer[]): Promise<void> {
    return this.workspaceRepo.saveOffers(offers);
  }

  async listOffers(): Promise<WorkstreamOffer[]> {
    return this.workspaceRepo.listOffers();
  }

  async getOfferById(id: string): Promise<WorkstreamOffer | undefined> {
    return this.workspaceRepo.getOfferById(id);
  }

  async listOffersForOrder(orderId: string): Promise<WorkstreamOffer[]> {
    return this.workspaceRepo.listOffersForOrder(orderId);
  }

  async saveOffer(o: WorkstreamOffer): Promise<void> {
    return this.workspaceRepo.saveOffer(o);
  }

  async saveCustomInvoices(invoices: CustomInvoice[]): Promise<void> {
    return this.workspaceRepo.saveCustomInvoices(invoices);
  }

  async listCustomInvoices(): Promise<CustomInvoice[]> {
    return this.workspaceRepo.listCustomInvoices();
  }

  async getCustomInvoiceById(id: string): Promise<CustomInvoice | undefined> {
    return this.workspaceRepo.getCustomInvoiceById(id);
  }

  async listCustomInvoicesForUser(userId: string): Promise<CustomInvoice[]> {
    return this.workspaceRepo.listCustomInvoicesForUser(userId);
  }

  async saveCustomInvoice(inv: CustomInvoice): Promise<void> {
    return this.workspaceRepo.saveCustomInvoice(inv);
  }

  async saveUploadRecord(filename: string, record: WorkstreamUploadRecord): Promise<void> {
    return this.workspaceRepo.saveUploadRecord(filename, record);
  }

  async deleteUploadRecord(filename: string): Promise<void> {
    return this.workspaceRepo.deleteUploadRecord(filename);
  }

  async getUploadRecord(filename: string): Promise<WorkstreamUploadRecord | undefined> {
    return this.workspaceRepo.getUploadRecord(filename);
  }

  async listUploadRecords(): Promise<Record<string, WorkstreamUploadRecord>> {
    return this.workspaceRepo.listUploadRecords();
  }

  // --- TRUST & SAFETY: DISPUTES, SUPPORT TICKETS (Delegated to TrustSafetyRepo) ---
  async saveDisputes(disputes: Dispute[]): Promise<void> {
    return this.trustSafetyRepo.saveDisputes(disputes);
  }

  async listDisputes(): Promise<Dispute[]> {
    return this.trustSafetyRepo.listDisputes();
  }

  async getDisputeById(id: string): Promise<Dispute | undefined> {
    return this.trustSafetyRepo.getDisputeById(id);
  }

  async getDisputeByOrderId(orderId: string): Promise<Dispute | undefined> {
    return this.trustSafetyRepo.getDisputeByOrderId(orderId);
  }

  async saveDispute(d: Dispute): Promise<void> {
    return this.trustSafetyRepo.saveDispute(d);
  }

  async saveSupportTickets(tickets: SupportTicket[]): Promise<void> {
    return this.trustSafetyRepo.saveSupportTickets(tickets);
  }

  async listSupportTickets(): Promise<SupportTicket[]> {
    return this.trustSafetyRepo.listSupportTickets();
  }

  async getSupportTicketById(id: string): Promise<SupportTicket | undefined> {
    return this.trustSafetyRepo.getSupportTicketById(id);
  }

  async listSupportTicketsForUser(userId: string): Promise<SupportTicket[]> {
    return this.trustSafetyRepo.listSupportTicketsForUser(userId);
  }

  async saveSupportTicket(t: SupportTicket): Promise<void> {
    return this.trustSafetyRepo.saveSupportTicket(t);
  }

  // --- FINANCE: REFUNDS, PAYOUTS, PAYMENT METHODS, GATEWAYS, LEDGER (Delegated to FinanceRepo) ---
  async saveRefunds(refunds: Refund[]): Promise<void> {
    return this.financeRepo.saveRefunds(refunds);
  }

  async listRefunds(): Promise<Refund[]> {
    return this.financeRepo.listRefunds();
  }

  async savePayout(p: Payout): Promise<void> {
    return this.financeRepo.savePayout(p);
  }

  async getPayoutById(id: string): Promise<Payout | null> {
    return this.financeRepo.getPayoutById(id);
  }

  async listPayoutsForUser(freelancerId: string): Promise<Payout[]> {
    return this.financeRepo.listPayoutsForUser(freelancerId);
  }

  async savePayouts(payouts: Payout[]): Promise<void> {
    return this.financeRepo.savePayouts(payouts);
  }

  async listPayouts(): Promise<Payout[]> {
    return this.financeRepo.listPayouts();
  }

  async getPaymentMethodById(id: string): Promise<PaymentMethodRecord | null> {
    return this.financeRepo.getPaymentMethodById(id);
  }

  async listPaymentMethodsForUser(userId: string): Promise<PaymentMethodRecord[]> {
    return this.financeRepo.listPaymentMethodsForUser(userId);
  }

  async savePaymentMethod(pm: PaymentMethodRecord): Promise<void> {
    return this.financeRepo.savePaymentMethod(pm);
  }

  async deletePaymentMethod(id: string): Promise<void> {
    return this.financeRepo.deletePaymentMethod(id);
  }

  async setDefaultPaymentMethod(userId: string, id: string): Promise<void> {
    return this.financeRepo.setDefaultPaymentMethod(userId, id);
  }

  async savePaymentGateways(gateways: any): Promise<void> {
    return this.financeRepo.savePaymentGateways(gateways);
  }

  async loadPaymentGateways(): Promise<any | null> {
    return this.financeRepo.loadPaymentGateways();
  }

  async saveLedgerState(state: any): Promise<void> {
    return this.financeRepo.saveLedgerState(state);
  }

  async loadLedgerState(): Promise<any | null> {
    return this.financeRepo.loadLedgerState();
  }

  // --- NOTIFICATIONS (Delegated to NotificationsRepo) ---
  async saveNotification(n: Notification): Promise<{ inserted: boolean; duplicate?: boolean }> {
    return this.notificationsRepo.saveNotification(n);
  }

  async listNotificationsForUser(userId: string): Promise<Notification[]> {
    return this.notificationsRepo.listNotificationsForUser(userId);
  }

  async listAllNotifications(): Promise<Notification[]> {
    return this.notificationsRepo.listAllNotifications();
  }

  async markNotificationRead(id: string, userId: string): Promise<void> {
    return this.notificationsRepo.markNotificationRead(id, userId);
  }

  async markAllNotificationsRead(userId: string): Promise<void> {
    return this.notificationsRepo.markAllNotificationsRead(userId);
  }

  // --- ADMIN: AUDIT LOGS, SITE SETTINGS, CATEGORIES (Delegated to AdminRepo) ---
  async addAuditLog(l: AuditLog): Promise<void> {
    return this.adminRepo.addAuditLog(l);
  }

  async saveAuditLogs(logs: AuditLog[]): Promise<void> {
    return this.adminRepo.saveAuditLogs(logs);
  }

  async listAuditLogs(): Promise<AuditLog[]> {
    return this.adminRepo.listAuditLogs();
  }

  async saveSiteSettings(settings: any): Promise<void> {
    return this.adminRepo.saveSiteSettings(settings);
  }

  async loadSiteSettings(): Promise<any | null> {
    return this.adminRepo.loadSiteSettings();
  }

  async saveCategories(categories: any[]): Promise<void> {
    return this.adminRepo.saveCategories(categories);
  }

  async loadCategories(): Promise<any[] | null> {
    return this.adminRepo.loadCategories();
  }

  // --- TEST CLEANUP ---
  async cleanAllData(): Promise<void> {
    if (!isPostgresEnabled()) return;
    const pool = this.getPool();
    const tables = [
      'project_clarifications',
      'notifications',
      'audit_logs',
      'user_emails',
      'support_tickets',
      'payment_methods',
      'clearing_earnings',
      'earnings_clearing',
      'payouts',
      'refunds',
      'disputes',
      'custom_invoices',
      'workstream_offers',
      'workspaces',
      'uploads',
      'reviews',
      'messages',
      'orders',
      'proposals',
      'projects',
      'gigs',
      'users',
      'financial_ledger_state',
      'app_metadata'
    ];
    for (const table of tables) {
      try {
        await pool.query(`TRUNCATE TABLE ${table} CASCADE`);
      } catch {
        try {
          await pool.query(`DELETE FROM ${table}`);
        } catch (delErr: any) {
          console.warn(`[PostgresStore] Notice: table ${table} clean:`, delErr?.message);
        }
      }
    }
    console.log('[PostgresStore] All application tables successfully cleaned in PostgreSQL.');
  }
}

export const postgresStore = new PostgresStore();
