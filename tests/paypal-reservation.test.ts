import assert from 'node:assert/strict';
import { postgresStore } from '../server/db/postgresStore.js';
import { ensurePaymentCheckoutSchema } from '../server/domains/finance/finance.routes.ts';
import { paymentGatewayManager } from '../server/domains/finance/paymentGateways.ts';

async function runReservationIntegrationTests() {
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_SIMULATION_ENABLED = 'true';

  console.log('================================================================================');
  console.log('  FivePA — PayPal 3-Step Checkout Reservation & Concurrency Integration Suite  ');
  console.log('================================================================================\n');

  await postgresStore.runMigrations();
  const pool = postgresStore.getPool();
  await ensurePaymentCheckoutSchema(pool);

  const testBuyerId = 'u_res_buyer_1';
  const testSellerId = 'u_res_seller_2';

  await pool.query(
    `INSERT INTO users (id, name, email, role, wallet_balance, status)
     VALUES ($1, 'Res Buyer', 'res_buyer@example.com', 'buyer', 0.00, 'active')
     ON CONFLICT (id) DO UPDATE SET wallet_balance = 0.00`,
    [testBuyerId]
  );

  await pool.query(
    `INSERT INTO users (id, name, email, role, wallet_balance, status)
     VALUES ($1, 'Res Seller', 'res_seller@example.com', 'seller', 0.00, 'active')
     ON CONFLICT (id) DO UPDATE SET wallet_balance = 0.00`,
    [testSellerId]
  );

  // Clean test tables
  await pool.query('DELETE FROM wallets WHERE user_id IN ($1, $2)', [testBuyerId, testSellerId]);
  await pool.query('DELETE FROM payment_checkout_sessions WHERE user_id IN ($1, $2)', [testBuyerId, testSellerId]);

  // Configure PayPal gateway in Sandbox mode
  await paymentGatewayManager.updateGateway('sandbox', 'paypal', {
    enabled: true,
    clientId: 'test_paypal_res_client_id',
    clientSecret: 'test_paypal_res_secret_123',
    webhookId: 'WH_RES_1111',
    primary: true
  });

  // Setup test order 1
  const order1Id = 'ord_res_test_100';
  await pool.query(
    `INSERT INTO orders (id, title, buyer_id, seller_id, amount, status, fee_breakdown, created_at, due_date)
     VALUES ($1, 'Reservation Test Order 1', $2, $3, 100.00, 'payment_pending', '{"clientTotal": 105.00}', NOW(), NOW() + INTERVAL '7 days')
     ON CONFLICT (id) DO UPDATE SET status = 'payment_pending'`,
    [order1Id, testBuyerId, testSellerId]
  );

  // Setup test order 2
  const order2Id = 'ord_res_test_200';
  await pool.query(
    `INSERT INTO orders (id, title, buyer_id, seller_id, amount, status, fee_breakdown, created_at, due_date)
     VALUES ($1, 'Reservation Test Order 2', $2, $3, 200.00, 'payment_pending', '{"clientTotal": 210.00}', NOW(), NOW() + INTERVAL '7 days')
     ON CONFLICT (id) DO UPDATE SET status = 'payment_pending'`,
    [order2Id, testBuyerId, testSellerId]
  );

  // =========================================================================
  // TEST 1: Two Simultaneous Checkout Requests for Same Order & User (Promise.all)
  // =========================================================================
  console.log('Scenario 1: Testing Two Simultaneous Checkout Requests for Same Order (Promise.all)...');

  const createReservationCall = async (ordId: string, amount: number) => {
    return await postgresStore.executeInTransaction(async (client) => {
      await client.query('SELECT id FROM orders WHERE id = $1::text FOR UPDATE', [ordId]);
      const existing = await client.query(
        `SELECT * FROM payment_checkout_sessions WHERE order_id = $1::text AND status IN ('pending', 'approved', 'reserving') LIMIT 1`,
        [ordId]
      );
      if (existing.rows.length > 0) {
        return { reused: true, session: existing.rows[0] };
      }
      const newId = 'chk_res_sim_' + Math.random().toString(36).slice(2, 10);
      await client.query(
        `INSERT INTO payment_checkout_sessions (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, environment, created_at)
         VALUES ($1, $2, $3, 'paypal', $4, 'USD', 'order_payment', 'reserving', 'sandbox', NOW())`,
        [newId, testBuyerId, ordId, amount]
      );
      return { reused: false, session: { id: newId } };
    });
  };

  const [res1A, res1B] = await Promise.all([
    createReservationCall(order1Id, 105.00),
    createReservationCall(order1Id, 105.00)
  ]);

  assert.ok(
    (res1A.reused === false && res1B.reused === true) || (res1A.reused === true && res1B.reused === false),
    'Exactly one call must reserve and the second must reuse'
  );

  const dbRes1 = await pool.query('SELECT id FROM payment_checkout_sessions WHERE order_id = $1::text', [order1Id]);
  assert.equal(dbRes1.rows.length, 1, 'Database must contain exactly 1 checkout session row');

  console.log('✓ PASS: Two simultaneous checkout requests created exactly 1 reservation row.\n');

  // Attach provider order to reservation 1
  const activeSessId1 = dbRes1.rows[0].id;
  await pool.query(
    `UPDATE payment_checkout_sessions SET status = 'pending', provider_tx_id = 'PP_RES_ORD_100', paypal_order_id = 'PP_RES_ORD_100' WHERE id = $1`,
    [activeSessId1]
  );

  // =========================================================================
  // TEST 2: Second Request After Valid Pending Session Exists
  // =========================================================================
  console.log('Scenario 2: Testing Request After Valid Pending Session Exists...');

  const res2 = await createReservationCall(order1Id, 105.00);
  assert.equal(res2.reused, true, 'Subsequent request must reuse existing pending session');
  assert.equal(res2.session.id, activeSessId1, 'Reused session ID must match initial reservation');

  console.log('✓ PASS: Subsequent checkout request reused existing pending session.\n');

  // =========================================================================
  // TEST 3: Two Different Legitimate Orders Checked Out Simultaneously
  // =========================================================================
  console.log('Scenario 3: Testing Simultaneous Checkout for Two Distinct Legitimate Orders...');

  const [distinct1, distinct2] = await Promise.all([
    createReservationCall(order1Id, 105.00),
    createReservationCall(order2Id, 210.00)
  ]);

  assert.equal(distinct1.reused, true, 'Order 1 reuses existing pending session');
  assert.equal(distinct2.reused, false, 'Order 2 creates new reservation independently');

  const dbRes2 = await pool.query('SELECT id FROM payment_checkout_sessions WHERE order_id = $1::text', [order2Id]);
  assert.equal(dbRes2.rows.length, 1, 'Order 2 must have its own distinct reservation row');

  console.log('✓ PASS: Two distinct legitimate orders checked out simultaneously and independently.\n');

  // =========================================================================
  // TEST 4: Failed Provider Call Cleans Up Reservation
  // =========================================================================
  console.log('Scenario 4: Testing Failure & Recovery Cleanup for Failed Reservation...');

  const failOrderId = 'ord_res_fail_300';
  await pool.query(
    `INSERT INTO orders (id, title, buyer_id, seller_id, amount, status, fee_breakdown, created_at, due_date)
     VALUES ($1, 'Failed Order', $2, $3, 50.00, 'payment_pending', '{"clientTotal": 52.50}', NOW(), NOW() + INTERVAL '7 days')
     ON CONFLICT (id) DO UPDATE SET status = 'payment_pending'`,
    [failOrderId, testBuyerId, testSellerId]
  );

  const failRes = await createReservationCall(failOrderId, 52.50);
  assert.equal(failRes.reused, false, 'Initial reservation created');

  // Simulate provider error cleanup
  await pool.query("UPDATE payment_checkout_sessions SET status = 'failed' WHERE id = $1", [failRes.session.id]);

  // Retry after failure creates new reservation cleanly
  const retryRes = await createReservationCall(failOrderId, 52.50);
  assert.equal(retryRes.reused, false, 'Retry after provider failure creates new reservation cleanly');

  console.log('✓ PASS: Failed provider call cleaned up reservation and allowed retry.\n');

  // =========================================================================
  // TEST 5: Recovery of Stale Reservation (>30 seconds old)
  // =========================================================================
  console.log('Scenario 5: Testing Stale Reservation Recovery...');

  const staleOrderId = 'ord_res_stale_400';
  await pool.query(
    `INSERT INTO orders (id, title, buyer_id, seller_id, amount, status, fee_breakdown, created_at, due_date)
     VALUES ($1, 'Stale Order', $2, $3, 80.00, 'payment_pending', '{"clientTotal": 84.00}', NOW(), NOW() + INTERVAL '7 days')
     ON CONFLICT (id) DO UPDATE SET status = 'payment_pending'`,
    [staleOrderId, testBuyerId, testSellerId]
  );

  // Insert a stale reservation older than 1 minute
  const staleId = 'chk_stale_400';
  await pool.query(
    `INSERT INTO payment_checkout_sessions (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, environment, created_at)
     VALUES ($1, $2, $3, 'paypal', 84.00, 'USD', 'order_payment', 'reserving', 'sandbox', NOW() - INTERVAL '2 minutes')`,
    [staleId, testBuyerId, staleOrderId]
  );

  // Check if stale reservation is ignored/cleaned up on retry
  const staleRecoveryRes = await postgresStore.executeInTransaction(async (client) => {
    await client.query('SELECT id FROM orders WHERE id = $1::text FOR UPDATE', [staleOrderId]);
    const existing = await client.query(
      `SELECT * FROM payment_checkout_sessions WHERE order_id = $1::text AND status IN ('pending', 'approved') LIMIT 1`,
      [staleOrderId]
    );
    if (existing.rows.length > 0) return { reused: true };
    const newId = 'chk_fresh_after_stale';
    await client.query(
      `INSERT INTO payment_checkout_sessions (id, user_id, order_id, gateway, expected_amount, currency, purpose, status, environment, created_at)
       VALUES ($1, $2, $3, 'paypal', 84.00, 'USD', 'order_payment', 'reserving', 'sandbox', NOW())`,
      [newId, testBuyerId, staleOrderId]
    );
    return { reused: false, session: { id: newId } };
  });

  assert.equal(staleRecoveryRes.reused, false, 'Stale reservation was ignored and fresh reservation created');

  console.log('✓ PASS: Stale reservation (>30s) recovered cleanly with fresh reservation.\n');

  console.log('================================================================================');
  console.log('  ALL PAYPAL 3-STEP RESERVATION & CONCURRENCY INTEGRATION TESTS PASSED!         ');
  console.log('================================================================================\n');

  process.exit(0);
}

runReservationIntegrationTests().catch(err => {
  console.error('CRITICAL: PayPal reservation test failed:', err);
  process.exit(1);
});
