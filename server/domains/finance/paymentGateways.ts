import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IS_PRODUCTION as INIT_IS_PRODUCTION, resolveIsProduction } from '../../initEnv.js';

export interface GatewayConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  webhookId: string;
  primary: boolean;
}

export interface EnvironmentGateways {
  paypal: GatewayConfig;
  stripe: GatewayConfig;
  razorpay: GatewayConfig;
}

export interface ConnectionTestStatus {
  status: 'untested' | 'verified' | 'failed';
  lastTestedAt?: string;
  lastSuccessAt?: string;
  message?: string;
}

export interface PaymentGatewaysState {
  production: EnvironmentGateways;
  sandbox: EnvironmentGateways;
  activePayPalEnvironment?: 'sandbox' | 'production';
  connectionTestStatus?: Record<string, ConnectionTestStatus>;
}

const DEFAULT_GATEWAY: GatewayConfig = {
  enabled: false,
  clientId: '',
  clientSecret: '',
  webhookId: '',
  primary: false
};

const DEFAULT_ENV_GATEWAYS: EnvironmentGateways = {
  paypal: { ...DEFAULT_GATEWAY, primary: true },
  stripe: { ...DEFAULT_GATEWAY },
  razorpay: { ...DEFAULT_GATEWAY }
};

const DEFAULT_STATE: PaymentGatewaysState = {
  production: JSON.parse(JSON.stringify(DEFAULT_ENV_GATEWAYS)),
  sandbox: JSON.parse(JSON.stringify(DEFAULT_ENV_GATEWAYS)),
  activePayPalEnvironment: 'sandbox',
  connectionTestStatus: {}
};

const WEAK_GATEWAY_KEY_PLACEHOLDERS = new Set([
  'changeme',
  'secret',
  'default',
  'gateway_encryption_key',
  'your-gateway-encryption-key',
  'your_gateway_encryption_key',
  'dev_mode_fixed_gateway_encryption_key_12345',
  'replace-with-strong-secret',
  'password',
  '12345678',
  '1234567890123456',
  'admin',
  'administrator',
  'supersecret',
  'mysecretkey123456',
  'testsecretkey1234',
  'secretkey1234567890',
  'jwt_secret',
  'production_gateway_key'
]);

const DETERMINISTIC_DEV_GATEWAY_KEY = crypto
  .createHash('sha256')
  .update(process.env.JWT_SECRET || process.env.DATABASE_URL || 'fivepa-local-dev-gateway-encryption-key-v1')
  .digest();

function hasLowEntropyKey(key: string): boolean {
  const trimmed = key.trim();
  const uniqueChars = new Set(trimmed).size;
  if (uniqueChars < 8) return true;

  for (let patternLen = 1; patternLen <= 8; patternLen++) {
    const pattern = trimmed.slice(0, patternLen);
    const repeated = pattern.repeat(Math.ceil(trimmed.length / patternLen)).slice(0, trimmed.length);
    if (trimmed === repeated) return true;
  }

  const alphaSeq = 'abcdefghijklmnopqrstuvwxyz0123456789';
  if (alphaSeq.includes(trimmed.toLowerCase())) return true;
  const numSeq = '0123456789012345678901234567890123456789';
  if (numSeq.includes(trimmed)) return true;

  return false;
}

export function isValidGatewayEncryptionKey(key: unknown, isProductionCheck = false): key is string {
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  const minLen = isProductionCheck ? 32 : 16;
  if (trimmed.length < minLen) return false;

  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (WEAK_GATEWAY_KEY_PLACEHOLDERS.has(trimmed.toLowerCase()) || WEAK_GATEWAY_KEY_PLACEHOLDERS.has(normalized)) {
    return false;
  }

  if (hasLowEntropyKey(trimmed)) return false;

  return true;
}

export function assertProductionGatewayEncryptionKey(): string {
  const rawKey = process.env.GATEWAY_ENCRYPTION_KEY;
  if (!isValidGatewayEncryptionKey(rawKey, true)) {
    throw new Error(
      'FATAL: Production requires an explicit, high-entropy GATEWAY_ENCRYPTION_KEY environment variable (minimum 32 characters, independent of JWT_SECRET, non-placeholder, non-repetitive). Predictable fallback encryption keys are disabled in production.'
    );
  }
  const trimmedKey = rawKey.trim();
  const jwtSecret = process.env.JWT_SECRET?.trim();
  if (jwtSecret && trimmedKey.toLowerCase() === jwtSecret.toLowerCase()) {
    throw new Error(
      'FATAL: Production GATEWAY_ENCRYPTION_KEY must be independent of JWT_SECRET.'
    );
  }
  return trimmedKey;
}

if (INIT_IS_PRODUCTION || process.env.NODE_ENV === 'production' || resolveIsProduction(import.meta.url)) {
  assertProductionGatewayEncryptionKey();
}

function getEncryptionKey(): Buffer {
  const isProd = INIT_IS_PRODUCTION || process.env.NODE_ENV === 'production' || resolveIsProduction(import.meta.url);
  const rawKey = process.env.GATEWAY_ENCRYPTION_KEY;
  if (isValidGatewayEncryptionKey(rawKey, isProd)) {
    if (isProd && process.env.JWT_SECRET && rawKey.trim().toLowerCase() === process.env.JWT_SECRET.trim().toLowerCase()) {
      throw new Error(
        'FATAL: Production GATEWAY_ENCRYPTION_KEY must be independent of JWT_SECRET.'
      );
    }
    const trimmed = rawKey.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    return crypto.createHash('sha256').update(trimmed).digest();
  }
  if (isProd) {
    assertProductionGatewayEncryptionKey();
  }
  return DETERMINISTIC_DEV_GATEWAY_KEY;
}

const GATEWAY_FETCH_TIMEOUT_MS = 10_000;

export function resolveValidatedAppUrl(): string {
  const isProd = INIT_IS_PRODUCTION || process.env.NODE_ENV === 'production' || resolveIsProduction(import.meta.url);
  const rawUrl = (process.env.APP_URL || '').trim();
  const isPlaceholder = !rawUrl || rawUrl === 'MY_APP_URL' || rawUrl === 'YOUR_APP_URL';

  if (isPlaceholder) {
    if (isProd) {
      throw new Error('FATAL: APP_URL environment variable must be configured with an https:// URL in production.');
    }
    return 'http://localhost:3000';
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid APP_URL configuration ("${rawUrl}"). Must be a valid absolute URL.`);
  }

  if (isProd && parsed.protocol !== 'https:') {
    throw new Error(`Invalid APP_URL protocol ("${parsed.protocol}") in production. APP_URL must use https://.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported APP_URL protocol ("${parsed.protocol}").`);
  }

  return rawUrl.replace(/\/$/, '');
}

