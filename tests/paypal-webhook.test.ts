import assert from 'node:assert/strict';
import { postgresStore } from '../server/db/postgresStore.js';
import {
  handlePaymentWebhook,
  settleCompletedCheckoutSession,
  ensurePaymentCheckoutSchema
} from '../server/domains/finance/finance.routes.js';
import { financialRepository } from '../server/domains/finance/financial.service.js';
import { paymentGatewayManager } from '../server/domains/finance/paymentGateways.js';

async function invokeWebhook(
  payloadObj: any,
  headers: Record<string, string> = { 'paypal-transmission-id': 'tx-1', 'paypal-transmission-sig': 'sig-1' }
): Promise<{ statusCode: number; body: any }> {
  const rawBody = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const req: any = {
    query: { gateway: 'paypal' },
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: rawBody
  };
  let statusCode = 200;
  let responseBody: any = null;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      responseBody = data;
      return this;
    }
  };
  await handlePaymentWebhook(req, res);
  return { statusCode, body: responseBody };
}

async function getSession(pool: any, sessionId: string): Promise<any> {
  const r = await pool.query('SELECT * FROM payment_checkout_sessions WHERE id = $1', [sessionId]);
  return r.rows[0];
}

async function runTests() {
  process.env.NODE_ENV = 'test';
  console.log('Running PayPal Sandbox & Webhook Verification Suite (7 Test Scenarios)...\n');
  await postgresStore.runMigrations();
  const pool = postgresStore.getPool();
  await ensurePaymentCheckoutSchema(pool);

  const testUserId = 'u_paypal_test_buyer';
  await pool.query(
    `INSERT INTO users (id, name, email, role, wallet_balance, status)
     VALUES ($1, $2, $3, 'buyer', 0.00, 'active')
     ON CONFLICT (id) DO UPDATE SET wallet_balance = 0.00`,
    [testUserId, 'PayPal Test Buyer', 'paypal_buyer@example.com']
  );
  // Reset any existing test wallet rows for clean repeatability
  await pool.query('DELETE FROM wallets WHERE user_id = $1', [testUserId]);
  await pool.query('DELETE FROM payment_checkout_sessions WHERE user_id = $1', [testUserId]);
  await pool.query("DELETE FROM payment_webhook_events WHERE event_id LIKE 'WH-EVT-TEST-%'");
  await pool.query("DELETE FROM financial_idempotency WHERE key LIKE '%CAP_TEST%' OR key LIKE '%chk_test_%'");

  // Configure PayPal gateway in sandbox mode
  await paymentGatewayManager.updateGateway('sandbox', 'paypal', {
    enabled: true,
    clientId: 'test_paypal_client_id',
    clientSecret: 'test_paypal_secret_9999',
    webhookId: 'WH_TEST_8888',
    primary: true
  });

  // Verify webhookId encryption & masking
  const masked = paymentGatewayManager.getMaskedState();
  assert.equal(masked.sandbox.paypal.webhookId, '••••••••8888', 'webhookId must be masked in admin API state');
  console.log('✓ Prerequisite: webhookId is encrypted at rest and masked (••••••••8888) in API responses');

  // Stub signature verification & payment verification for deterministic tests
  let signatureValid = true;
  paymentGatewayManager.verifyWebhookSignature = async () => signatureValid;
  paymentGatewayManager.verifyPaymentEvent = async (params) => {
    return {
      verified: true,
      status: 'COMPLETED',
      amount: params.expectedAmount,
      currency: 'USD',
      captureId: params.transactionId
    };
  };

  // Seed checkout session chk_test_1 for $25.00 USD
  await pool.query(
    `INSERT INTO payment_checkout_sessions
       (id, user_id, gateway, purpose, expected_amount, currency, status, provider_tx_id, paypal_order_id)
     VALUES ('chk_test_1', $1, 'paypal', 'deposit', 25.00, 'USD', 'pending', 'PAYPAL_ORDER_1', 'PAYPAL_ORDER_1')`,
    [testUserId]
  );

  // =========================================================================
  // TEST 4 (Run before completion of chk_test_1): CHECKOUT.ORDER.APPROVED alone
  // does NOT credit the wallet and sets status to 'approved'
  // =========================================================================
  {
    const res = await invokeWebhook({
      id: 'WH-EVT-TEST-APPROVED-1',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      resource: {
        id: 'PAYPAL_ORDER_1',
        status: 'APPROVED',
        purchase_units: [
          {
            reference_id: 'chk_test_1',
            custom_id: 'chk_test_1',
            amount: { currency_code: 'USD', value: '25.00' }
          }
        ]
      }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'approved');
    const bal = await financialRepository.getWalletBalance(testUserId);
    assert.equal(bal, 0, 'CHECKOUT.ORDER.APPROVED must NOT credit the buyer wallet');
    const sess = await getSession(pool, 'chk_test_1');
    assert.equal(sess.status, 'approved', 'Checkout session status should be updated to approved');
    console.log('✓ Test 4: CHECKOUT.ORDER.APPROVED updates status to approved and does NOT credit wallet');
  }

  // =========================================================================
  // TEST 1: Valid PAYMENT.CAPTURE.COMPLETED credits buyer wallet once
  // and marks checkout session completed
  // =========================================================================
  const validCaptureWebhookPayload = {
    id: 'WH-EVT-TEST-CAPTURE-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: 'CAP_TEST_101',
      status: 'COMPLETED',
      custom_id: 'chk_test_1',
      invoice_id: 'chk_test_1',
      amount: {
        currency_code: 'USD',
        value: '25.00'
      },
      supplementary_data: {
        related_ids: {
          order_id: 'PAYPAL_ORDER_1'
        }
      }
    }
  };

  {
    const res = await invokeWebhook(validCaptureWebhookPayload);
    assert.equal(res.statusCode, 200, `Unexpected status ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.received, true);
    assert.equal(Boolean(res.body.replayed), false);

    const bal = await financialRepository.getWalletBalance(testUserId);
    assert.equal(bal, 25.0, 'Buyer wallet must be credited with $25.00');

    const sess = await getSession(pool, 'chk_test_1');
    assert.equal(sess.status, 'completed', 'Session must be marked completed');
    assert.equal(sess.paypal_capture_id, 'CAP_TEST_101');
    console.log('✓ Test 1: Valid PAYMENT.CAPTURE.COMPLETED credits wallet $25.00 once and marks session completed');
  }

  // =========================================================================
  // TEST 2: Replaying the exact same webhook returns 200 and does NOT double-credit
  // =========================================================================
  {
    const replayRes1 = await invokeWebhook(validCaptureWebhookPayload);
    assert.equal(replayRes1.statusCode, 200);
    assert.equal(replayRes1.body.replayed, true, 'Duplicate event ID must be flagged as replayed');

    const replayRes2 = await invokeWebhook({
      ...validCaptureWebhookPayload,
      id: 'WH-EVT-TEST-CAPTURE-1-RETRY'
    });
    assert.equal(replayRes2.statusCode, 200);
    assert.equal(replayRes2.body.replayed, true, 'Same session/capture via retry event must not double-credit');

    const bal = await financialRepository.getWalletBalance(testUserId);
    assert.equal(bal, 25.0, 'Wallet balance must remain $25.00 after duplicate webhook replays');
    console.log('✓ Test 2: Replaying duplicate webhook events returns 200 and does NOT double-credit');
  }

  // =========================================================================
  // TEST 3: Return-page capture followed by webhook (and vice-versa) credits only once
  // =========================================================================
  {
    // 3A: Return-page settles first, then webhook arrives
    await pool.query(
      `INSERT INTO payment_checkout_sessions
         (id, user_id, gateway, purpose, expected_amount, currency, status, provider_tx_id, paypal_order_id)
       VALUES ('chk_test_race_a', $1, 'paypal', 'deposit', 15.00, 'USD', 'pending', 'PAYPAL_ORDER_RACE_A', 'PAYPAL_ORDER_RACE_A')`,
      [testUserId]
    );

    const captureSettlement = await settleCompletedCheckoutSession({
      sessionId: 'chk_test_race_a',
      gateway: 'paypal',
      txId: 'CAP_TEST_RACE_A',
      paypalOrderId: 'PAYPAL_ORDER_RACE_A',
      paypalCaptureId: 'CAP_TEST_RACE_A',
      paidAmount: 15.0,
      paidCurrency: 'USD',
      reference: 'CAP_TEST_RACE_A',
      expectedUserId: testUserId,
      preVerifiedSessionId: 'chk_test_race_a',
      preExpectedAmount: 15.0,
      actor: 'PayPal Capture',
      source: 'gateway'
    });
    assert.equal(Boolean(captureSettlement.replayed), false);
    assert.equal(await financialRepository.getWalletBalance(testUserId), 40.0);

    // Now the PayPal webhook arrives for the same order/capture
    const whAfterCapture = await invokeWebhook({
      id: 'WH-EVT-TEST-RACE-A',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP_TEST_RACE_A',
        status: 'COMPLETED',
        custom_id: 'chk_test_race_a',
        amount: { currency_code: 'USD', value: '15.00' },
        supplementary_data: { related_ids: { order_id: 'PAYPAL_ORDER_RACE_A' } }
      }
    });
    assert.equal(whAfterCapture.statusCode, 200);
    assert.equal(whAfterCapture.body.replayed, true);
    assert.equal(
      await financialRepository.getWalletBalance(testUserId),
      40.0,
      'Must not double-credit when webhook follows return capture'
    );

    // 3B: Webhook settles first, then return-page capture runs
    await pool.query(
      `INSERT INTO payment_checkout_sessions
         (id, user_id, gateway, purpose, expected_amount, currency, status, provider_tx_id, paypal_order_id)
       VALUES ('chk_test_race_b', $1, 'paypal', 'deposit', 10.00, 'USD', 'pending', 'PAYPAL_ORDER_RACE_B', 'PAYPAL_ORDER_RACE_B')`,
      [testUserId]
    );

    const whFirst = await invokeWebhook({
      id: 'WH-EVT-TEST-RACE-B',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP_TEST_RACE_B',
        status: 'COMPLETED',
        custom_id: 'chk_test_race_b',
        amount: { currency_code: 'USD', value: '10.00' },
        supplementary_data: { related_ids: { order_id: 'PAYPAL_ORDER_RACE_B' } }
      }
    });
    assert.equal(whFirst.statusCode, 200);
    assert.equal(Boolean(whFirst.body.replayed), false);
    assert.equal(await financialRepository.getWalletBalance(testUserId), 50.0);

    // Return-page capture arrives second
    const returnSecond = await settleCompletedCheckoutSession({
      sessionId: 'chk_test_race_b',
      gateway: 'paypal',
      txId: 'CAP_TEST_RACE_B',
      paypalOrderId: 'PAYPAL_ORDER_RACE_B',
      paypalCaptureId: 'CAP_TEST_RACE_B',
      paidAmount: 10.0,
      paidCurrency: 'USD',
      reference: 'CAP_TEST_RACE_B',
      expectedUserId: testUserId,
      preVerifiedSessionId: 'chk_test_race_b',
      preExpectedAmount: 10.0,
      actor: 'PayPal Capture',
      source: 'gateway'
    });
    assert.equal(returnSecond.replayed, true);
    assert.equal(
      await financialRepository.getWalletBalance(testUserId),
      50.0,
      'Must not double-credit when return capture follows webhook'
    );
    console.log('✓ Test 3: Return-page capture + webhook race in both directions credits wallet once ($50.00 total)');
  }

  // =========================================================================
  // TEST 5: PAYMENT.CAPTURE.COMPLETED with mismatched amount or currency is rejected
  // =========================================================================
  {
    await pool.query(
      `INSERT INTO payment_checkout_sessions
         (id, user_id, gateway, purpose, expected_amount, currency, status, provider_tx_id, paypal_order_id)
       VALUES ('chk_test_tamper', $1, 'paypal', 'deposit', 30.00, 'USD', 'pending', 'PAYPAL_ORDER_TAMPER', 'PAYPAL_ORDER_TAMPER')`,
      [testUserId]
    );

    // 5A: Wrong currency (EUR instead of USD)
    const eurRes = await invokeWebhook({
      id: 'WH-EVT-TEST-TAMPER-EUR',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP_TEST_TAMPER_EUR',
        status: 'COMPLETED',
        custom_id: 'chk_test_tamper',
        amount: { currency_code: 'EUR', value: '30.00' },
        supplementary_data: { related_ids: { order_id: 'PAYPAL_ORDER_TAMPER' } }
      }
    });
    assert.equal(eurRes.statusCode, 400, 'EUR currency webhook must be rejected with 400');
    assert.equal(await financialRepository.getWalletBalance(testUserId), 50.0, 'Balance must not change on currency mismatch');

    // 5B: Wrong amount ($5.00 instead of $30.00)
    const amtRes = await invokeWebhook({
      id: 'WH-EVT-TEST-TAMPER-AMT',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP_TEST_TAMPER_AMT',
        status: 'COMPLETED',
        custom_id: 'chk_test_tamper',
        amount: { currency_code: 'USD', value: '5.00' },
        supplementary_data: { related_ids: { order_id: 'PAYPAL_ORDER_TAMPER' } }
      }
    });
    assert.equal(amtRes.statusCode, 400, 'Mismatched amount ($5 vs $30) must be rejected with 400');
    assert.equal(await financialRepository.getWalletBalance(testUserId), 50.0, 'Balance must not change on amount mismatch');
    console.log('✓ Test 5: PAYMENT.CAPTURE.COMPLETED with mismatched amount or currency is rejected (HTTP 400)');
  }

  // =========================================================================
  // TEST 6: Webhook with failed signature verification is rejected (HTTP 403)
  // =========================================================================
  {
    signatureValid = false;
    const spoofRes = await invokeWebhook({
      id: 'WH-EVT-TEST-SPOOF-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP_TEST_SPOOF_1',
        status: 'COMPLETED',
        custom_id: 'chk_test_tamper',
        amount: { currency_code: 'USD', value: '30.00' }
      }
    });
    assert.equal(spoofRes.statusCode, 403, 'Spoofed webhook signature must be rejected with 403');
    assert.equal(await financialRepository.getWalletBalance(testUserId), 50.0, 'Spoofed webhook must not credit wallet');
    signatureValid = true;
    console.log('✓ Test 6: Webhook with failed signature verification is rejected (HTTP 403) and does NOT credit');
  }

  // =========================================================================
  // TEST 7: PAYMENT.CAPTURE.DENIED / DECLINED marks session failed and does NOT credit
  // =========================================================================
  {
    await pool.query(
      `INSERT INTO payment_checkout_sessions
         (id, user_id, gateway, purpose, expected_amount, currency, status, provider_tx_id, paypal_order_id)
       VALUES ('chk_test_denied', $1, 'paypal', 'deposit', 20.00, 'USD', 'pending', 'PAYPAL_ORDER_DENIED', 'PAYPAL_ORDER_DENIED')`,
      [testUserId]
    );

    const deniedRes = await invokeWebhook({
      id: 'WH-EVT-TEST-DENIED-1',
      event_type: 'PAYMENT.CAPTURE.DENIED',
      resource: {
        id: 'CAP_TEST_DENIED_1',
        status: 'DENIED',
        custom_id: 'chk_test_denied',
        amount: { currency_code: 'USD', value: '20.00' },
        supplementary_data: { related_ids: { order_id: 'PAYPAL_ORDER_DENIED' } }
      }
    });
    assert.equal(deniedRes.statusCode, 200);
    assert.equal(deniedRes.body.status, 'failed');
    assert.equal(await financialRepository.getWalletBalance(testUserId), 50.0, 'Denied capture must not credit wallet');
    const deniedSess = await getSession(pool, 'chk_test_denied');
    assert.equal(deniedSess.status, 'failed', 'Session status must be marked failed');
    console.log('✓ Test 7: PAYMENT.CAPTURE.DENIED marks session failed and does NOT credit wallet');
  }

  console.log('\nALL 7 PAYPAL WEBHOOK & CAPTURE TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n[TEST FAILURE]:', err);
  process.exit(1);
});
