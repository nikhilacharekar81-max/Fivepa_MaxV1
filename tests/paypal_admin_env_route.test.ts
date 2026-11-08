import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import { apiRouter } from '../server/routes/index.js';
import { signToken } from '../server/middleware/auth.js';
import { postgresStore } from '../server/db/postgresStore.js';
import { siteSettings } from '../server/domains/admin/siteSettings.js';
import { store } from '../server/store.js';

describe('FIX 1: PayPal Admin Environment Route Mounting', () => {
  let app: express.Application;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    await postgresStore.runMigrations();
    await siteSettings.resetToDefaults();
    await store.saveUser({
      id: 'admin_1',
      name: 'Admin',
      email: 'admin@workperhour.com',
      role: 'super_admin',
      status: 'active'
    } as any);
    await store.saveUser({
      id: 'u1',
      name: 'Sarah J',
      email: 'sarah.j@example.com',
      role: 'freelancer',
      status: 'active'
    } as any);
  });

  // Setup Express app as per the test suite requirement
  const setup = () => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    adminToken = signToken({ id: 'admin_1', role: 'super_admin', email: 'admin@workperhour.com' });
    userToken = signToken({ id: 'u1', role: 'freelancer', email: 'sarah.j@example.com' });
  };
  setup();

  it('rejects unauthenticated request to /api/admin/payment-gateways/paypal/environment with 401', async () => {
    const res = await request(app)
      .post('/api/admin/payment-gateways/paypal/environment')
      .send({ environment: 'sandbox' });

    assert.strictEqual(res.status, 401);
  });

  it('rejects non-admin user request to /api/admin/payment-gateways/paypal/environment with 403', async () => {
    const res = await request(app)
      .post('/api/admin/payment-gateways/paypal/environment')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ environment: 'sandbox' });

    assert.strictEqual(res.status, 403);
  });

  it('successfully reaches /api/admin/payment-gateways/paypal/environment for authenticated admin', async () => {
    const res = await request(app)
      .post('/api/admin/payment-gateways/paypal/environment')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ environment: 'sandbox' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.activePayPalEnvironment, 'sandbox');
  });

  it('returns 404 for the old doubled route /api/api/admin/payment-gateways/paypal/environment', async () => {
    const res = await request(app)
      .post('/api/api/admin/payment-gateways/paypal/environment')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ environment: 'sandbox' });

    assert.strictEqual(res.status, 404);
  });
});
