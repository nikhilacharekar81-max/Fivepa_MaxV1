import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

export function isProduction(): boolean {
  const isCompiledProductionBundle = typeof __filename === 'string'
    ? path.basename(__filename).startsWith('server.js')
    : false;
  const isNpmStart = process.env.npm_lifecycle_event === 'start';
  const isExplicitProd = process.env.NODE_ENV === 'production';
  const isTestEnv = process.env.NODE_ENV === 'test';

  return (isExplicitProd || isNpmStart || isCompiledProductionBundle) && !isTestEnv;
}

export const IS_PRODUCTION = isProduction();
if (IS_PRODUCTION) {
  (process.env as any).NODE_ENV = 'production';
}
