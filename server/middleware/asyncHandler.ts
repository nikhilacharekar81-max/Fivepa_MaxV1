import type { Request, Response, NextFunction, Router } from 'express';

const wrappedFunctions = new WeakSet<Function>();
const wrapperCache = new WeakMap<Function, Function>();

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => any) {
  if (typeof fn !== 'function') return fn;
  if (wrappedFunctions.has(fn)) return fn;
  if (wrapperCache.has(fn)) return wrapperCache.get(fn)!;

  const wrapped = function (req: Request, res: Response, next: NextFunction) {
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.then === 'function') {
        return ret.catch(next);
      }
      return ret;
    } catch (err) {
      next(err);
    }
  };

  wrappedFunctions.add(wrapped);
  wrapperCache.set(fn, wrapped);
  return wrapped;
}

export function wrapRouter<T extends Router>(router: T): T {
  if (!router) return router;

  // Wrap existing routes
  if ((router as any).stack) {
    (router as any).stack.forEach((layer: any) => {
      if (layer.route) {
        layer.route.stack.forEach((routeLayer: any) => {
          if (typeof routeLayer.handle === 'function' && routeLayer.handle.length !== 4 && !(routeLayer.handle as any).stack && !wrappedFunctions.has(routeLayer.handle)) {
            routeLayer.handle = asyncHandler(routeLayer.handle);
          }
        });
      } else if (layer.handle && (layer.handle as any).stack) {
        // Recursively wrap nested routers
        wrapRouter(layer.handle);
      }
    });
  }

  // Patch method functions for future route additions
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
  for (const method of methods) {
    const originalMethod = (router as any)[method];
    if (typeof originalMethod !== 'function' || (originalMethod as any).__wrapped) continue;

    const patchedMethod = function (this: any, path: any, ...handlers: any[]) {
      const wrappedHandlers = handlers.map(handler => {
        if (typeof handler === 'function' && handler.length !== 4 && !(handler as any).stack && !wrappedFunctions.has(handler)) {
          return asyncHandler(handler);
        }
        return handler;
      });
      return originalMethod.call(this, path, ...wrappedHandlers);
    };

    (patchedMethod as any).__wrapped = true;
    (router as any)[method] = patchedMethod;
  }
  return router;
}
