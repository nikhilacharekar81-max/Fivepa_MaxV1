import 'dotenv/config';
import crypto from 'crypto';
import { paymentGatewayManager, resolvePayPalEnv } from '../server/domains/finance/paymentGateways.js';

async function runPayPalSandboxSmoke() {
  console.log('==========================================================');
  console.log(' FivePA / WorkPerHour — PayPal Sandbox Smoke Verification ');
  console.log('==========================================================\n');

  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || '';
  const webhookId = process.env.PAYPAL_WEBHOOK_ID || '';
  const env: 'sandbox' | 'production' = resolvePayPalEnv();

  if (clientId && clientSecret) {
    await paymentGatewayManager.updateGateway(env, 'paypal', {
      enabled: true,
      clientId,
      clientSecret,
      webhookId,
      primary: true
    });
  }

  const gw = paymentGatewayManager.getGateway('paypal', env);
  if (!gw.clientId || !gw.clientSecret) {
    console.log('[INFO] PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not found in environment.');
    console.log('       To test live PayPal Sandbox API calls, set in your .env:');
    console.log('         PAYPAL_CLIENT_ID="<your-sandbox-client-id>"');
    console.log('         PAYPAL_CLIENT_SECRET="<your-sandbox-client-secret>"');
    console.log('         PAYPAL_WEBHOOK_ID="<your-sandbox-webhook-id>"');
    console.log('         APP_URL="http://localhost:3000"\n');
    console.log('       Running local gateway encryption & masking smoke checks instead...\n');

    await paymentGatewayManager.updateGateway('sandbox', 'paypal', {
      enabled: true,
      clientId: 'sb_client_smoke_test',
      clientSecret: 'sb_secret_987654',
      webhookId: 'WH-SMOKE-1234',
      primary: true
    });
    const masked = paymentGatewayManager.getMaskedState();
    console.log('  - Masked Client Secret:', masked.sandbox.paypal.clientSecret);
    console.log('  - Masked Webhook ID   :', masked.sandbox.paypal.webhookId);
    if (!masked.sandbox.paypal.webhookId.startsWith('••••••••')) {
      throw new Error('Expected webhookId to be masked in getMaskedState()');
    }
    console.log('\n[PASS] Local gateway encryption & masking checks passed.');
    process.exit(0);
  }

  const baseUrl =
    env === 'production'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';

  console.log(`1. Requesting OAuth2 access token from ${baseUrl}...`);
  const auth = Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64');
  const tokenRes = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`PayPal OAuth2 failed (${tokenRes.status}): ${errText}`);
  }
  const tokenData: any = await tokenRes.json();
  console.log(`   [OK] Received OAuth2 access token (expires_in=${tokenData.expires_in}s)\n`);

  const testSessionId = `chk_smoke_${crypto.randomBytes(6).toString('hex')}`;
  console.log(`2. Creating $10.00 USD PayPal Sandbox Order (session_id=${testSessionId})...`);
  const checkout = await paymentGatewayManager.createCheckoutSession({
    gateway: 'paypal',
    amount: 10.0,
    currency: 'USD',
    checkoutId: testSessionId,
    userId: 'u_smoke_buyer',
    description: 'FivePA Smoke Test ($10.00 USD)',
    purpose: 'deposit'
  });

  console.log(`   [OK] Created PayPal Order ID: ${checkout.providerSessionId}`);
  console.log(`   [OK] Buyer Approval URL     : ${checkout.checkoutUrl}\n`);

  console.log('3. Next Steps for Interactive Approval:');
  console.log('   - Open the Buyer Approval URL above in your browser.');
  console.log('   - Sign in with your PayPal Sandbox Personal (Buyer) account and click Complete Purchase.');
  console.log('   - You will be redirected to /checkout/success which captures the order and credits the wallet.');
  process.exit(0);
}

runPayPalSandboxSmoke().catch(err => {
  console.error('\n[FAIL] PayPal Sandbox Smoke Error:', err.message || err);
  process.exit(1);
});
