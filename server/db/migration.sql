-- PostgreSQL Schema Migration for WorkPerHour Store & Ledger
-- Run via migration runner or psql

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  username VARCHAR(128),
  email VARCHAR(255) UNIQUE NOT NULL,
  mobile VARCHAR(64),
  role VARCHAR(64) NOT NULL,
  avatar TEXT,
  title VARCHAR(255),
  rating NUMERIC(3,2) DEFAULT 5.0,
  reviews_count INT DEFAULT 0,
  hourly_rate NUMERIC(10,2) DEFAULT 0,
  earned NUMERIC(12,2) DEFAULT 0,
  completed_jobs INT DEFAULT 0,
  bio TEXT,
  skills TEXT[],
  status VARCHAR(32) DEFAULT 'active',
  verified BOOLEAN DEFAULT FALSE,
  email_verified BOOLEAN DEFAULT FALSE,
  mobile_verified BOOLEAN DEFAULT FALSE,
  wallet_balance NUMERIC(12,2) DEFAULT 0,
  created_at VARCHAR(32),
  is_flagged BOOLEAN DEFAULT FALSE,
  flag_reason TEXT,
  password TEXT,
  session_version INT DEFAULT 1,
  known_devices TEXT[],
  is_available_now BOOLEAN DEFAULT FALSE,
  notification_preferences JSONB
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
UPDATE users SET password_hash = password WHERE password_hash IS NULL AND password IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS gigs (
  id VARCHAR(64) PRIMARY KEY,
  freelancer_id VARCHAR(64) NOT NULL,
  freelancer_name VARCHAR(255) NOT NULL,
  freelancer_username VARCHAR(128),
  freelancer_avatar TEXT,
  freelancer_level VARCHAR(64),
  title TEXT NOT NULL,
  slug VARCHAR(255),
  category VARCHAR(128) NOT NULL,
  subcategory VARCHAR(128),
  description TEXT,
  price NUMERIC(12,2) NOT NULL,
  delivery_days INT NOT NULL,
  rating NUMERIC(3,2) DEFAULT 5.0,
  reviews_count INT DEFAULT 0,
  image TEXT,
  cover_image TEXT,
  gallery TEXT[],
  tags TEXT[],
  status VARCHAR(32) DEFAULT 'active',
  featured BOOLEAN DEFAULT FALSE,
  extras JSONB,
  moderation_status VARCHAR(32) DEFAULT 'approved',
  moderation_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Canonical gig statuses: active, paused, moderation, deleted
UPDATE gigs SET status = 'active' WHERE status = 'published';
UPDATE gigs SET status = 'moderation' WHERE status IN ('pending', 'draft') OR (status NOT IN ('active', 'paused', 'deleted') AND moderation_status IN ('pending', 'rejected', 'flagged'));
UPDATE gigs SET status = 'active' WHERE status NOT IN ('active', 'paused', 'moderation', 'deleted');
ALTER TABLE gigs ALTER COLUMN status SET DEFAULT 'active';

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(64) PRIMARY KEY,
  buyer_id VARCHAR(64) NOT NULL,
  buyer_name VARCHAR(255) NOT NULL,
  buyer_avatar TEXT,
  title TEXT NOT NULL,
  slug VARCHAR(255),
  category VARCHAR(128) NOT NULL,
  subcategory VARCHAR(128),
  description TEXT,
  budget_min NUMERIC(12,2) DEFAULT 0,
  budget_max NUMERIC(12,2) DEFAULT 0,
  deadline_days INT,
  proposals_count INT DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  status VARCHAR(32) DEFAULT 'open',
  featured BOOLEAN DEFAULT FALSE,
  moderation_status VARCHAR(32) DEFAULT 'approved',
  moderation_notes TEXT,
  budget_type VARCHAR(32),
  budget NUMERIC(12,2),
  duration VARCHAR(64),
  skills TEXT[],
  max_hires INT DEFAULT 1,
  freelancers_needed INT DEFAULT 1
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_hires INT DEFAULT 1;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS freelancers_needed INT DEFAULT 1;

CREATE TABLE IF NOT EXISTS proposals (
  id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  freelancer_id VARCHAR(64) NOT NULL,
  freelancer_name VARCHAR(255) NOT NULL,
  freelancer_avatar TEXT,
  freelancer_title VARCHAR(255),
  cover_letter TEXT,
  bid_amount NUMERIC(12,2) NOT NULL,
  delivery_days INT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  status VARCHAR(32) DEFAULT 'pending',
  workstream_order_id VARCHAR(64),
  offer_id VARCHAR(64)
);

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS workstream_order_id VARCHAR(64);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS offer_id VARCHAR(64);

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(64) PRIMARY KEY,
  title TEXT NOT NULL,
  buyer_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  due_date VARCHAR(32) NOT NULL,
  completed_at VARCHAR(32),
  requirements TEXT,
  deliverables TEXT,
  deliverable_files JSONB,
  revisions JSONB,
  admin_notes TEXT,
  is_muted BOOLEAN DEFAULT FALSE,
  escrow_protection_start_date VARCHAR(32),
  escrow_protection_end_date VARCHAR(32),
  gig_id VARCHAR(64),
  project_id VARCHAR(64),
  service_url TEXT,
  gig_slug VARCHAR(128),
  seller_username VARCHAR(128),
  buyer_username VARCHAR(128),
  service_title TEXT,
  service_thumbnail TEXT,
  is_timer_paused BOOLEAN DEFAULT FALSE,
  fee_breakdown JSONB,
  delivery_history JSONB,
  delivery_notes TEXT,
  delivery_reference TEXT,
  accepted_version INT,
  review_window_days INT,
  review_window_expires_at VARCHAR(32),
  review JSONB,
  service_fee NUMERIC(10,2) DEFAULT 0,
  small_order_fee NUMERIC(10,2) DEFAULT 0
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_fee NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS small_order_fee NUMERIC(10,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  sender_id VARCHAR(64) NOT NULL,
  sender_name VARCHAR(255) NOT NULL,
  text TEXT NOT NULL,
  timestamp VARCHAR(64) NOT NULL,
  type VARCHAR(32) DEFAULT 'message',
  file_info JSONB,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS reviews (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64),
  reviewer_id VARCHAR(64),
  reviewer_name VARCHAR(255),
  reviewer_avatar TEXT,
  target_user_id VARCHAR(64),
  rating INT NOT NULL,
  comment TEXT,
  order_title TEXT,
  gig_id VARCHAR(64),
  project_id VARCHAR(64),
  created_at VARCHAR(32),
  updated_at VARCHAR(32),
  is_cancelled_order BOOLEAN DEFAULT FALSE,
  reply JSONB
);

CREATE TABLE IF NOT EXISTS uploads (
  filename VARCHAR(255) PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  original_name VARCHAR(255),
  mime VARCHAR(128),
  size BIGINT,
  created_at VARCHAR(32) NOT NULL,
  sha256 VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id VARCHAR(64) PRIMARY KEY,
  buyer_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  order_ids JSONB DEFAULT '[]'::jsonb,
  title TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  last_activity_at VARCHAR(32),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS workstream_offers (
  id VARCHAR(64) PRIMARY KEY,
  number VARCHAR(32),
  order_id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64),
  kind VARCHAR(32) NOT NULL,
  title TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  delivery_days INT,
  status VARCHAR(32) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  resolved_at VARCHAR(32),
  resolved_by VARCHAR(64),
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS custom_invoices (
  id VARCHAR(64) PRIMARY KEY,
  invoice_number VARCHAR(64) NOT NULL,
  buyer_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(32) NOT NULL,
  description TEXT,
  created_at VARCHAR(32) NOT NULL,
  paid_at VARCHAR(32),
  related_order_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS disputes (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  buyer_id VARCHAR(64),
  seller_id VARCHAR(64),
  raised_by VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT,
  status VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  resolution_notes TEXT,
  resolution_type VARCHAR(64),
  notes TEXT,
  assigned_to VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS refunds (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  buyer_id VARCHAR(64) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  reason TEXT,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id VARCHAR(64) PRIMARY KEY,
  freelancer_id VARCHAR(64) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  method VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  account_details TEXT,
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(255) NOT NULL,
  subject TEXT NOT NULL,
  priority VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  messages JSONB DEFAULT '[]'::jsonb,
  is_appeal BOOLEAN DEFAULT FALSE,
  category VARCHAR(64),
  appeal_context JSONB
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  actor VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL,
  action VARCHAR(255) NOT NULL,
  target VARCHAR(255) NOT NULL,
  details TEXT,
  timestamp VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS user_emails (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT,
  body TEXT NOT NULL,
  type VARCHAR(64),
  sent_at VARCHAR(64),
  date VARCHAR(64),
  read BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS site_settings (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_gateways (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS financial_ledger_state (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_order_id ON messages(order_id);
CREATE INDEX IF NOT EXISTS idx_reviews_target_user_id ON reviews(target_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_id ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller_id ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_proposals_project_id ON proposals(project_id);
CREATE INDEX IF NOT EXISTS idx_offers_order_id ON workstream_offers(order_id);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  type VARCHAR(64) NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read BOOLEAN DEFAULT FALSE,
  created_at VARCHAR(64) NOT NULL,
  dedup_key VARCHAR(255) UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_review JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS previous_status VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gig_order_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS project_order_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS proposal_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_order_proposal_id
ON orders (proposal_id)
WHERE proposal_id IS NOT NULL AND status NOT IN ('cancelled', 'refunded');
ALTER TABLE orders ADD COLUMN IF NOT EXISTS extension_requests JSONB DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_extension_used BOOLEAN DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_request JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_history JSONB DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_type VARCHAR(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_window_restarted_at VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS response_deadline VARCHAR(64);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS workstream_order_id VARCHAR(64);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(32);
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS order_id VARCHAR(64);
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_orders_workspace_id ON orders(workspace_id);

CREATE TABLE IF NOT EXISTS project_clarifications (
  id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(255) NOT NULL,
  user_avatar TEXT,
  text TEXT NOT NULL,
  timestamp VARCHAR(64) NOT NULL,
  replies JSONB DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_clarifications_project_id ON project_clarifications(project_id);

CREATE TABLE IF NOT EXISTS wallets (
  user_id VARCHAR(64) PRIMARY KEY,
  user_name VARCHAR(255) NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  user_role VARCHAR(64) NOT NULL,
  available_balance NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  funds_on_hold NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  pending_withdrawals NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  status VARCHAR(32) DEFAULT 'active' NOT NULL,
  restriction_reason TEXT,
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_movements (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  type VARCHAR(32) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  code VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO ledger_accounts (code, name, type) VALUES
  ('1010', 'Operating Cash & Bank', 'ASSET'),
  ('1020', 'Payment Processor Clearing', 'ASSET'),
  ('2010', 'Buyer Wallets Payable', 'LIABILITY'),
  ('2020', 'Freelancer Wallets Payable', 'LIABILITY'),
  ('2030', 'Escrow Liability', 'LIABILITY'),
  ('2040', 'Pending Payout Liability', 'LIABILITY'),
  ('2050', 'Pending Seller Clearance', 'LIABILITY'),
  ('4010', 'Platform Commission Revenue', 'REVENUE'),
  ('4020', 'Buyer Service Fee Revenue', 'REVENUE'),
  ('4030', 'Small Order Fee Revenue', 'REVENUE'),
  ('4040', 'Other Platform Revenue', 'REVENUE'),
  ('5010', 'Payment Processing Expense', 'EXPENSE'),
  ('5020', 'Dispute Loss Expense', 'EXPENSE')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ledger_journals (
  id VARCHAR(64) PRIMARY KEY,
  reference VARCHAR(128) NOT NULL,
  description TEXT,
  event_type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(255) UNIQUE,
  actor VARCHAR(255),
  reversed_at TIMESTAMPTZ,
  reversed_by_journal_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ledger_journals ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE ledger_journals ADD COLUMN IF NOT EXISTS reversed_by_journal_id VARCHAR(64);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id VARCHAR(64) PRIMARY KEY,
  journal_id VARCHAR(64) NOT NULL REFERENCES ledger_journals(id) ON DELETE CASCADE,
  account_code VARCHAR(32) NOT NULL,
  debit NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  credit NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD' NOT NULL,
  description TEXT,
  user_id VARCHAR(64),
  order_id VARCHAR(64),
  payout_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS escrows (
  order_id VARCHAR(64) PRIMARY KEY,
  order_title TEXT NOT NULL,
  buyer_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  remaining NUMERIC(14,2) NOT NULL,
  refunded_total NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  released_gross NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  refund_seq INT DEFAULT 0 NOT NULL,
  release_seq INT DEFAULT 0 NOT NULL,
  status VARCHAR(32) DEFAULT 'held' NOT NULL,
  funded_at TIMESTAMPTZ DEFAULT NOW(),
  commission_percent NUMERIC(5,2) DEFAULT 20.00 NOT NULL,
  service_fee NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  small_order_fee NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  fees_refunded BOOLEAN DEFAULT FALSE NOT NULL
);

CREATE TABLE IF NOT EXISTS earnings_clearing (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  clearance_start TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  clearance_end TIMESTAMPTZ NOT NULL,
  status VARCHAR(32) DEFAULT 'clearing' NOT NULL,
  payout_eligible BOOLEAN DEFAULT FALSE NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_idempotency (
  key TEXT PRIMARY KEY,
  operation TEXT,
  status TEXT,
  result JSONB,
  request_fingerprint JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE financial_idempotency ADD COLUMN IF NOT EXISTS request_fingerprint JSONB;
ALTER TABLE financial_idempotency ALTER COLUMN request_fingerprint TYPE JSONB USING request_fingerprint::jsonb;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS account_details TEXT;
DROP INDEX IF EXISTS idx_unique_earnings_clearing_order;
CREATE INDEX IF NOT EXISTS idx_earnings_clearing_order ON earnings_clearing (order_id);

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS pending_balance NUMERIC(14,2) DEFAULT 0.00 NOT NULL;





CREATE TABLE IF NOT EXISTS runtime_diagnostic_logs (
  id VARCHAR(64) PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  severity VARCHAR(16) NOT NULL,
  service VARCHAR(64) NOT NULL,
  function_name VARCHAR(128) NOT NULL,
  implementation VARCHAR(64),
  operation VARCHAR(64) NOT NULL,
  request_id VARCHAR(64),
  outcome VARCHAR(32),
  error_message TEXT,
  details JSONB
);

CREATE INDEX IF NOT EXISTS idx_diagnostics_timestamp ON runtime_diagnostic_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_diagnostics_severity ON runtime_diagnostic_logs(severity);
CREATE INDEX IF NOT EXISTS idx_diagnostics_operation ON runtime_diagnostic_logs(operation);
CREATE INDEX IF NOT EXISTS idx_diagnostics_request_id ON runtime_diagnostic_logs(request_id);

CREATE TABLE IF NOT EXISTS payment_methods (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  type VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  is_default BOOLEAN DEFAULT FALSE,
  created_at VARCHAR(32) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_user_id ON payment_methods(user_id);

CREATE TABLE IF NOT EXISTS clearing_earnings (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  seller_id VARCHAR(64) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  clears_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(32) DEFAULT 'clearing' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clearing_earnings_seller ON clearing_earnings(seller_id, clears_at);
CREATE INDEX IF NOT EXISTS idx_clearing_earnings_order ON clearing_earnings(order_id);

CREATE TABLE IF NOT EXISTS auth_verification_codes (
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'verify',
  attempts INT NOT NULL DEFAULT 0,
  last_resend_at BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, type)
);

DO $$ BEGIN
  ALTER TABLE auth_verification_codes DROP CONSTRAINT IF EXISTS auth_verification_codes_pkey;
  ALTER TABLE auth_verification_codes ADD PRIMARY KEY (email, type);
  ALTER TABLE auth_verification_codes ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
  ALTER TABLE auth_verification_codes ADD COLUMN IF NOT EXISTS last_resend_at BIGINT NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payment_checkout_sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64),
  gateway VARCHAR(32) NOT NULL,
  expected_amount NUMERIC(14,2) NOT NULL CHECK (expected_amount > 0),
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  purpose VARCHAR(32) NOT NULL DEFAULT 'deposit',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  provider_tx_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_checkout_sessions_user ON payment_checkout_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_checkout_sessions_status ON payment_checkout_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_checkout_sessions_provider_tx_id ON payment_checkout_sessions (provider_tx_id) WHERE provider_tx_id IS NOT NULL AND status = 'completed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_order_reviewer ON reviews (order_id, reviewer_id) WHERE order_id IS NOT NULL AND reviewer_id IS NOT NULL;

-- Referential Integrity Foreign Key Constraints
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_id VARCHAR(64);
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS freelancer_id VARCHAR(64);
  UPDATE orders SET client_id = buyer_id WHERE client_id IS NULL AND buyer_id IS NOT NULL;
  UPDATE orders SET freelancer_id = seller_id WHERE freelancer_id IS NULL AND seller_id IS NOT NULL;
  ALTER TABLE orders ADD CONSTRAINT fk_orders_buyer FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT fk_orders_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT fk_orders_client FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT fk_orders_freelancer FOREIGN KEY (freelancer_id) REFERENCES users(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE escrows ADD CONSTRAINT fk_escrows_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE proposals ADD CONSTRAINT fk_proposals_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE proposals ADD CONSTRAINT fk_proposals_freelancer FOREIGN KEY (freelancer_id) REFERENCES users(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE reviews ADD CONSTRAINT fk_reviews_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE disputes ADD CONSTRAINT fk_disputes_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ledger_entries ADD CONSTRAINT fk_ledger_entries_journal FOREIGN KEY (journal_id) REFERENCES ledger_journals(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Authoritative Financial Database CHECK Constraints
DO $$ BEGIN
  ALTER TABLE wallets ADD CONSTRAINT check_wallets_available_balance CHECK (available_balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE wallets ADD CONSTRAINT check_wallets_funds_on_hold CHECK (funds_on_hold >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE wallets ADD CONSTRAINT check_wallets_pending_withdrawals CHECK (pending_withdrawals >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE escrows ADD CONSTRAINT check_escrows_amount CHECK (amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE escrows ADD CONSTRAINT check_escrows_remaining CHECK (remaining >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE payouts ADD CONSTRAINT check_payouts_amount CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE refunds ADD CONSTRAINT check_refunds_amount CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE earnings_clearing ADD CONSTRAINT check_earnings_clearing_amount CHECK (amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ledger_entries ADD CONSTRAINT check_ledger_entries_debit CHECK (debit >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ledger_entries ADD CONSTRAINT check_ledger_entries_credit CHECK (credit >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id VARCHAR(64) PRIMARY KEY,
  type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  amount NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
  currency VARCHAR(8) DEFAULT 'USD' NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(32) DEFAULT 'open' NOT NULL,
  assigned_to VARCHAR(128),
  investigation_notes TEXT,
  resolved_by VARCHAR(255),
  resolved_at VARCHAR(64),
  detected_at VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_status ON reconciliation_exceptions(status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_entity ON reconciliation_exceptions(entity_id);

DO $$ BEGIN
  ALTER TABLE workstream_offers ADD CONSTRAINT fk_offers_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE messages ADD CONSTRAINT fk_messages_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE uploads ADD CONSTRAINT fk_uploads_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_uploads_order_id ON uploads(order_id);
CREATE INDEX IF NOT EXISTS idx_uploads_owner_id ON uploads(owner_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_messages_client_msg_id 
ON messages (order_id, sender_id, (metadata->>'clientMessageId')) 
WHERE metadata->>'clientMessageId' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_workstream_offers_number
ON workstream_offers (number)
WHERE number IS NOT NULL;

ALTER TABLE payouts ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
