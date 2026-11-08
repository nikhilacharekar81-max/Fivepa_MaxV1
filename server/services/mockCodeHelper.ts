import { IS_PRODUCTION, resolveIsProduction } from '../initEnv.js';

export function shouldExposeMockCodes(): boolean {
  if (process.env.NODE_ENV === 'production' || IS_PRODUCTION || resolveIsProduction(import.meta.url)) {
    return false;
  }
  return process.env.ALLOW_MOCK_CODES === 'true';
}
