import assert from 'node:assert/strict';
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

  // Configure PayPal gateway in sandbox mode
  await paymentGatewayManager.updateGateway('sandbox', 'paypal', {
    enabled: true,
    clientId: 'test_paypal_conc_client_id',
    clientSecret: 'test_paypal_conc_secret_123',
    webhookId: 'WH_CONC_9999',
    primary: true
  });

  // Stub signature verification for webhook testing
  paymentGatewayManager.verifyWebhookSignature = async () => true;
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

  const reqHeaders = { 'paypal-transmission-id': 'tx-dup-1', 'paypal-transmission-sig': 'sig-dup-1' };

  const webhookResults = await Promise.all(
    duplicateWebhooks.map(p => {
      const req: any = { query: { gateway: 'paypal' }, headers: { 'content-type': 'application/json', ...reqHeaders }, body: Buffer.from(JSON.stringify(p)) };
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

  console.log('✓ PASS: 5 simultaneous duplicate webhooks processed safely with exact $30.00 credit.\n');

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

  console.log('================================================================================');
  console.log('  ALL PAYPAL CONCURRENCY & RACE-CONDITION TESTS PASSED SUCCESSFULLY!            ');
  console.log('================================================================================\n');

  process.exit(0);
}

runConcurrencyTests().catch(err => {
  console.error('CRITICAL: PayPal concurrency test failed:', err);
  process.exit(1);
});