export function resolvePayPalEnv(): 'production' | 'sandbox' {
  // Database-managed Admin Panel selection is authoritative.
  const activeEnv = paymentGatewayManager.getActivePayPalEnvironment();
  if (activeEnv === 'production' || activeEnv === 'sandbox') {
    return activeEnv;
  }
  const explicitMode = (process.env.PAYPAL_MODE || '').trim().toLowerCase();
  if (explicitMode === 'live' || explicitMode === 'production') return 'production';
  if (explicitMode === 'sandbox' || explicitMode === 'test') return 'sandbox';
  return 'sandbox';
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext || plaintext.trim() === '') return '';
  if (plaintext.startsWith('enc:gcm:')) {
    // Validate that the existing GCM payload is authentic and decryptable before accepting
    decryptSecret(plaintext);
    return plaintext;
  }
  if (plaintext.includes('••••')) return '';
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `enc:gcm:${iv.toString('hex')}:${tag}:${encrypted}`;
  } catch (err) {
    console.error('[PaymentGateway] Encryption error (failing closed):', err);
    throw err;
  }
}

export function decryptSecret(ciphertext: string): string {
  if (!ciphertext || ciphertext.trim() === '') {
    return '';
  }
  if (!ciphertext.startsWith('enc:gcm:')) {
    throw new Error('Fail closed: Gateway credential must be GCM encrypted.');
  }
  try {
    const key = getEncryptionKey();
    const parts = ciphertext.split(':');
    if (parts.length !== 5) {
      throw new Error('Malformed GCM encrypted secret format.');
    }
    const iv = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const encryptedText = parts[4];
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[PaymentGateway] Decryption authentication error:', err);
    throw new Error(`Failed to decrypt payment gateway secret: ${(err as Error).message}`);
  }
}

export class PaymentGatewayManager {
  private state: PaymentGatewaysState;

  constructor() {
    this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  public loadFromState(parsed: any) {
    if (parsed && typeof parsed === 'object') {
      const decryptGw = (gw: any, defaultPrimary = false): GatewayConfig => {
        const conf: GatewayConfig = { ...DEFAULT_GATEWAY, primary: defaultPrimary, ...(gw || {}) };
        if (conf.clientSecret) {
          try {
            conf.clientSecret = decryptSecret(conf.clientSecret);
          } catch (err) {
            console.error('[PaymentGateway] Resetting unreadable gateway clientSecret on load:', (err as Error).message);
            conf.clientSecret = '';
            conf.enabled = false;
          }
        }
        if (conf.webhookId && conf.webhookId.startsWith('enc:gcm:')) {
          try {
            conf.webhookId = decryptSecret(conf.webhookId);
          } catch (err) {
            console.error('[PaymentGateway] Resetting unreadable gateway webhookId on load:', (err as Error).message);
            conf.webhookId = '';
          }
        }
        return conf;
      };
      this.state = {
        production: {
          paypal: decryptGw(parsed.production?.paypal, true),
          stripe: decryptGw(parsed.production?.stripe, false),
          razorpay: decryptGw(parsed.production?.razorpay, false)
        },
        sandbox: {
          paypal: decryptGw(parsed.sandbox?.paypal, true),
          stripe: decryptGw(parsed.sandbox?.stripe, false),
          razorpay: decryptGw(parsed.sandbox?.razorpay, false)
        },
        activePayPalEnvironment: parsed.activePayPalEnvironment === 'production' ? 'production' : 'sandbox',
        connectionTestStatus: (parsed.connectionTestStatus && typeof parsed.connectionTestStatus === 'object') ? parsed.connectionTestStatus : {}
      };
    }
  }

  private lastRefreshedAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  public async refreshFromDatabase(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastRefreshedAt < 5000) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        const { postgresStore, isPostgresEnabled } = await import('../../db/postgresStore.js');
        if (!isPostgresEnabled()) return;
        const persisted = await postgresStore.loadPaymentGateways();
        if (persisted && typeof persisted === 'object' && Object.keys(persisted).length > 0) {
          this.loadFromState(persisted);
        }
        this.lastRefreshedAt = Date.now();
      } catch {} finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  public getState(): PaymentGatewaysState {
    if (Date.now() - this.lastRefreshedAt > 5000) {
      void this.refreshFromDatabase(false);
    }
    return this.state;
  }

