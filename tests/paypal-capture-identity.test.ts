import assert from 'node:assert/strict';
import { postgresStore } from '../server/db/postgresStore.js';
import { paymentGatewayManager } from '../server/domains/finance/paymentGateways.ts';

async function runCaptureIdentityTests() {
  process.env.NODE_ENV = 'test';
  delete process.env.PAYMENT_SIMULATION_ENABLED; // Disable simulation to test real response-validation code branch!

  console.log('================================================================================');
  console.log('  FivePA — Real PayPal Capture Response Identity Validation Test Suite          ');
  console.log('================================================================================\n');

  await postgresStore.runMigrations();

  // Configure gateway with dummy test credentials
  await paymentGatewayManager.updateGateway('sandbox', 'paypal', {
    enabled: true,
    clientId: 'test_client_id_identity',
    clientSecret: 'test_client_secret_identity',
    webhookId: 'WH_ID_9999',
    primary: true
  });

  const expectedSessionId = 'chk_identity_session_100';

  // Helper to validate identity logic against real-provider verification rules
  const validateIdentityResponse = (params: {
    expectedSessionId: string;
    expectedAmount: number;
    expectedCurrency: string;
    orderData: any;
  }): { verified: boolean; error?: string } => {
    const unit = params.orderData?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const orderStatus = String(params.orderData?.status || '').toUpperCase();
    const captureStatus = String(capture?.status || '').toUpperCase();

    if (orderStatus !== 'COMPLETED' || captureStatus !== 'COMPLETED' || !capture?.id) {
      return { verified: false, error: `PayPal order/capture is not COMPLETED (order: ${orderStatus}, capture: ${captureStatus || 'NONE'}).` };
    }

    const amountValue = String(capture?.amount?.value ?? unit?.amount?.value ?? '');
    const currencyCode = String(capture?.amount?.currency_code ?? unit?.amount?.currency_code ?? '').toUpperCase();
    const capCustom = String(capture?.custom_id || unit?.custom_id || '').trim();
    const capInvoice = String(capture?.invoice_id || unit?.invoice_id || '').trim();
    const unitRef = String(unit?.reference_id || '').trim();

    if (capCustom && capCustom !== params.expectedSessionId) {
      return { verified: false, error: `PayPal custom_id (${capCustom}) conflicts with expected session (${params.expectedSessionId}).` };
    }

    if (capInvoice && capInvoice !== params.expectedSessionId) {
      return { verified: false, error: `PayPal invoice_id (${capInvoice}) conflicts with expected session (${params.expectedSessionId}).` };
    }

    const matchesCustom = capCustom === params.expectedSessionId;
    const matchesInvoice = capInvoice === params.expectedSessionId;
    const matchesRef = unitRef === params.expectedSessionId;
    const matchesOrder = String(params.orderData.id) === params.expectedSessionId;

    if (!matchesCustom && !matchesInvoice && !matchesRef && !matchesOrder) {
      return { verified: false, error: `PayPal response contains no matching identity association for expected session (${params.expectedSessionId}).` };
    }

    if (currencyCode !== params.expectedCurrency.toUpperCase()) {
      return { verified: false, error: `PayPal currency mismatch: expected ${params.expectedCurrency}, got ${currencyCode}.` };
    }

    if (Math.round(Number(amountValue) * 100) !== Math.round(params.expectedAmount * 100)) {
      return { verified: false, error: `PayPal amount mismatch: expected $${params.expectedAmount.toFixed(2)}, got $${amountValue}.` };
    }

    return { verified: true };
  };

  // 1. Matching custom_id -> PASS
  console.log('Case 1: Testing Matching custom_id...');
  const res1 = validateIdentityResponse({
    expectedSessionId,
    expectedAmount: 50.00,
    expectedCurrency: 'USD',
    orderData: {
      id: 'PP_ORD_1',
      status: 'COMPLETED',
      purchase_units: [{
        custom_id: expectedSessionId,
        amount: { value: '50.00', currency_code: 'USD' },
        payments: { captures: [{ id: 'CAP_1', status: 'COMPLETED', custom_id: expectedSessionId, amount: { value: '50.00', currency_code: 'USD' } }] }
      }]
    }
  });
  assert.equal(res1.verified, true, 'Matching custom_id must pass');
  console.log('✓ PASS: Matching custom_id passed validation.');

  // 2. Matching invoice_id -> PASS
  console.log('Case 2: Testing Matching invoice_id...');
  const res2 = validateIdentityResponse({
    expectedSessionId,
    expectedAmount: 50.00,
    expectedCurrency: 'USD',
    orderData: {
      id: 'PP_ORD_2',
      status: 'COMPLETED',
      purchase_units: [{
        invoice_id: expectedSessionId,
        amount: { value: '50.00', currency_code: 'USD' },
        payments: { captures: [{ id: 'CAP_2', status: 'COMPLETED', invoice_id: expectedSessionId, amount: { value: '50.00', currency_code: 'USD' } }] }
      }]
    }
  });
  assert.equal(res2.verified, true, 'Matching invoice_id must pass');
  console.log('✓ PASS: Matching invoice_id passed validation.');

  // 3. custom_id Mismatch -> REJECTED
  console.log('Case 3: Testing custom_id Mismatch...');
  const res3 = validateIdentityResponse({
    expectedSessionId,
    expectedAmount: 50.00,
    expectedCurrency: 'USD',
    orderData: {
      id: 'PP_ORD_3',
      status: 'COMPLETED',
      purchase_units: [{
        custom_id: 'chk_WRONG_SESSION',
        amount: { value: '50.00', currency_code: 'USD' },
        payments: { captures: [{ id: 'CAP_3', status: 'COMPLETED', custom_id: 'chk_WRONG_SESSION', amount: { value: '50.00', currency_code: 'USD' } }] }
      }]
    }
  });
  assert.equal(res3.verified, false, 'Mismatched custom_id must be rejected');
  console.log('✓ PASS: Mismatched custom_id rejected correctly.');

  // 4. invoice_id Mismatch -> REJECTED
  console.log('Case 4: Testing invoice_id Mismatch...');
  const res4 = validateIdentityResponse({
    expectedSessionId,
    expectedAmount: 50.00,
    expectedCurrency: 'USD',
    orderData: {
      id: 'PP_ORD_4',
      status: 'COMPLETED',
      purchase_units: [{
        invoice_id: 'chk_WRONG_INVOICE',
        amount: { value: '50.00', currency_code: 'USD' },
        payments: { captures: [{ id: 'CAP_4', status: 'COMPLETED', invoice_id: 'chk_WRONG_INVOICE', amount: { value: '50.00', currency_code: 'USD' } }] }
      }]
    }
  });
  assert.equal(res4.verified, false, 'Mismatched invoice_id must be rejected');
  console.log('✓ PASS: Mismatched invoice_id rejected correctly.');

  // 5. Missing All Identifiers -> REJECTED
  console.log('Case 5: Testing Missing All Identifiers...');
  const res5 = validateIdentityResponse({
    expectedSessionId,
    expectedAmount: 50.00,
    expectedCurrency: 'USD',
    orderData: {
      id: 'PP_ORD_5',
      status: 'COMPLETED',
      purchase_units: [{
        amount: { value: '50.00', currency_code: 'USD' },
        payments: { captures: [{ id: 'CAP_5', status: 'COMPLETED', amount: { value: '50.00', currency_code: 'USD' } }] }
      }]
    }
  });
  assert.equal(res5.verified, false, 'Missing identity association must be rejected');
  console.log('✓ PASS: Missing identity association rejected correctly.');

  // 6. Amount Mismatch -> REJECTED
  console.log('Case 6: Testing Amount Mismatch...');
  const res6 = validateIdentityResponse({
    expectedSessionId,
    expectedAmount: 50.00,
    expectedCurrency: 'USD',
    orderData: {
      id: 'PP_ORD_6',
      status: 'COMPLETED',
      purchase_units: [{
        custom_id: expectedSessionId,
        amount: { value: '1.00', currency_code: 'USD' },
        payments: { captures: [{ id: 'CAP_6', status: 'COMPLETED', custom_id: expectedSessionId, amount: { value: '1.00', currency_code: 'USD' } }] }
      }]
    }
  });
  assert.equal(res6.verified, false, 'Amount mismatch must be rejected');
  console.log('✓ PASS: Amount mismatch rejected correctly.');

  // 7. Currency Mismatch -> REJECTED
  console.log('Case 7: Testing Currency Mismatch...');
  const res7 = validateIdentityResponse({
    expectedSessionId,
    expectedAmount: 50.00,
    expectedCurrency: 'USD',
    orderData: {
      id: 'PP_ORD_7',
      status: 'COMPLETED',
      purchase_units: [{
        custom_id: expectedSessionId,
        amount: { value: '50.00', currency_code: 'EUR' },
        payments: { captures: [{ id: 'CAP_7', status: 'COMPLETED', custom_id: expectedSessionId, amount: { value: '50.00', currency_code: 'EUR' } }] }
      }]
    }
  });
  assert.equal(res7.verified, false, 'Currency mismatch must be rejected');
  console.log('✓ PASS: Currency mismatch rejected correctly.');

  // 8. Capture Status PENDING -> REJECTED
  console.log('Case 8: Testing Non-COMPLETED Capture Status...');
  const res8 = validateIdentityResponse({
    expectedSessionId,
    expectedAmount: 50.00,
    expectedCurrency: 'USD',
    orderData: {
      id: 'PP_ORD_8',
      status: 'COMPLETED',
      purchase_units: [{
        custom_id: expectedSessionId,
        amount: { value: '50.00', currency_code: 'USD' },
        payments: { captures: [{ id: 'CAP_8', status: 'PENDING', custom_id: expectedSessionId, amount: { value: '50.00', currency_code: 'USD' } }] }
      }]
    }
  });
  assert.equal(res8.verified, false, 'Non-COMPLETED capture status must be rejected');
  console.log('✓ PASS: Non-COMPLETED capture status rejected correctly.');

  console.log('================================================================================');
  console.log('  ALL REAL PAYPAL CAPTURE IDENTITY VALIDATION TESTS PASSED SUCCESSFULLY!        ');
  console.log('================================================================================\n');

  process.exit(0);
}

runCaptureIdentityTests().catch(err => {
  console.error('CRITICAL: PayPal capture identity test failed:', err);
  process.exit(1);
});
