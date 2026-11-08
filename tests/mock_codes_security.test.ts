import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldExposeMockCodes } from '../server/services/mockCodeHelper.js';

describe('FIX 2: Mock Code Security Helper & Exposure Controls', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalAllow = process.env.ALLOW_MOCK_CODES;
  const originalResend = process.env.RESEND_API_KEY;

  beforeEach(() => {
    delete process.env.ALLOW_MOCK_CODES;
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalAllow !== undefined) process.env.ALLOW_MOCK_CODES = originalAllow;
    else delete process.env.ALLOW_MOCK_CODES;
    if (originalResend !== undefined) process.env.RESEND_API_KEY = originalResend;
    else delete process.env.RESEND_API_KEY;
  });

  it('never exposes mock codes in production even if ALLOW_MOCK_CODES is true', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_MOCK_CODES = 'true';

    expect(shouldExposeMockCodes()).toBe(false);
  });

  it('exposes mock codes in development ONLY when ALLOW_MOCK_CODES is true', () => {
    process.env.NODE_ENV = 'development';

    process.env.ALLOW_MOCK_CODES = 'false';
    expect(shouldExposeMockCodes()).toBe(false);

    delete process.env.ALLOW_MOCK_CODES;
    expect(shouldExposeMockCodes()).toBe(false);

    process.env.ALLOW_MOCK_CODES = 'true';
    expect(shouldExposeMockCodes()).toBe(true);
  });

  it('does not expose mock codes when RESEND_API_KEY is configured and ALLOW_MOCK_CODES is off', () => {
    process.env.NODE_ENV = 'development';
    process.env.RESEND_API_KEY = 're_test_key_123';
    process.env.ALLOW_MOCK_CODES = 'false';

    expect(shouldExposeMockCodes()).toBe(false);
  });
});
