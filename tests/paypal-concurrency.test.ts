import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { postgresStore } from '../server/db/postgresStore.js';
import {
  ensurePaymentCheckoutSchema,
  settleCompletedCheckoutSession,
  handlePaymentWebhook
} from '../server/domains/finance/finance.routes.ts';
import { financialRepository } from '../server/domains/finance/financial.service.ts';
import { paymentGatewayManager } from '../server/domains/finance/paymentGateways.ts';

async function runConcurrencyTests() {
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_SIMULATION_ENABLED = 'true';
  console.log('================================================================================');
  console.log('  FivePA — PayPal Parallel Concurrency & Race-Condition Integrity Test Suite   ');
  console.log('================================================================================\n');

  await postgresStore.runMigrations();
  const pool = postgresStore.getPool();
  await ensurePaymentCheckoutSchema(pool);

  const testBuyerId = 'u_conc_buyer_99';
  const testSellerId = 'u_conc_seller_88';

  await pool.query(
    `INSERT INTO users (id, name, email, role, wallet_balance, status)
     VALUES ($1, 'Conc Buyer', 'conc_buyer@example.com', 'buyer', 0.00, 'active')
     ON CONFLICT (id) DO UPDATE SET wallet_balance = 0.00`,
    [testBuyerId]
  );

  await pool.query(
    `INSERT INTO users (id, name, email, role, wallet_balance, status)
     VALUES ($1, 'Conc Seller', 'conc_seller@example.com', 'seller', 0.00, 'active')
     ON CONFLICT (id) DO UPDATE SET wallet_balance = 0.00`,
    [testSellerId]
  );

  // Reset test tables
  await pool.query('DELETE FROM wallets WHERE user_id IN ($1, $2)', [testBuyerId, testSellerId]);
  await pool.query('DELETE FROM payment_checkout_sessions WHERE user_id IN ($1, $2)', [testBuyerId, testSellerId]);
  await pool.query("DELETE FROM payment_webhook_events WHERE event_id LIKE 'WH-CONC-%'");
  await pool.query("DELETE FROM financial_idempotency WHERE key LIKE '%CONC%' OR key LIKE '%chk_conc_%'");

  // Configure PayPal gateway in sandbox mode with explicit secret for HMAC testing
  const sandboxWebhookSecret = 'WH_CONC_SECRET_9999';
  await paymentGatewayManager.updateGateway('sandbox', 'paypal', {
    enabled: true,
    clientId: 'test_paypal_conc_client_id',
    clientSecret: 'test_paypal_conc_secret_123',
    webhookId: sandboxWebhookSecret,
    primary: true
  });

  // Enable signature verification using real HMAC algorithm in simulation mode
  paymentGatewayManager.verifyWebhookSignature = async (params) => {
    const secret = sandboxWebhookSecret;
    const bodyStr = typeof params.rawBody === 'string' ? params.rawBody : params.rawBody.toString('utf8');
    const sig = String(params.headers['x-webhook-signature'] || '').trim();
    if (!sig) return true; // Fallback for basic test calls
    const expectedSig = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
    return sig.toLowerCase() === expectedSig.toLowerCase();
  };

  paymentGatewayManager.verifyPaymentEvent = async (params) => ({
    verified: true,
    status: 'COMPLETED',
    amount: params.expectedAmount,
    currency: 'USD',
    captureId: params.transactionId
  });

  // =========================================================================
  // TEST 1: Parallel Webhook & Return-Page Capture Race Condition (Promise.all)
  // =========================================================================
  console.log('Scenario 1: Testing Parallel Webhook vs Return-Page Capture Race Condition (Promise.all)...');

  const sess1Id = 'chk_conc_race_1';
  await pool.query(
    `INSERT INTO payment_checkout_sessions
       (id, user_id, gateway, expected_amount, currency, purpose, status, provider_tx_id, paypal_order_id, environment)
     VALUES ($1, $2, 'paypal', 75.00, 'USD', 'deposit', 'pending', 'PP_ORD_RACE_1', 'PP_ORD_RACE_1', 'sandbox')`,
    [sess1Id, testBuyerId]
  );

  // Launch return-page settlement AND webhook delivery SIMULTANEOUSLY
  const [resWeb, resReturn] = await Promise.all([
    settleCompletedCheckoutSession({
      sessionId: sess1Id,
      gateway: 'paypal',
      txId: 'CAP_RACE_1',
      paypalOrderId: 'PP_ORD_RACE_1',
      paypalCaptureId: 'CAP_RACE_1',
      paidAmount: 75.00,
      paidCurrency: 'USD',
      expectedUserId: testBuyerId,
      preVerifiedSessionId: sess1Id,
      preExpectedAmount: 75.00,
      actor: 'Parallel Webhook',
      source: 'webhook'
    }),
    settleCompletedCheckoutSession({
      sessionId: sess1Id,
      gateway: 'paypal',
      txId: 'CAP_RACE_1',
      paypalOrderId: 'PP_ORD_RACE_1',
      paypalCaptureId: 'CAP_RACE_1',
      paidAmount: 75.00,
      paidCurrency: 'USD',
      expectedUserId: testBuyerId,
      preVerifiedSessionId: sess1Id,
      preExpectedAmount: 75.00,
      actor: 'Parallel Return Page',
      source: 'gateway'
    })
  ]);

  assert.equal(resWeb.received, true, 'Webhook call must receive OK');
  assert.equal(resReturn.received, true, 'Return page call must receive OK');

  // Verify wallet balance is credited EXACTLY ONCE ($75.00)
  const bal1 = await financialRepository.getWalletBalance(testBuyerId);
  assert.equal(bal1, 75.00, 'Wallet balance must be credited exactly $75.00 (no double credit)');

  console.log('✓ PASS: Simultaneous webhook and return-page capture credited buyer wallet exactly once ($75.00).\n');

  // =========================================================================
  // TEST 2: 5 Simultaneous Duplicate Webhook Deliveries (Promise.all)
  // =========================================================================
  console.log('Scenario 2: Testing 5 Simultaneous Duplicate Webhook Deliveries (Promise.all)...');

  const sess2Id = 'chk_conc_dup_2';
  await pool.query(
    `INSERT INTO payment_checkout_sessions
       (id, user_id, gateway, expected_amount, currency, purpose, status, provider_tx_id, paypal_order_id, environment)
     VALUES ($1, $2, 'paypal', 30.00, 'USD', 'deposit', 'pending', 'PP_ORD_DUP_2', 'PP_ORD_DUP_2', 'sandbox')`,
    [sess2Id, testBuyerId]
  );

  const duplicateWebhooks = Array.from({ length: 5 }, (_, i) => ({
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    id: `WH-CONC-EVT-${i + 1}`,
    resource: {
      id: 'CAP_DUP_2',
      status: 'COMPLETED',
      amount: { value: '30.00', currency_code: 'USD' },
      custom_id: sess2Id,
      supplementary_data: { related_ids: { order_id: 'PP_ORD_DUP_2' } }
    }
  }));

  const webhookResults = await Promise.all(
    duplicateWebhooks.map(p => {
      const payloadStr = JSON.stringify(p);
      const hmacSig = crypto.createHmac('sha256', sandboxWebhookSecret).update(payloadStr).digest('hex');
      const reqHeaders = { 'x-webhook-signature': hmacSig, 'content-type': 'application/json' };
      const req: any = { query: { gateway: 'paypal' }, headers: reqHeaders, body: Buffer.from(payloadStr) };
      let code = 200;
      let body: any = null;
      const res: any = { status: (c: number) => { code = c; return res; }, json: (d: any) => { body = d; return res; } };
      return handlePaymentWebhook(req, res).then(() => ({ code, body }));
    })
  );

  webhookResults.forEach(r => {
    assert.equal(r.code, 200, 'Every concurrent webhook response must return HTTP 200');
  });

  const bal2 = await financialRepository.getWalletBalance(testBuyerId);
  assert.equal(bal2, 105.00, 'Wallet balance must increase by $30.00 exactly once (total $105.00)');

  console.log('✓ PASS: 5 simultaneous duplicate webhooks processed safely with HMAC verification & exact $30.00 credit.\n');

  // =========================================================================
  // TEST 3: Concurrent Checkout Sessions for Two Distinct Orders
  // =========================================================================
  console.log('Scenario 3: Testing Concurrent Checkout Sessions for Distinct Orders...');

  const sess3A = 'chk_conc_ord_3A';
  const sess3B = 'chk_conc_ord_3B';

  await pool.query(
    `INSERT INTO payment_checkout_sessions
       (id, user_id, gateway, expected_amount, currency, purpose, status, provider_tx_id, paypal_order_id, environment)
     VALUES 
       ($1, $2, 'paypal', 40.00, 'USD', 'deposit', 'pending', 'PP_ORD_3A', 'PP_ORD_3A', 'sandbox'),
       ($3, $2, 'paypal', 60.00, 'USD', 'deposit', 'pending', 'PP_ORD_3B', 'PP_ORD_3B', 'sandbox')`,
    [sess3A, testBuyerId, sess3B]
  );

  await Promise.all([
    settleCompletedCheckoutSession({
      sessionId: sess3A,
      gateway: 'paypal',
      txId: 'CAP_3A',
      paypalOrderId: 'PP_ORD_3A',
      paypalCaptureId: 'CAP_3A',
      paidAmount: 40.00,
      paidCurrency: 'USD',
      expectedUserId: testBuyerId,
      preVerifiedSessionId: sess3A,
      preExpectedAmount: 40.00,
      actor: 'Distinct Order 3A',
      source: 'gateway'
    }),
    settleCompletedCheckoutSession({
      sessionId: sess3B,
      gateway: 'paypal',
      txId: 'CAP_3B',
      paypalOrderId: 'PP_ORD_3B',
      paypalCaptureId: 'CAP_3B',
      paidAmount: 60.00,
      paidCurrency: 'USD',
      expectedUserId: testBuyerId,
      preVerifiedSessionId: sess3B,
      preExpectedAmount: 60.00,
      actor: 'Distinct Order 3B',
      source: 'gateway'
    })
  ]);

  const bal3 = await financialRepository.getWalletBalance(testBuyerId);
  assert.equal(bal3, 205.00, 'Wallet balance must reflect both distinct settlements ($105 + $40 + $60 = $205.00)');

  console.log('✓ PASS: Two distinct concurrent order payments settled correctly ($205.00 final balance).\n');

  // =========================================================================
  // TEST 4: Atomic Concurrent Checkout Creation for Same Order (Promise.all)
  // =========================================================================
  console.log('Scenario 4: Testing Atomic Concurrent Checkout Creation for Same Order (Promise.all)...');

  const testOrderId = 'ord_conc_atomic_100';
  await pool.query(
    `INSERT INTO orders (id, title, buyer_id, seller_id, amount, status, fee_breakdown, created_at, due_date)
     VALUES ($1, 'Atomic Order', $2, $3, 100.00, 'payment_pending', '{"clientTotal": 105.00}', NOW(), NOW() + INTERVAL '7 days')
     ON CONFLICT (id) DO UPDATE SET status = 'payment_pending'`,
    [testOrderId, testBuyerId, testSellerId]
  );

  // Directly test database atomic reservation query under transaction locks
  const [sessResA, sessResB] = await Promise.all([
    postgresStore.executeInTransaction(async (client) => {
      await client.query('SELECT id FROM orders WHERE id = $1::text FOR UPDATE', [testOrderId]);
      const existing = await client.query(
        `SELECT * FROM payment_checkout_sessions WHERE order_id = $1::text AND status IN ('pending', 'approved') LIMIT 1`,
        [testOrderId]
      );
      if (existing.rows.length > 0) return { reused: true, session: existing.rows[0] };
      const newId = 'chk_atomic_A';
      await client.query(
        `INSERT INTO payment_checkout_sessions (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, environment)
         VALUES ($1, $2, $3, 'paypal', 105.00, 'USD', 'order_payment', 'pending', 'sandbox')`,
        [newId, testBuyerId, testOrderId]
      );
      return { reused: false, session: { id: newId } };
    }),
    postgresStore.executeInTransaction(async (client) => {
      await client.query('SELECT id FROM orders WHERE id = $1::text FOR UPDATE', [testOrderId]);
      const existing = await client.query(
        `SELECT * FROM payment_checkout_sessions WHERE order_id = $1::text AND status IN ('pending', 'approved') LIMIT 1`,
        [testOrderId]
      );
      if (existing.rows.length > 0) return { reused: true, session: existing.rows[0] };
      const newId = 'chk_atomic_B';
      await client.query(
        `INSERT INTO payment_checkout_sessions (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, environment)
         VALUES ($1, $2, $3, 'paypal', 105.00, 'USD', 'order_payment', 'pending', 'sandbox')`,
        [newId, testBuyerId, testOrderId]
      );
      return { reused: false, session: { id: newId } };
    })
  ]);

  // One of the calls MUST be created (reused: false) and the other MUST be reused (reused: true)
  assert.ok(
    (sessResA.reused === false && sessResB.reused === true) || (sessResA.reused === true && sessResB.reused === false),
    'Atomic lock must ensure exactly one session is created and the second is atomically reused'
  );

  const dbSessions = await pool.query('SELECT id FROM payment_checkout_sessions WHERE order_id = $1::text', [testOrderId]);
  assert.equal(dbSessions.rows.length, 1, 'Database must contain exactly 1 checkout session row for this order');

  console.log('✓ PASS: Atomic concurrent checkout creation verified under row-level database lock (1 session created, 1 reused).\n');

  console.log('================================================================================');
  console.log('  ALL PAYPAL CONCURRENCY & RACE-CONDITION TESTS PASSED SUCCESSFULLY!            ');
  console.log('================================================================================\n');

  process.exit(0);
}

runConcurrencyTests().catch(err => {
  console.error('CRITICAL: PayPal concurrency test failed:', err);
  process.exit(1);
});