  public getGateway(gatewayName: 'paypal' | 'stripe' | 'razorpay', env?: 'production' | 'sandbox'): GatewayConfig {
    if (Date.now() - this.lastRefreshedAt > 5000) {
      void this.refreshFromDatabase(false);
    }
    const resolvedEnv = env || (gatewayName === 'paypal' ? resolvePayPalEnv() : (process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'));
    const stored = this.state[resolvedEnv]?.[gatewayName] || { ...DEFAULT_GATEWAY };

    if (gatewayName === 'paypal') {
      const modeEnv = (process.env.PAYPAL_MODE || '').trim().toLowerCase();
      const isExplicitProdEnv = modeEnv === 'live' || modeEnv === 'production';
      const isExplicitSandboxEnv = modeEnv === 'sandbox' || modeEnv === 'test';

      // Fallback to legacy environment variables ONLY if environment matches or is sandbox
      const allowEnvFallback = resolvedEnv === 'sandbox' ? !isExplicitProdEnv : isExplicitProdEnv;

      const envClientId = allowEnvFallback ? (process.env.PAYPAL_CLIENT_ID || '').trim() : '';
      const envClientSecret = allowEnvFallback ? (process.env.PAYPAL_CLIENT_SECRET || '').trim() : '';
      const envWebhookId = allowEnvFallback ? (process.env.PAYPAL_WEBHOOK_ID || '').trim() : '';

      const clientId = stored.clientId || envClientId;
      const clientSecret = stored.clientSecret || envClientSecret;
      const webhookId = stored.webhookId || envWebhookId;
      const enabled = stored.enabled || Boolean(clientId && clientSecret);
      return {
        ...stored,
        enabled,
        clientId,
        clientSecret,
        webhookId
      };
    }

    return stored;
  }

  public resolveActiveGatewayName(preferred?: string): 'paypal' | 'stripe' | 'razorpay' {
    const env: 'production' | 'sandbox' = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
    const normPref = String(preferred || '').trim().toLowerCase();
    if (normPref === 'paypal' || normPref === 'stripe' || normPref === 'razorpay') {
      const prefGw = this.getGateway(normPref, normPref === 'paypal' ? resolvePayPalEnv() : env);
      if (prefGw && prefGw.enabled && prefGw.clientSecret) {
        return normPref;
      }
    }
    const candidates: Array<'paypal' | 'stripe' | 'razorpay'> = ['paypal', 'stripe', 'razorpay'];
    for (const name of candidates) {
      const gw = this.getGateway(name, name === 'paypal' ? resolvePayPalEnv() : env);
      if (gw && gw.enabled && gw.primary && gw.clientSecret) return name;
    }
    for (const name of candidates) {
      const gw = this.getGateway(name, name === 'paypal' ? resolvePayPalEnv() : env);
      if (gw && gw.enabled && gw.clientSecret) return name;
    }
    if (normPref === 'paypal' || normPref === 'stripe' || normPref === 'razorpay') {
      return normPref;
    }
    return 'paypal';
  }

  public getActivePayPalEnvironment(): 'sandbox' | 'production' {
    return this.state.activePayPalEnvironment === 'production' ? 'production' : 'sandbox';
  }

  public async setActivePayPalEnvironment(env: 'sandbox' | 'production'): Promise<void> {
    if (env !== 'sandbox' && env !== 'production') {
      throw new Error('Invalid PayPal environment. Must be sandbox or production.');
    }
    this.state.activePayPalEnvironment = env;
    await this.saveToDatabase();
  }

  public getEncryptedState(): PaymentGatewaysState {
    const encryptGw = (gw: GatewayConfig): GatewayConfig => ({
      ...gw,
      clientSecret: encryptSecret(gw.clientSecret),
      webhookId: encryptSecret(gw.webhookId)
    });
    return {
      production: {
        paypal: encryptGw(this.state.production.paypal),
        stripe: encryptGw(this.state.production.stripe),
        razorpay: encryptGw(this.state.production.razorpay)
      },
      sandbox: {
        paypal: encryptGw(this.state.sandbox.paypal),
        stripe: encryptGw(this.state.sandbox.stripe),
        razorpay: encryptGw(this.state.sandbox.razorpay)
      },
      activePayPalEnvironment: this.getActivePayPalEnvironment(),
      connectionTestStatus: this.state.connectionTestStatus || {}
    };
  }

  public async saveToDatabase(): Promise<void> {
    const secureState = this.getEncryptedState();
    const { postgresStore } = await import('../../db/postgresStore.js');
    await postgresStore.savePaymentGateways(secureState);
    this.lastRefreshedAt = Date.now();
  }

  public saveToDisk() {
    this.saveToDatabase().catch(err => {
      console.error('[PaymentGatewayManager] Failed to save payment gateways in background:', err);
    });
  }

  public getMaskedState(): PaymentGatewaysState {
    if (Date.now() - this.lastRefreshedAt > 5000) {
      void this.refreshFromDatabase(false);
    }
    const maskSecret = (secret: string) => {
      if (!secret || secret.trim() === '') return '';
      return '••••••••••••••••';
    };
    const maskWebhook = (whId: string) => {
      if (!whId || whId.trim() === '') return '';
      const trimmed = whId.trim();
      if (trimmed.length <= 4) return '••••••••';
      return `••••••••${trimmed.slice(-4)}`;
    };

    const maskEnv = (envGw: EnvironmentGateways): EnvironmentGateways => ({
      paypal: { ...envGw.paypal, clientSecret: maskSecret(envGw.paypal.clientSecret), webhookId: maskWebhook(envGw.paypal.webhookId) },
      stripe: { ...envGw.stripe, clientSecret: maskSecret(envGw.stripe.clientSecret), webhookId: maskWebhook(envGw.stripe.webhookId) },
      razorpay: { ...envGw.razorpay, clientSecret: maskSecret(envGw.razorpay.clientSecret), webhookId: maskWebhook(envGw.razorpay.webhookId) }
    });

    return {
      production: maskEnv(this.state.production),
      sandbox: maskEnv(this.state.sandbox),
      activePayPalEnvironment: this.getActivePayPalEnvironment(),
      connectionTestStatus: this.state.connectionTestStatus || {}
    };
  }

  public async updateGateway(env: 'production' | 'sandbox', gatewayName: 'paypal' | 'stripe' | 'razorpay', updates: Partial<GatewayConfig>): Promise<EnvironmentGateways> {
    if (env !== 'production' && env !== 'sandbox') throw new Error('Invalid environment.');
    if (!['paypal', 'stripe', 'razorpay'].includes(gatewayName)) throw new Error('Invalid gateway.');

    await this.refreshFromDatabase(true);
    const envState = this.state[env];
    const current = envState[gatewayName];

    let secret = current.clientSecret;
    if (updates.clientSecret !== undefined) {
      const trimmedSecret = String(updates.clientSecret ?? '').trim();
      if (trimmedSecret === '') {
        secret = '';
      } else if (!trimmedSecret.includes('••••')) {
        if (trimmedSecret.startsWith('enc:gcm:')) {
          secret = decryptSecret(trimmedSecret);
        } else {
          secret = trimmedSecret;
        }
      }
    }

    let webhookId = current.webhookId;
    if (updates.webhookId !== undefined) {
      const trimmedWh = String(updates.webhookId ?? '').trim();
      if (trimmedWh === '') {
        webhookId = '';
      } else if (!trimmedWh.includes('••••')) {
        if (trimmedWh.startsWith('enc:gcm:')) {
          webhookId = decryptSecret(trimmedWh);
        } else {
          webhookId = trimmedWh;
        }
      }
    }

    const nextPrimary = updates.primary !== undefined ? Boolean(updates.primary) : current.primary;

    if (nextPrimary) {
      envState.paypal.primary = gatewayName === 'paypal';
      envState.stripe.primary = gatewayName === 'stripe';
      envState.razorpay.primary = gatewayName === 'razorpay';
    }

    envState[gatewayName] = {
      enabled: updates.enabled !== undefined ? Boolean(updates.enabled) : current.enabled,
      clientId: updates.clientId !== undefined ? String(updates.clientId).trim() : current.clientId,
      clientSecret: secret,
      webhookId,
      primary: nextPrimary
    };

    if (!envState.paypal.primary && !envState.stripe.primary && !envState.razorpay.primary) {
      const fallback = (['paypal', 'stripe', 'razorpay'] as const).find(k => envState[k].enabled) || 'paypal';
      envState[fallback].primary = true;
    }

    await this.saveToDatabase();
    return this.getMaskedState()[env];
  }

  public async verifyWebhookSignature(params: { gateway?: string; headers: Record<string, any>; rawBody: Buffer | string; env?: 'production' | 'sandbox' }): Promise<boolean> {
    const gateway = (params.gateway || 'stripe').toLowerCase();
    const env = params.env || (gateway === 'paypal' ? resolvePayPalEnv() : (process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'));
    const gw = this.getGateway(gateway as any, env);
    const webhookSecret = gw?.webhookId;

    const bodyStr = typeof params.rawBody === 'string' ? params.rawBody : params.rawBody.toString('utf8');

    if (gateway === 'stripe') {
      if (!webhookSecret) return false;
      const sigHeader = params.headers['stripe-signature'];
      if (!sigHeader) return false;

      let timestampStr = '';
      const v1Sigs: string[] = [];
      for (const item of String(sigHeader).split(',')) {
        const eqIdx = item.indexOf('=');
        if (eqIdx === -1) continue;
        const k = item.slice(0, eqIdx).trim();
        const v = item.slice(eqIdx + 1).trim();
        if (k === 't' && v) timestampStr = v;
        else if (k === 'v1' && v) v1Sigs.push(v);
      }

      if (!timestampStr || v1Sigs.length === 0) return false;

      const timestamp = Number(timestampStr);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(timestamp) || Math.abs(nowSec - timestamp) > 300) {
        return false;
      }

      const signedPayload = `${timestampStr}.${bodyStr}`;
      const expectedSig = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
      const expBuf = Buffer.from(expectedSig, 'hex');

      for (const candidateSig of v1Sigs) {
        if (!/^[0-9a-fA-F]+$/.test(candidateSig) || candidateSig.length !== expectedSig.length) continue;
        const sigBuf = Buffer.from(candidateSig, 'hex');
        if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
          return true;
        }
      }
      return false;
    } else if (gateway === 'razorpay') {
      if (!webhookSecret) return false;
      const sig = String(params.headers['x-razorpay-signature'] || '').trim();
      if (!sig || !/^[0-9a-fA-F]+$/.test(sig)) return false;

      const rzpTsHeader = params.headers['x-razorpay-timestamp'];
      if (rzpTsHeader !== undefined && rzpTsHeader !== null && String(rzpTsHeader).trim() !== '') {
        const tsNum = Number(rzpTsHeader);
        const nowSec = Math.floor(Date.now() / 1000);
        if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > 300) {
          return false;
        }
      }

      const expectedSig = crypto.createHmac('sha256', webhookSecret).update(bodyStr).digest('hex');
      if (sig.length !== expectedSig.length) return false;
      const sigBuf = Buffer.from(sig, 'hex');
      const expBuf = Buffer.from(expectedSig, 'hex');
      if (sigBuf.length !== expBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expBuf);
    } else if (gateway === 'paypal') {
      // Genuine PayPal REST API Webhook Signature Verification
      if (gw && gw.enabled && gw.clientId && gw.clientSecret && gw.webhookId) {
        const authAlgo = params.headers['paypal-auth-algo'];
        const certUrl = params.headers['paypal-cert-url'];
        const transmissionId = params.headers['paypal-transmission-id'];
        const transmissionSig = params.headers['paypal-transmission-sig'];
        const transmissionTime = params.headers['paypal-transmission-time'];

        if (transmissionId && transmissionSig && certUrl && authAlgo && transmissionTime) {
          try {
            const parsedTransmissionMs = Date.parse(String(transmissionTime));
            if (!Number.isFinite(parsedTransmissionMs)) {
              return false;
            }

            let webhookEventObj: any;
            try {
              webhookEventObj = JSON.parse(bodyStr);
            } catch {
              return false;
            }

            const paypalHost = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
            const tokenRes = await fetch(`${paypalHost}/v1/oauth2/token`, {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: 'grant_type=client_credentials',
              signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
            });

            if (!tokenRes.ok) return false;
            const tokenData: any = await tokenRes.json();

            const verifyRes = await fetch(`${paypalHost}/v1/notifications/verify-webhook-signature`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                auth_algo: String(authAlgo),
                cert_url: String(certUrl),
                transmission_id: String(transmissionId),
                transmission_sig: String(transmissionSig),
                transmission_time: String(transmissionTime),
                webhook_id: gw.webhookId,
                webhook_event: webhookEventObj
              }),
              signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
            });

            if (!verifyRes.ok) return false;
            const verifyData: any = await verifyRes.json();
            return verifyData.verification_status === 'SUCCESS';
          } catch (err) {
            console.error('[PaymentGateway] PayPal webhook signature verification API call failed:', (err as Error).message);
            return false;
          }
        }
      }

