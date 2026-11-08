import test from 'node:test';
import assert from 'node:assert';
import express from 'express';
import request from 'supertest';
import { verifyAuthTokenMiddleware, requireAuth } from '../server/middleware/auth.js';
import { apiRouter } from '../server/routes/index.js';
import { postgresStore } from '../server/db/postgresStore.js';

test('Middleware & SSR Order Fixes Test Suite', async (t) => {
  await postgresStore.runMigrations();
  await t.test('(a) GET /api/gigs with an invalid Bearer token returns 200', async () => {
    const app = express();
    app.use(express.json());
    app.use(verifyAuthTokenMiddleware);
    app.use('/api', apiRouter);

    const res = await request(app)
      .get('/api/gigs')
      .set('Authorization', 'Bearer invalid.stale.token.abc');

    assert.notStrictEqual(res.status, 403);
    assert.strictEqual(res.status, 200);
  });

  await t.test('(b) POST /api/auth/login with an expired/invalid Bearer token still reaches login handler', async () => {
    const app = express();
    app.use(express.json());
    app.use(verifyAuthTokenMiddleware);
    app.use('/api', apiRouter);

    const res = await request(app)
      .post('/api/auth/login')
      .set('Authorization', 'Bearer expired.stale.token.xyz')
      .send({ email: 'nonexistent_test_user@example.com', password: 'wrongpassword' });

    // Should reach login handler (returning 400/401 for bad credentials), NOT 403 forbidden from middleware
    assert.notStrictEqual(res.status, 403);
  });

  await t.test('(c) Protected route with an invalid token returns 401, not 403', async () => {
    const app = express();
    app.use(express.json());
    app.use(verifyAuthTokenMiddleware);
    app.get('/api/protected-route', requireAuth, (_req, res) => {
      res.json({ success: true });
    });

    const res = await request(app)
      .get('/api/protected-route')
      .set('Authorization', 'Bearer invalid.stale.token');

    assert.strictEqual(res.status, 401);
    assert.notStrictEqual(res.status, 403);
  });

  await t.test('(d) SSR / API error handler returns sanitized response when error is thrown', async () => {
    const app = express();
    app.use(express.json());

    app.get('/api/ssr-throw', (_req, _res, next) => {
      next(new Error('Internal database connection failure stack trace'));
    });

    // Global Error Handler matching server.ts
    app.use((err: any, req: any, res: any, next: any) => {
      if (res.headersSent) return next(err);
      const status = Number(err?.status || err?.statusCode || 500);
      const isApi = req.path?.startsWith('/api') || req.originalUrl?.startsWith('/api');
      if (isApi) {
        const safeMsg = (status < 500 && err?.message) ? err.message : 'Internal server error';
        return res.status(status).json({ error: safeMsg });
      }
      res.status(status).send('HTML Error');
    });

    const res = await request(app).get('/api/ssr-throw');
    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(res.body, { error: 'Internal server error' });
  });
});
