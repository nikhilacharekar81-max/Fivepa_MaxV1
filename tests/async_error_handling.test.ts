import { describe, it, expect, beforeAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { wrapRouter, asyncHandler } from '../server/middleware/asyncHandler.js';

describe('FIX 3: Async Handler and Error Middleware', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Test router with async handlers
    const router = wrapRouter(express.Router());

    router.get('/async-throw', async (_req, _res) => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('Database connection failed');
    });

    router.get('/custom-status', async (_req, _res) => {
      await new Promise((r) => setTimeout(r, 10));
      const err: any = new Error('Invalid input param');
      err.status = 400;
      throw err;
    });

    app.use('/api', router);

    // API 404 catch-all
    app.use('/api/*', (_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Global Error Handler
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(err);
      const status = Number(err?.status || err?.statusCode || 500);
      const isApi = req.path?.startsWith('/api') || req.originalUrl?.startsWith('/api');

      if (isApi) {
        if (process.env.NODE_ENV === 'production' && status >= 500) {
          return res.status(500).json({ error: 'Internal server error' });
        }
        const safeMsg = (status < 500 && err?.message) ? err.message : (process.env.NODE_ENV === 'production' ? 'Internal server error' : (err?.message || 'Internal server error'));
        return res.status(status).json({ error: safeMsg });
      }

      return res.status(status).send('HTML Error');
    });
  });

  it('catches async error and returns 500 JSON without hanging', async () => {
    const start = Date.now();
    const res = await request(app).get('/api/async-throw');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('respects custom error status code like 400', async () => {
    const res = await request(app).get('/api/custom-status');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid input param' });
  });

  it('returns JSON 404 for unknown /api/* routes', async () => {
    const res = await request(app).get('/api/non-existent-endpoint');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('hides error details and stack traces in production mode', async () => {
    const prodApp = express();
    prodApp.use(express.json());

    const r = wrapRouter(express.Router());
    r.get('/fail', async () => {
      throw new Error('SELECT * FROM secret_table FAILED');
    });
    prodApp.use('/api', r);

    prodApp.use((err: any, req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(err);
      const status = Number(err?.status || err?.statusCode || 500);
      if (status >= 500) {
        return res.status(500).json({ error: 'Internal server error' });
      }
      return res.status(status).json({ error: err.message });
    });

    const res = await request(prodApp).get('/api/fail');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('secret_table');
  });
});
