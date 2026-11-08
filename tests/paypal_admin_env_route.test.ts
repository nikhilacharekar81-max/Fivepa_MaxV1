import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiRouter } from '../server/routes/index.js';
import { signToken } from '../server/middleware/auth.js';

describe('FIX 1: PayPal Admin Environment Route Mounting', () => {
  let app: express.Application;
  let adminToken: string;
  let userToken: string;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    adminToken = signToken({ id: 'admin_1', role: 'super_admin', email: 'admin@workperhour.com' });
    userToken = signToken({ id: 'u1', role: 'freelancer', email: 'sarah.j@example.com' });
  });

  it('rejects unauthenticated request to /api/admin/payment-gateways/paypal/environment with 401', async () => {
    const res = await request(app)
      .post('/api/admin/payment-gateways/paypal/environment')
      .send({ environment: 'sandbox' });

    expect(res.status).toBe(401);
  });

  it('rejects non-admin user request to /api/admin/payment-gateways/paypal/environment with 403', async () => {
    const res = await request(app)
      .post('/api/admin/payment-gateways/paypal/environment')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ environment: 'sandbox' });

    expect(res.status).toBe(403);
  });

  it('successfully reaches /api/admin/payment-gateways/paypal/environment for authenticated admin', async () => {
    const res = await request(app)
      .post('/api/admin/payment-gateways/paypal/environment')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ environment: 'sandbox' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('activePayPalEnvironment', 'sandbox');
  });

  it('returns 404 for the old doubled route /api/api/admin/payment-gateways/paypal/environment', async () => {
    const res = await request(app)
      .post('/api/api/admin/payment-gateways/paypal/environment')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ environment: 'sandbox' });

    expect(res.status).toBe(404);
  });
});
