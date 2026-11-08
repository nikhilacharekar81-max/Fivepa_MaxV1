import type { Request, Response, NextFunction, Router } from 'express';

const wrappedFunctions = new WeakSet<Function>();

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => any) {
  if (typeof fn !== 'function') return fn;
  if (wrappedFunctions.has(fn)) return fn;

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

  wrappedFunctions.add(fn);
  wrappedFunctions.add(wrapped);
  return wrapped;
}

export function wrapRouter<T extends Router>(router: T): T {
  if (!router) return router;

  // Patch existing stack if routes were already added
  if (Array.isArray((router as any).stack)) {
    for (const layer of (router as any).stack) {
      if (layer?.route?.stack && Array.isArray(layer.route.stack)) {
        for (const routeLayer of layer.route.stack) {
          if (typeof routeLayer.handle === 'function' && routeLayer.handle.length !== 4 && !wrappedFunctions.has(routeLayer.handle)) {
            routeLayer.handle = asyncHandler(routeLayer.handle);
          }
        }
      } else if (typeof layer?.handle === 'function' && layer.handle.length !== 4 && !(layer.handle as any).stack && !wrappedFunctions.has(layer.handle)) {
        layer.handle = asyncHandler(layer.handle);
      }
    }
  }

  // Patch method functions for future route additions
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'use'] as const;
  for (const method of methods) {
    const originalMethod = (router as any)[method];
    if (typeof originalMethod !== 'function' || (originalMethod as any).__wrapped) continue;

    const patchedMethod = function (this: any, ...args: any[]) {
      const wrappedArgs = args.map(arg => {
        if (typeof arg === 'function' && arg.length !== 4 && !(arg as any).stack && !wrappedFunctions.has(arg)) {
          return asyncHandler(arg);
        }
        return arg;
      });
      return originalMethod.apply(this, wrappedArgs);
    };

    (patchedMethod as any).__wrapped = true;
    (router as any)[method] = patchedMethod;
  }

  return router;
}
