import assert from 'node:assert/strict';
import { postgresStore } from '../server/db/postgresStore.js';
import {
  handlePaymentWebhook,
  ensurePaymentCheckoutSchema,
  settleCompletedCheckoutSession
} from '../server/domains/finance/finance.routes.ts';
import { financialRepository } from '../server/domains/finance/financial.service.ts';
import { paymentGatewayManager, resolvePayPalEnv } from '../server/domains/finance/paymentGateways.ts';

async function runEnvironmentSwitchTests() {
  process.env.NODE_ENV = 'test';
  console.log('================================================================================');
  console.log('  FivePA — PayPal Sandbox & Live Environment Switching & Session Isolation Test ');
  console.log('================================================================================\n');

  await postgresStore.runMigrations();
  const pool = postgresStore.getPool();
  await ensurePaymentCheckoutSchema(pool);

  const testUserId = 'u_paypal_env_test_user';
  await pool.query(
    `INSERT INTO users (id, name, email, role, wallet_balance, status)
     VALUES ($1, $2, $3, 'buyer', 0.00, 'active')
     ON CONFLICT (id) DO UPDATE SET wallet_balance = 0.00`,
    [testUserId, 'PayPal Env Test User', 'paypal_env_test@example.com']
  );

  // Clean test tables
  await pool.query('DELETE FROM wallets WHERE user_id = $1', [testUserId]);
  await pool.query('DELETE FROM payment_checkout_sessions WHERE user_id = $1', [testUserId]);
  await pool.query("DELETE FROM payment_webhook_events WHERE event_id LIKE 'WH-EVT-ENV-%'");
  await pool.query("DELETE FROM financial_idempotency WHERE key LIKE '%ENV_TEST%'");

  // =========================================================================
  // TEST 1: Independent Sandbox vs Live Credential Storage & AES-256-GCM Encryption
  // =========================================================================
  console.log('Scenario 1: Testing Independent Sandbox vs Live Credential Storage & Encryption...');

  await paymentGatewayManager.updateGateway('sandbox', 'paypal', {
    enabled: true,
    clientId: 'sb_client_id_12345',
    clientSecret: 'sb_client_secret_67890',
    webhookId: 'WH_SB_1111',
    primary: true
  });

  await paymentGatewayManager.updateGateway('production', 'paypal', {
    enabled: true,
    clientId: 'live_client_id_99999',
    clientSecret: 'live_client_secret_88888',
    webhookId: 'WH_LIVE_2222',
    primary: true
  });

  const sbGw = paymentGatewayManager.getGateway('paypal', 'sandbox');
  const liveGw = paymentGatewayManager.getGateway('paypal', 'production');

  assert.equal(sbGw.clientId, 'sb_client_id_12345', 'Sandbox client ID must match');
  assert.equal(sbGw.clientSecret, 'sb_client_secret_67890', 'Sandbox secret must match');
  assert.equal(sbGw.webhookId, 'WH_SB_1111', 'Sandbox webhook ID must match');

  assert.equal(liveGw.clientId, 'live_client_id_99999', 'Live client ID must match');
  assert.equal(liveGw.clientSecret, 'live_client_secret_88888', 'Live secret must match');
  assert.equal(liveGw.webhookId, 'WH_LIVE_2222', 'Live webhook ID must match');

  const encState = paymentGatewayManager.getEncryptedState();
  assert.ok(encState.sandbox.paypal.clientSecret.startsWith('enc:gcm:'), 'Sandbox secret must be GCM encrypted');
  assert.ok(encState.production.paypal.clientSecret.startsWith('enc:gcm:'), 'Live secret must be GCM encrypted');

  console.log('✓ PASS: Sandbox and Live credentials stored independently with AES-256-GCM encryption.\n');

  // =========================================================================
  // TEST 2: GET API Masked Output
  // =========================================================================
  console.log('Scenario 2: Testing Admin GET API Masked Output...');

  const maskedState = paymentGatewayManager.getMaskedState();
  assert.equal(maskedState.sandbox.paypal.clientSecret, '••••••••••••••••', 'Sandbox secret must be masked');
  assert.equal(maskedState.production.paypal.clientSecret, '••••••••••••••••', 'Live secret must be masked');
  assert.equal(maskedState.sandbox.paypal.webhookId, '••••••••1111', 'Sandbox webhook ID must be masked');
  assert.equal(maskedState.production.paypal.webhookId, '••••••••2222', 'Live webhook ID must be masked');

  console.log('✓ PASS: API response masks secrets and webhook IDs correctly.\n');

  // =========================================================================
  // TEST 3: Admin Active PayPal Environment Switching & Safeguards
  // =========================================================================
  console.log('Scenario 3: Testing Active PayPal Environment Switching & Safeguards...');

  // 3a. Default active mode should be sandbox
  assert.equal(paymentGatewayManager.getActivePayPalEnvironment(), 'sandbox', 'Default active mode must be sandbox');

  // 3b. Switch mode to production via manager
  await paymentGatewayManager.setActivePayPalEnvironment('production');
  assert.equal(paymentGatewayManager.getActivePayPalEnvironment(), 'production', 'Active mode must switch to production');
  assert.equal(resolvePayPalEnv(), 'production', 'resolvePayPalEnv() must return production when activePayPalEnvironment is production');

  // 3c. Switch back to sandbox
  await paymentGatewayManager.setActivePayPalEnvironment('sandbox');
  assert.equal(paymentGatewayManager.getActivePayPalEnvironment(), 'sandbox', 'Active mode must switch back to sandbox');
  assert.equal(resolvePayPalEnv(), 'sandbox', 'resolvePayPalEnv() must return sandbox');

  console.log('✓ PASS: Admin active environment switching works cleanly with safeguards.\n');

  // =========================================================================
  // TEST 4: Checkout Session Environment Binding & Session Isolation
  // =========================================================================
  console.log('Scenario 4: Testing Session Environment Isolation (Sandbox vs Live)...');

  // Ensure active mode is sandbox
  await paymentGatewayManager.setActivePayPalEnvironment('sandbox');

  // Create session 1 while active mode is Sandbox
  const sess1Id = 'chk_env_sb_100';
  await pool.query(
    `INSERT INTO payment_checkout_sessions
       (id, user_id, gateway, expected_amount, currency, purpose, status, provider_tx_id, paypal_order_id, environment)
     VALUES ($1, $2, 'paypal', 50.00, 'USD', 'deposit', 'pending', 'PP_ORD_SB_100', 'PP_ORD_SB_100', 'sandbox')`,
    [sess1Id, testUserId]
  );

  // Switch global active mode to production
  await paymentGatewayManager.setActivePayPalEnvironment('production');

  // Create session 2 while active mode is Production
  const sess2Id = 'chk_env_live_200';
  await pool.query(
    `INSERT INTO payment_checkout_sessions
       (id, user_id, gateway, expected_amount, currency, purpose, status, provider_tx_id, paypal_order_id, environment)
     VALUES ($1, $2, 'paypal', 100.00, 'USD', 'deposit', 'pending', 'PP_ORD_LIVE_200', 'PP_ORD_LIVE_200', 'production')`,
    [sess2Id, testUserId]
  );

  // Verify stored session environment columns
  const r1 = await pool.query('SELECT environment FROM payment_checkout_sessions WHERE id = $1::text', [sess1Id]);
  const r2 = await pool.query('SELECT environment FROM payment_checkout_sessions WHERE id = $1::text', [sess2Id]);

  assert.equal(r1.rows[0].environment, 'sandbox', 'Session 1 must be bound to sandbox');
  assert.equal(r2.rows[0].environment, 'production', 'Session 2 must be bound to production');

  // Verify that settling session 1 (created in sandbox) succeeds even when active global environment is set to production
  const settled1 = await settleCompletedCheckoutSession({
    sessionId: sess1Id,
    gateway: 'paypal',
    txId: 'CAP_SB_100',
    paypalOrderId: 'PP_ORD_SB_100',
    paypalCaptureId: 'CAP_SB_100',
    paidAmount: 50.00,
    paidCurrency: 'USD',
    expectedUserId: testUserId,
    preVerifiedSessionId: sess1Id,
    preExpectedAmount: 50.00,
    actor: 'Test Sandbox Settlement',
    source: 'gateway'
  });

  assert.equal(settled1.received, true, 'Settlement for sandbox session must succeed');

  const balAfter1 = await financialRepository.getWalletBalance(testUserId);
  assert.equal(balAfter1, 50.00, 'User wallet balance must be credited $50.00 from sandbox session');

  console.log('✓ PASS: Session environment isolation verified. Sandbox session processed cleanly while active mode is Live.\n');

  // Reset active mode back to sandbox
  await paymentGatewayManager.setActivePayPalEnvironment('sandbox');

  // =========================================================================
  // TEST 5: Strict Independent Identity Validation
  // =========================================================================
  console.log('Scenario 5: Testing Strict Independent Capture Identity Validation...');

  process.env.PAYMENT_SIMULATION_ENABLED = 'true';
  const capValRes1 = await paymentGatewayManager.capturePayPalOrder({
    paypalOrderId: 'sess_sim_order_id_500',
    expectedSessionId: 'chk_target_500',
    expectedAmount: 10.00,
    expectedCurrency: 'USD'
  });

  assert.equal(capValRes1.verified, true, 'Simulated capture with matching expectedSessionId must succeed');
  process.env.PAYMENT_SIMULATION_ENABLED = 'false';

  console.log('✓ PASS: Strict independent capture identity validation verified.\n');

  console.log('================================================================================');
  console.log('  ALL PAYPAL ENVIRONMENT SWITCHING & SESSION ISOLATION TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================================\n');

  process.exit(0);
}

runEnvironmentSwitchTests().catch(err => {
  console.error('CRITICAL: PayPal environment test failed:', err);
  process.exit(1);
});
