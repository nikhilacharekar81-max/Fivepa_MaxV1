import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { shouldExposeMockCodes } from '../server/services/mockCodeHelper.js';

describe('FIX 2: Mock Code Security Helper & Exposure Controls', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalAllow = process.env.ALLOW_MOCK_CODES;
  const originalResend = process.env.RESEND_API_KEY;

  beforeEach(() => {
    delete process.env.ALLOW_MOCK_CODES;
    delete process.env.RESEND_API_KEY;
  });

  // Note: Cleanup would normally be done via afterEach in node:test, 
  // but it's fine for simple test suites to just reset in beforeEach.
  // We'll rely on the beforeEach to keep the state clean.

  it('never exposes mock codes in production even if ALLOW_MOCK_CODES is true', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_MOCK_CODES = 'true';

    assert.strictEqual(shouldExposeMockCodes(), false);
  });

  it('exposes mock codes in development ONLY when ALLOW_MOCK_CODES is true', () => {
    process.env.NODE_ENV = 'development';

    process.env.ALLOW_MOCK_CODES = 'false';
    assert.strictEqual(shouldExposeMockCodes(), false);

    delete process.env.ALLOW_MOCK_CODES;
    assert.strictEqual(shouldExposeMockCodes(), false);

    process.env.ALLOW_MOCK_CODES = 'true';
    assert.strictEqual(shouldExposeMockCodes(), true);
  });

  it('does not expose mock codes when RESEND_API_KEY is configured and ALLOW_MOCK_CODES is off', () => {
    process.env.NODE_ENV = 'development';
    process.env.RESEND_API_KEY = 're_test_key_123';
    process.env.ALLOW_MOCK_CODES = 'false';

    assert.strictEqual(shouldExposeMockCodes(), false);
  });
});
