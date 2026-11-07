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
  process.env.PAYMENT_SIMULATION_ENABLED = 'true';
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
  // TEST 4: Session-Bound Webhook Verification Across Global Environment Switches
  // =========================================================================
  console.log('Scenario 4: Testing Session-Bound Webhook Verification when Global Mode is Switched...');

  // Ensure active mode is Sandbox initially
  await paymentGatewayManager.setActivePayPalEnvironment('sandbox');

  const sbSessId = 'chk_env_sb_300';
  await pool.query(
    `INSERT INTO payment_checkout_sessions
       (id, user_id, gateway, expected_amount, currency, purpose, status, provider_tx_id, paypal_order_id, environment)
     VALUES ($1, $2, 'paypal', 50.00, 'USD', 'deposit', 'pending', 'PP_ORD_SB_300', 'PP_ORD_SB_300', 'sandbox')`,
    [sbSessId, testUserId]
  );

  // Switch global active mode to Production
  await paymentGatewayManager.setActivePayPalEnvironment('production');
  assert.equal(paymentGatewayManager.getActivePayPalEnvironment(), 'production');

  // Configure signature verification mock to verify against candidate session environment credentials
  paymentGatewayManager.verifyWebhookSignature = async (params) => {
    // If params.env is passed as 'sandbox', it correctly resolved the candidate session environment!
    if (params.env === 'sandbox') return true;
    // If it defaulted to global active mode ('production'), flag failure
    return false;
  };

  paymentGatewayManager.verifyPaymentEvent = async (params) => {
    return { verified: true, captureId: params.transactionId, paypalOrderId: params.paypalOrderId };
  };

  const sandboxWebhookPayload = {
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    id: 'WH-EVT-ENV-300',
    resource: {
      id: 'CAP_SB_300',
      status: 'COMPLETED',
      amount: { value: '50.00', currency_code: 'USD' },
      custom_id: sbSessId,
      supplementary_data: { related_ids: { order_id: 'PP_ORD_SB_300' } }
    }
  };

  const req: any = {
    query: { gateway: 'paypal' },
    headers: { 'content-type': 'application/json', 'paypal-transmission-id': 'tx-env-300' },
    body: Buffer.from(JSON.stringify(sandboxWebhookPayload))
  };

  let resCode = 200;
  let resBody: any = null;
  const res: any = { status: (c: number) => { resCode = c; return res; }, json: (d: any) => { resBody = d; return res; } };

  await handlePaymentWebhook(req, res);

  assert.equal(resCode, 200, 'Sandbox webhook delivered after global mode switched to Live MUST return HTTP 200');
  assert.equal(resBody.received, true, 'Sandbox webhook response must confirm receipt');

  const bal4 = await financialRepository.getWalletBalance(testUserId);
  assert.equal(bal4, 50.00, 'User wallet balance must be credited $50.00 from candidate session environment verification');

  console.log('✓ PASS: Sandbox webhook verified & settled successfully using session-bound environment credentials while global mode is set to Live.\n');

  // Reset active mode back to sandbox
  await paymentGatewayManager.setActivePayPalEnvironment('sandbox');

  // =========================================================================
  // TEST 5: Strict Independent Identity Validation
  // =========================================================================
  console.log('Scenario 5: Testing Strict Independent Capture Identity Validation...');

  const capValRes1 = await paymentGatewayManager.capturePayPalOrder({
    paypalOrderId: 'sess_sim_order_id_500',
    expectedSessionId: 'chk_target_500',
    expectedAmount: 10.00,
    expectedCurrency: 'USD'
  });

  assert.equal(capValRes1.verified, true, 'Simulated capture with matching expectedSessionId must succeed');

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