      if (process.env.NODE_ENV === 'production' || INIT_IS_PRODUCTION || resolveIsProduction(import.meta.url)) {
        return false;
      }
      const simAllowed = process.env.PAYMENT_SIMULATION_ENABLED !== 'false';
      if (!simAllowed || !webhookSecret) return false;

      const sig = String(params.headers['x-webhook-signature'] || params.headers['paypal-transmission-sig'] || '').trim();
      if (!sig) return false;
      const expectedSig = crypto.createHmac('sha256', webhookSecret).update(bodyStr).digest('hex');
      const sigBuf = Buffer.from(sig.toLowerCase());
      const expBuf = Buffer.from(expectedSig.toLowerCase());
      if (sigBuf.length !== expBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expBuf);
    }
    return false;
  }

  public async capturePayPalOrder(params: {
    paypalOrderId: string;
    expectedSessionId?: string;
    expectedAmount: number;
    expectedCurrency?: string;
    env?: 'production' | 'sandbox';
  }): Promise<{
    verified: boolean;
    paypalOrderId: string;
    captureId: string;
    status: string;
    amountValue: string;
    currencyCode: string;
    customId: string;
    invoiceId: string;
    error?: string;
  }> {
    const isProd = process.env.NODE_ENV === 'production' || INIT_IS_PRODUCTION || resolveIsProduction(import.meta.url);
    const env = params.env || resolvePayPalEnv();
    const gw = this.getGateway('paypal', env);
    const hasCredentials = Boolean(gw && gw.enabled && gw.clientId && gw.clientSecret);
    const expectedCurr = (params.expectedCurrency || 'USD').toUpperCase();

    if (!hasCredentials || params.paypalOrderId.startsWith('sess_sim_')) {
      if (isProd) {
        return {
          verified: false,
          paypalOrderId: params.paypalOrderId,
          captureId: '',
          status: 'FAILED',
          amountValue: '0.00',
          currencyCode: expectedCurr,
          customId: '',
          invoiceId: '',
          error: 'PayPal gateway credentials missing in production.'
        };
      }
      const simAllowed = process.env.PAYMENT_SIMULATION_ENABLED !== 'false';
      if (simAllowed) {
        const simCaptureId = `CAP_SIM_${params.paypalOrderId.replace(/[^a-zA-Z0-9]/g, '').slice(-16).toUpperCase()}`;
        return {
          verified: true,
          paypalOrderId: params.paypalOrderId,
          captureId: simCaptureId,
          status: 'COMPLETED',
          amountValue: params.expectedAmount.toFixed(2),
          currencyCode: expectedCurr,
          customId: params.expectedSessionId || '',
          invoiceId: params.expectedSessionId || ''
        };
      }
      return {
        verified: false,
        paypalOrderId: params.paypalOrderId,
        captureId: '',
        status: 'FAILED',
        amountValue: '0.00',
        currencyCode: expectedCurr,
        customId: '',
        invoiceId: '',
        error: 'PayPal credentials are not configured and PAYMENT_SIMULATION_ENABLED is not enabled.'
      };
    }

    try {
      const paypalHost = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
      const tokenRes = await fetch(`${paypalHost}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
      });
      if (!tokenRes.ok) {
        return {
          verified: false,
          paypalOrderId: params.paypalOrderId,
          captureId: '',
          status: 'FAILED',
          amountValue: '0.00',
          currencyCode: expectedCurr,
          customId: '',
          invoiceId: '',
          error: `PayPal OAuth token request failed (${tokenRes.status}).`
        };
      }
      const tokenData: any = await tokenRes.json();
      const accessToken = tokenData.access_token;

      // Attempt capture directly; if already captured (422 ORDER_ALREADY_CAPTURED), fetch the order resource
      let orderData: any = null;
      const captureRes = await fetch(`${paypalHost}/v2/checkout/orders/${encodeURIComponent(params.paypalOrderId)}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
      });

      if (captureRes.ok) {
        orderData = await captureRes.json();
      } else {
        const getRes = await fetch(`${paypalHost}/v2/checkout/orders/${encodeURIComponent(params.paypalOrderId)}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!getRes.ok) {
          return {
            verified: false,
            paypalOrderId: params.paypalOrderId,
            captureId: '',
            status: 'FAILED',
            amountValue: '0.00',
            currencyCode: expectedCurr,
            customId: '',
            invoiceId: '',
            error: `PayPal capture failed (${captureRes.status}) and order lookup returned ${getRes.status}.`
          };
        }
        orderData = await getRes.json();
      }

      const unit = orderData?.purchase_units?.[0];
      const capture = unit?.payments?.captures?.[0];
      const orderStatus = String(orderData?.status || '').toUpperCase();
      const captureStatus = String(capture?.status || '').toUpperCase();

      if (orderStatus !== 'COMPLETED' || captureStatus !== 'COMPLETED' || !capture?.id) {
        return {
          verified: false,
          paypalOrderId: String(orderData?.id || params.paypalOrderId),
          captureId: String(capture?.id || ''),
          status: captureStatus || orderStatus || 'PENDING',
          amountValue: String(capture?.amount?.value || unit?.amount?.value || '0.00'),
          currencyCode: String(capture?.amount?.currency_code || unit?.amount?.currency_code || '').toUpperCase(),
          customId: String(capture?.custom_id || unit?.custom_id || unit?.reference_id || ''),
          invoiceId: String(capture?.invoice_id || unit?.invoice_id || ''),
          error: `PayPal order/capture is not COMPLETED (order: ${orderStatus}, capture: ${captureStatus || 'NONE'}).`
        };
      }

      const amountValue = String(capture?.amount?.value ?? unit?.amount?.value ?? '');
      const currencyCode = String(capture?.amount?.currency_code ?? unit?.amount?.currency_code ?? '').toUpperCase();
      const customId = String(capture?.custom_id || unit?.custom_id || unit?.reference_id || '');
      const invoiceId = String(capture?.invoice_id || unit?.invoice_id || '');

      if (params.expectedSessionId) {
        const expSess = params.expectedSessionId;
        const capCustom = String(capture?.custom_id || unit?.custom_id || '').trim();
        const capInvoice = String(capture?.invoice_id || unit?.invoice_id || '').trim();
        const unitRef = String(unit?.reference_id || '').trim();

        if (capCustom && capCustom !== expSess) {
          return {
            verified: false,
            paypalOrderId: String(orderData.id),
            captureId: String(capture.id),
            status: captureStatus,
            amountValue,
            currencyCode,
            customId,
            invoiceId,
            error: `PayPal custom_id (${capCustom}) conflicts with expected session (${expSess}).`
          };
        }

        if (capInvoice && capInvoice !== expSess) {
          return {
            verified: false,
            paypalOrderId: String(orderData.id),
            captureId: String(capture.id),
            status: captureStatus,
            amountValue,
            currencyCode,
            customId,
            invoiceId,
            error: `PayPal invoice_id (${capInvoice}) conflicts with expected session (${expSess}).`
          };
        }

        if (unitRef && unitRef !== expSess && !unitRef.startsWith('default') && !unitRef.startsWith('PU_') && !unitRef.startsWith('item_')) {
          return {
            verified: false,
            paypalOrderId: String(orderData.id),
            captureId: String(capture.id),
            status: captureStatus,
            amountValue,
            currencyCode,
            customId,
            invoiceId,
            error: `PayPal reference_id (${unitRef}) conflicts with expected session (${expSess}).`
          };
        }

        const matchesCustom = capCustom === expSess;
        const matchesInvoice = capInvoice === expSess;
        const matchesRef = unitRef === expSess;
        const matchesOrder = String(orderData.id) === expSess || String(params.paypalOrderId) === expSess;

        if (!matchesCustom && !matchesInvoice && !matchesRef && !matchesOrder) {
          return {
            verified: false,
            paypalOrderId: String(orderData.id),
            captureId: String(capture.id),
            status: captureStatus,
            amountValue,
            currencyCode,
            customId,
            invoiceId,
            error: `PayPal response contains no matching identity association for expected session (${expSess}).`
          };
        }
      }

      if (currencyCode !== expectedCurr) {
        return {
          verified: false,
          paypalOrderId: String(orderData.id),
          captureId: String(capture.id),
          status: captureStatus,
          amountValue,
          currencyCode,
          customId,
          invoiceId,
          error: `PayPal currency mismatch: expected ${expectedCurr}, got ${currencyCode || 'missing'}.`
        };
      }

      const paidCents = Math.round(Number(amountValue) * 100);
      const expectedCents = Math.round(Number(params.expectedAmount) * 100);
      if (!Number.isFinite(paidCents) || paidCents !== expectedCents) {
        return {
          verified: false,
          paypalOrderId: String(orderData.id),
          captureId: String(capture.id),
          status: captureStatus,
          amountValue,
          currencyCode,
          customId,
          invoiceId,
          error: `PayPal amount mismatch: expected $${params.expectedAmount.toFixed(2)}, got $${amountValue}.`
        };
      }

      return {
        verified: true,
        paypalOrderId: String(orderData.id),
        captureId: String(capture.id),
        status: captureStatus,
        amountValue,
        currencyCode,
        customId,
        invoiceId
      };
    } catch (err: any) {
      return {
        verified: false,
        paypalOrderId: params.paypalOrderId,
        captureId: '',
        status: 'ERROR',
        amountValue: '0.00',
        currencyCode: expectedCurr,
        customId: '',
        invoiceId: '',
        error: `PayPal capture exception: ${err.message}`
      };
    }
  }

  public async verifyPaymentEvent(params: {
    gateway: 'stripe' | 'paypal' | 'razorpay' | string;
    sessionId?: string;
    paypalOrderId?: string;
    transactionId?: string;
    expectedAmount: number;
    expectedCurrency: string;
    env?: 'production' | 'sandbox';
  }): Promise<{ verified: boolean; error?: string; captureId?: string; paypalOrderId?: string }> {
    const isProd = process.env.NODE_ENV === 'production' || INIT_IS_PRODUCTION || resolveIsProduction(import.meta.url);
    const gwName = (params.gateway || 'stripe').toLowerCase() as 'stripe' | 'paypal' | 'razorpay';
    const env = params.env || (gwName === 'paypal' ? resolvePayPalEnv() : (isProd ? 'production' : 'sandbox'));
    const gw = this.getGateway(gwName, env);
    const hasCredentials = gw && gw.enabled && gw.clientSecret;

    if (!hasCredentials) {
      if (isProd) {
        return { verified: false, error: `Payment gateway "${gwName}" credentials missing in production.` };
      }
      const simAllowed = process.env.PAYMENT_SIMULATION_ENABLED !== 'false';
      if (simAllowed) {
        return { verified: true, captureId: params.transactionId, paypalOrderId: params.paypalOrderId };
      }
      return { verified: false, error: `Gateway credentials missing and simulation disabled.` };
    }

    try {
      if (gwName === 'stripe') {
        const idToLookup = params.sessionId || params.transactionId;
        if (!idToLookup) return { verified: false, error: 'Missing session or transaction ID for Stripe verification.' };

        const url = idToLookup.startsWith('cs_')
          ? `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(idToLookup)}`
          : `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(idToLookup)}`;

        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${gw.clientSecret}` },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!res.ok) {
          return { verified: false, error: `Stripe API verification returned status ${res.status}` };
        }
        const data: any = await res.json();
        const paid = data.payment_status === 'paid' || data.status === 'succeeded';
        if (!paid) return { verified: false, error: `Stripe payment not completed (status: ${data.payment_status || data.status})` };

        const liveAmount = (data.amount_total ?? data.amount) / 100;
        const liveCurrency = (data.currency || '').toUpperCase();

        if (liveCurrency !== params.expectedCurrency.toUpperCase()) {
          return { verified: false, error: `Currency mismatch: expected ${params.expectedCurrency}, got ${liveCurrency}` };
        }
        if (Math.round(liveAmount * 100) !== Math.round(params.expectedAmount * 100)) {
          return { verified: false, error: `Amount mismatch: expected ${params.expectedAmount}, got ${liveAmount}` };
        }
        return { verified: true };
      } else if (gwName === 'paypal') {
        const paypalHost = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
        const tokenRes = await fetch(`${paypalHost}/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!tokenRes.ok) return { verified: false, error: 'PayPal OAuth handshake failed.' };
        const tokenData: any = await tokenRes.json();
        const accessToken = tokenData.access_token;

        // 1. If we have a capture ID (transactionId from PAYMENT.CAPTURE.COMPLETED), verify the capture resource directly
        if (params.transactionId && !params.transactionId.startsWith('chk_')) {
          const capRes = await fetch(`${paypalHost}/v2/payments/captures/${encodeURIComponent(params.transactionId)}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
          });
          if (capRes.ok) {
            const capData: any = await capRes.json();
            if (String(capData.status || '').toUpperCase() !== 'COMPLETED') {
              return { verified: false, error: `PayPal capture status is ${capData.status}. Payment must be COMPLETED.` };
            }
            const capCurr = String(capData.amount?.currency_code || '').toUpperCase();
            const capVal = Number(capData.amount?.value);
            if (capCurr !== params.expectedCurrency.toUpperCase()) {
              return { verified: false, error: `PayPal capture currency mismatch: ${capCurr}` };
            }
            if (!Number.isFinite(capVal) || Math.round(capVal * 100) !== Math.round(params.expectedAmount * 100)) {
              return { verified: false, error: `PayPal capture amount mismatch: ${capData.amount?.value}` };
            }
            const customId = capData.custom_id || capData.invoice_id;
            if (params.sessionId && customId && customId !== params.sessionId) {
              return { verified: false, error: `PayPal capture custom_id mismatch: expected ${params.sessionId}, got ${customId}` };
            }
            const relatedOrderId = capData.supplementary_data?.related_ids?.order_id || params.paypalOrderId;
            return { verified: true, captureId: String(capData.id), paypalOrderId: relatedOrderId ? String(relatedOrderId) : undefined };
          }
        }

        // 2. Otherwise verify by PayPal Order ID
        const orderIdToLookup = params.paypalOrderId || (params.sessionId && !params.sessionId.startsWith('chk_') ? params.sessionId : undefined) || params.transactionId;
        if (!orderIdToLookup) return { verified: false, error: 'Missing PayPal order or capture ID for verification.' };

        const orderRes = await fetch(`${paypalHost}/v2/checkout/orders/${encodeURIComponent(orderIdToLookup)}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!orderRes.ok) return { verified: false, error: `PayPal order lookup failed (${orderRes.status})` };
        const orderData: any = await orderRes.json();

        if (orderData.status !== 'COMPLETED') {
          return { verified: false, error: `PayPal order status is ${orderData.status}. Payment must be COMPLETED.` };
        }

        const unit = orderData.purchase_units?.[0];
        const capture = unit?.payments?.captures?.[0];
        if (capture && String(capture.status || '').toUpperCase() !== 'COMPLETED') {
          return { verified: false, error: `PayPal capture status is ${capture.status}.` };
        }

        const refId = capture?.custom_id || unit?.custom_id || unit?.reference_id || unit?.invoice_id;
        if (params.sessionId && params.sessionId.startsWith('chk_') && refId && refId !== params.sessionId) {
          return { verified: false, error: `PayPal reference mismatch: expected session ${params.sessionId}, got ${refId}` };
        }

        const amtObj = capture?.amount || unit?.amount;
        if (!amtObj) return { verified: false, error: 'PayPal purchase unit amount missing.' };

        if (String(amtObj.currency_code || '').toUpperCase() !== params.expectedCurrency.toUpperCase()) {
          return { verified: false, error: `PayPal currency mismatch: ${amtObj.currency_code}` };
        }
        if (Math.round(Number(amtObj.value) * 100) !== Math.round(params.expectedAmount * 100)) {
          return { verified: false, error: `PayPal amount mismatch: ${amtObj.value}` };
        }
        return {
          verified: true,
          captureId: capture?.id ? String(capture.id) : undefined,
          paypalOrderId: orderData?.id ? String(orderData.id) : undefined
        };
      } else if (gwName === 'razorpay') {
        const idToLookup = params.transactionId || params.sessionId;
        if (!idToLookup) return { verified: false, error: 'Missing transaction ID for Razorpay verification.' };

        const authHeader = `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`;
        const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(idToLookup)}`, {
          headers: { 'Authorization': authHeader },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!res.ok) return { verified: false, error: `Razorpay payment lookup failed (${res.status})` };
        const data: any = await res.json();

        if (data.status !== 'captured') {
          return { verified: false, error: `Razorpay payment status is ${data.status}. Payment must be captured.` };
        }
        const liveAmount = Number(data.amount) / 100;
        const liveCurrency = (data.currency || '').toUpperCase();

        if (liveCurrency !== params.expectedCurrency.toUpperCase()) {
          return { verified: false, error: `Razorpay currency mismatch: ${liveCurrency}` };
        }
        if (Math.round(liveAmount * 100) !== Math.round(params.expectedAmount * 100)) {
          return { verified: false, error: `Razorpay amount mismatch: ${liveAmount}` };
        }
        return { verified: true };
      }
      return { verified: false, error: `Unsupported gateway: ${gwName}` };
    } catch (err: any) {
      return { verified: false, error: `Provider payment verification exception: ${err.message}` };
    }
  }

  public async verifyPayoutSettlement(params: { method: string; providerReference: string; amount: number; payoutId: string }): Promise<{ verified: boolean; providerTxId: string; status: string }> {
    const isProd = process.env.NODE_ENV === 'production';
    const env = isProd ? 'production' : 'sandbox';
    const ref = params.providerReference ? params.providerReference.trim() : '';

    let gwName: 'paypal' | 'stripe' | 'razorpay' | null = null;
    const lowerMethod = params.method.toLowerCase();
    if (lowerMethod.includes('paypal')) gwName = 'paypal';
    else if (lowerMethod.includes('stripe')) gwName = 'stripe';
    else if (lowerMethod.includes('razorpay') || lowerMethod.includes('upi')) gwName = 'razorpay';

    const gw = gwName ? this.getGateway(gwName, gwName === 'paypal' ? resolvePayPalEnv() : env) : null;
    const hasCredentials = gw && gw.enabled && gw.clientSecret;

    if (!hasCredentials) {
      if (isProd) {
        throw new Error(`Payout provider configuration missing or disabled for method "${params.method}" in production. Settlement verification fails closed.`);
      }
      const simAllowed = process.env.PAYMENT_SIMULATION_ENABLED !== 'false';
      if (!simAllowed) {
        throw new Error(`Payout provider credentials missing for method "${params.method}". Enable provider credentials or configure PAYMENT_SIMULATION_ENABLED=true for explicit development simulation.`);
      }
      if (!ref || ref.startsWith('MOCK') || ref.startsWith('SYNTHETIC') || ref.startsWith('GW-SETTLE-SIM') || ref.startsWith('GW-SETTLE-')) {
        return {
          verified: true,
          providerTxId: ref || `SIM-TX-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
          status: 'settled'
        };
      }
    }

    if (!ref) {
      throw new Error('Provider transaction reference is required for payout settlement verification.');
    }

    try {
      if (gwName === 'stripe' && gw && gw.clientSecret) {
        const response = await fetch(`https://api.stripe.com/v1/transfers/${encodeURIComponent(ref)}`, {
          headers: { 'Authorization': `Bearer ${gw.clientSecret}` },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!response.ok) {
          throw new Error(`Stripe transfer lookup failed with status ${response.status}`);
        }
        const data: any = await response.json();
        if (data.reversed || (data.amount_reversed || 0) > 0) {
          throw new Error(`Stripe transfer ${ref} has been reversed.`);
        }
        if (data.currency?.toLowerCase() !== 'usd') {
          throw new Error('Payout currency mismatch: expected USD');
        }
        if (Math.abs(Number(data.amount) / 100 - params.amount) > 0.01) {
          throw new Error('Payout amount mismatch with provider record');
        }
        return { verified: true, providerTxId: data.id, status: 'settled' };
      } else if (gwName === 'paypal' && gw && gw.clientId && gw.clientSecret) {
        const paypalEnv = resolvePayPalEnv();
        const paypalHost = paypalEnv === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
        const tokenRes = await fetch(`${paypalHost}/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!tokenRes.ok) throw new Error('PayPal auth handshake failed during payout verification.');
        const tokenData: any = await tokenRes.json();
        const payoutRes = await fetch(`${paypalHost}/v1/payments/payouts-item/${encodeURIComponent(ref)}`, {
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!payoutRes.ok) {
          throw new Error(`PayPal payout item lookup failed with status ${payoutRes.status}`);
        }
        const payoutData: any = await payoutRes.json();
        const pStatus = payoutData.payout_item?.transaction_status;
        if (pStatus !== 'SUCCESS') {
          throw new Error(`PayPal payout transaction status is "${pStatus}". Expected terminal status "SUCCESS".`);
        }
        const pVal = Number(payoutData.payout_item?.amount?.value || 0);
        const pCurr = payoutData.payout_item?.amount?.currency;
        if (pCurr !== 'USD') throw new Error('PayPal payout currency mismatch: expected USD.');
        if (Math.abs(pVal - params.amount) > 0.01) throw new Error('PayPal payout amount mismatch.');
        return { verified: true, providerTxId: payoutData.payout_item_id || ref, status: 'settled' };
      } else if (gwName === 'razorpay' && gw && gw.clientId && gw.clientSecret) {
        const authHeader = `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`;
        const razorRes = await fetch(`https://api.razorpay.com/v1/payouts/${encodeURIComponent(ref)}`, {
          headers: { 'Authorization': authHeader },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!razorRes.ok) {
          throw new Error(`Razorpay payout lookup failed with status ${razorRes.status}`);
        }
        const razorData: any = await razorRes.json();
        if (razorData.status !== 'processed') {
          throw new Error(`Razorpay payout status is "${razorData.status}". Expected terminal status "processed".`);
        }
        const rVal = Number(razorData.amount || 0) / 100;
        if (razorData.currency !== 'USD') throw new Error('Razorpay payout currency mismatch: expected USD.');
        if (Math.abs(rVal - params.amount) > 0.01) throw new Error('Razorpay payout amount mismatch.');
        return { verified: true, providerTxId: razorData.id || ref, status: 'settled' };
      } else {
        throw new Error(`Payout provider verification is not configured or supported for method "${params.method}".`);
      }
    } catch (err: any) {
      console.error(`[PaymentGateways] Provider settlement verification error for payout ${params.payoutId}:`, err.message);
      if (isProd) {
        throw new Error(`Provider payout settlement verification failed: ${err.message}`);
      }
      throw err;
    }
  }

  public async createCheckoutSession(params: {
    gateway: 'stripe' | 'paypal' | 'razorpay';
    amount: number;
    currency: string;
    userId: string;
    orderId?: string;
    purpose?: string;
    description?: string;
    checkoutId: string;
    env?: 'production' | 'sandbox';
  }): Promise<{ providerSessionId: string; checkoutUrl: string }> {
    const isProd = process.env.NODE_ENV === 'production' || INIT_IS_PRODUCTION || resolveIsProduction(import.meta.url);
    const env = params.env || (params.gateway === 'paypal' ? resolvePayPalEnv() : (isProd ? 'production' : 'sandbox'));
    
    if (params.currency !== 'USD') {
      throw new Error('Only USD currency is supported for payment checkout sessions.');
    }
    if (params.amount < 1.00) {
      throw new Error('Minimum checkout amount is $1.00 USD.');
    }

    const gw = this.getGateway(params.gateway, env);
    const hasCredentials = gw && gw.enabled && gw.clientId && gw.clientSecret;

    if (!hasCredentials) {
      if (isProd) {
        throw new Error(`Payment gateway "${params.gateway.toUpperCase()}" is not enabled or configured in production environment. Checkout fails closed.`);
      }
      const simAllowed = process.env.PAYMENT_SIMULATION_ENABLED !== 'false';
      if (!simAllowed) {
        throw new Error(`Payment gateway "${params.gateway.toUpperCase()}" credentials missing. Set gateway credentials in Super Admin -> Payment Gateways (or PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env) or set PAYMENT_SIMULATION_ENABLED=true.`);
      }
      const simProviderSessionId = `sess_sim_${params.gateway}_${crypto.randomBytes(12).toString('hex')}`;
      const checkoutUrl = `/checkout/pay?session_id=${encodeURIComponent(params.checkoutId)}&gateway=${encodeURIComponent(params.gateway)}&amount=${params.amount.toFixed(2)}&token=${encodeURIComponent(simProviderSessionId)}&simulated=true`;
      return { providerSessionId: simProviderSessionId, checkoutUrl };
    }

    const baseAppUrl = resolveValidatedAppUrl();

    try {
      if (params.gateway === 'stripe') {
        const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${gw.clientSecret}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            'mode': 'payment',
            'success_url': `${baseAppUrl}/checkout/success?session_id=${encodeURIComponent(params.checkoutId)}`,
            'cancel_url': `${baseAppUrl}/checkout/cancel?session_id=${encodeURIComponent(params.checkoutId)}`,
            'client_reference_id': params.checkoutId,
            'line_items[0][price_data][currency]': 'usd',
            'line_items[0][price_data][unit_amount]': String(Math.round(params.amount * 100)),
            'line_items[0][price_data][product_data][name]': params.description || `FivePA ${params.purpose || 'Deposit'}`,
            'line_items[0][quantity]': '1',
            'metadata[userId]': params.userId,
            'metadata[checkoutId]': params.checkoutId
          }).toString(),
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Stripe provider error (${response.status}): ${errText}`);
        }
        const data: any = await response.json();
        return {
          providerSessionId: data.id,
          checkoutUrl: data.url || `/checkout/pay?session_id=${encodeURIComponent(params.checkoutId)}`
        };
      } else if (params.gateway === 'paypal') {
        const paypalHost = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
        const tokenRes = await fetch(`${paypalHost}/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!tokenRes.ok) {
          throw new Error(`PayPal OAuth handshake failed (HTTP ${tokenRes.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.`);
        }
        const tokenData: any = await tokenRes.json();
        const itemDescription = (params.description || `FivePA ${params.purpose === 'deposit' ? 'Wallet Deposit' : 'Marketplace Order Payment'}`).slice(0, 120);
        const orderRes = await fetch(`${paypalHost}/v2/checkout/orders`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`,
            'Content-Type': 'application/json',
            'PayPal-Request-Id': params.checkoutId
          },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{
              reference_id: params.checkoutId,
              custom_id: params.checkoutId,
              invoice_id: params.checkoutId,
              description: itemDescription,
              amount: {
                currency_code: 'USD',
                value: params.amount.toFixed(2)
              }
            }],
            application_context: {
              brand_name: 'FivePA',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: `${baseAppUrl}/checkout/success?session_id=${encodeURIComponent(params.checkoutId)}`,
              cancel_url: `${baseAppUrl}/checkout/cancel?session_id=${encodeURIComponent(params.checkoutId)}`
            }
          }),
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!orderRes.ok) {
          const errBody = await orderRes.text().catch(() => '');
          throw new Error(`PayPal order creation failed (HTTP ${orderRes.status}): ${errBody.slice(0, 200)}`);
        }
        const orderData: any = await orderRes.json();
        const approveLink = orderData.links?.find((l: any) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
        if (!orderData.id || !approveLink) {
          throw new Error('PayPal order response did not contain an order ID and approval URL.');
        }
        return {
          providerSessionId: String(orderData.id),
          checkoutUrl: String(approveLink)
        };
      } else if (params.gateway === 'razorpay') {
        const authHeader = `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`;
        const response = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            amount: Math.round(params.amount * 100),
            currency: 'USD',
            receipt: params.checkoutId,
            notes: { userId: params.userId, checkoutId: params.checkoutId }
          }),
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Razorpay order creation error (${response.status}): ${errText}`);
        }
        const data: any = await response.json();
        return {
          providerSessionId: data.id,
          checkoutUrl: `/checkout/pay?session_id=${encodeURIComponent(params.checkoutId)}&razorpay_order_id=${encodeURIComponent(data.id)}`
        };
      } else {
        throw new Error(`Unsupported payment provider "${params.gateway}".`);
      }
    } catch (err: any) {
      console.error(`[PaymentGateways] Real provider checkout session creation failed for ${params.gateway}:`, err.message);
      if (isProd) {
        throw new Error(`Payment gateway provider error: ${err.message}`);
      }
      throw err;
    }
  }

  public async testConnection(env: 'production' | 'sandbox', gatewayName: 'paypal' | 'stripe' | 'razorpay'): Promise<{ success: boolean; message: string }> {
    const envState = this.state[env];
    const gw = envState[gatewayName];
    const testKey = `${env}_${gatewayName}`;
    if (!this.state.connectionTestStatus) {
      this.state.connectionTestStatus = {};
    }

    const recordResult = async (success: boolean, message: string) => {
      const nowIso = new Date().toISOString();
      const existing = this.state.connectionTestStatus?.[testKey];
      this.state.connectionTestStatus![testKey] = {
        status: success ? 'verified' : 'failed',
        lastTestedAt: nowIso,
        lastSuccessAt: success ? nowIso : existing?.lastSuccessAt,
        message
      };
      await this.saveToDatabase();
      return { success, message };
    };

    if (!gw.enabled) {
      return recordResult(false, `${gatewayName.toUpperCase()} (${env}) is currently disabled. Enable the gateway before testing connection.`);
    }
    if (!gw.clientId && gatewayName !== 'stripe') {
      return recordResult(false, `Missing Client ID for ${gatewayName.toUpperCase()} (${env}).`);
    }
    if (!gw.clientSecret) {
      return recordResult(false, `Missing Client Secret for ${gatewayName.toUpperCase()} (${env}).`);
    }

    try {
      if (gatewayName === 'stripe') {
        const res = await fetch('https://api.stripe.com/v1/balance', {
          headers: { 'Authorization': `Bearer ${gw.clientSecret}` },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!res.ok) {
          const errText = await res.text();
          return recordResult(false, `Stripe API handshake failed (${res.status}): ${errText}`);
        }
        return recordResult(true, `Stripe (${env}) connection verified successfully via live balance handshake.`);
      } else if (gatewayName === 'paypal') {
        const paypalHost = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
        const tokenRes = await fetch(`${paypalHost}/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          return recordResult(false, `PayPal API handshake failed (${tokenRes.status}): ${errText}`);
        }
        return recordResult(true, `PayPal (${env}) connection verified successfully via live OAuth handshake.`);
      } else if (gatewayName === 'razorpay') {
        const authHeader = `Basic ${Buffer.from(`${gw.clientId}:${gw.clientSecret}`).toString('base64')}`;
        const res = await fetch('https://api.razorpay.com/v1/payments?count=1', {
          headers: { 'Authorization': authHeader },
          signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS)
        });
        if (!res.ok) {
          const errText = await res.text();
          return recordResult(false, `Razorpay API handshake failed (${res.status}): ${errText}`);
        }
        return recordResult(true, `Razorpay (${env}) connection verified successfully via live API handshake.`);
      }
      return recordResult(false, `Unsupported gateway: ${gatewayName}`);
    } catch (err: any) {
      return recordResult(false, `Live API handshake error for ${gatewayName.toUpperCase()}: ${err.message}`);
    }
  }
}

export const paymentGatewayManager = new PaymentGatewayManager();
