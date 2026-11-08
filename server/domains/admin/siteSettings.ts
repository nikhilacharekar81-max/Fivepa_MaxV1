import fs from 'fs';
import path from 'path';
import { DEFAULT_FEE_CONFIG, calculateOrderFees, type FeeConfig } from '../../../src/shared/fees.js';

export interface WebsiteSettings {
  siteName: string;
  siteTagline: string;
  supportEmail: string;
  contactPhone: string;
  helpdeskUrl: string;
  maintenanceMode: boolean;
  copyrightText: string;
}

export interface PlatformCommissionSettings {
  commissionPercent: number; // platform cut of the gig price; freelancer keeps the rest (default 20)
  buyerProcessingFeePercent: number; // client service fee on top of the gig price (default 1)
  smallOrderFeeAmount: number; // flat fee added when the gig price is strictly under the threshold (default 1.00)
  smallOrderFeeThreshold: number; // gig price below this triggers the small-order fee (default 200)
  refundClientFeesOnFullRefund: boolean; // return service + small-order fee when an order is fully refunded
  minimumOrderAmount: number; // default 5.00
  escrowProtectionDays: number; // default 14
  commissionDeductionTiming: 'on_escrow_release' | 'on_order_checkout';
}

export interface MembershipPlanTier {
  id: string;
  name: string;
  priceMonthly: number;
  bidsPerMonth: number;
  commissionDiscountPercent: number; // reduction from base commission
  featuredBadge: boolean;
  enabled: boolean;
}

export interface MembershipPlansSettings {
  membershipsEnabled: boolean;
  freelancerPlans: MembershipPlanTier[];
  buyerPlans: {
    id: string;
    name: string;
    priceMonthly: number;
    jobPostsPerMonth: number;
    zeroBuyerFee: boolean;
    enabled: boolean;
  }[];
}

export interface GigsProjectsOrdersSettings {
  gigModerationRequired: boolean; // Auto-publish vs Require Admin Approval
  projectModerationRequired: boolean;
  minimumGigPrice: number;
  maximumGigPrice: number;
  minimumProjectBudget: number;
  maximumProjectBudget: number;
  maxActiveOrdersPerFreelancer: number; // 0 for unlimited
  autoCompleteDeliveredDays: number; // default 3 days
  autoCompleteDeliveredEnabled: boolean; // default true (toggle auto-accept on/off with one setting)
  allowBuyerCancellationRequests: boolean;
  featuredGigFee: number; // Default 10
}

export interface WalletsWithdrawalsSettings {
  minimumWithdrawalAmount: number;
  maximumWithdrawalPerTransaction: number;
  dailyWithdrawalLimit: number;
  payoutProcessingSchedule: 'instant_auto' | 'daily_batch' | 'manual_review_all' | 'manual_review_over_threshold';
  manualReviewThresholdAmount: number; // e.g. 500
  platformCoversGatewayFees: boolean;
  allowedPayoutMethods: {
    upi: boolean;
    bankTransfer: boolean;
    stripeConnect: boolean;
    razorpayX: boolean;
    paypal: boolean;
  };
  depositHoldDaysBeforeWithdraw: number;
}

export interface LanguageCurrencySettings {
  defaultCurrency: 'USD' | 'EUR' | 'GBP' | 'INR' | 'CAD' | 'AUD';
  currencySymbolPlacement: 'before' | 'after';
  decimalPlaces: 0 | 2;
  primaryLanguage: 'en_US' | 'en_GB' | 'es' | 'fr' | 'de' | 'hi';
  dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';
  timezone: string;
}

export interface SecurityRegistrationSettings {
  allowNewRegistrations: boolean;
  requireEmailVerification: boolean;
  requireKycForPayouts: boolean;
  requireAdmin2FA: boolean;
  maxFailedLoginsLockout: number;
  sessionTimeoutMinutes: number;
  minPasswordLength: number;
}

export interface EmailsIntegrationsSettings {
  emailSenderName: string;
  emailSenderAddress: string;
  sendWelcomeEmail: boolean;
  sendOrderStatusEmails: boolean;
  sendPayoutStatusEmails: boolean;
  sendDisputeAdminAlerts: boolean;
  stripeEnabled: boolean;
  stripePublishableKeyMasked: string;
  razorpayEnabled: boolean;
}

export interface SettingsHistoryItem {
  id: string;
  timestamp: string;
  section: string;
  settingName: string;
  oldValue: string;
  newValue: string;
  actor: string;
  notes?: string;
}

export interface SiteSettingsState {
  website: WebsiteSettings;
  commission: PlatformCommissionSettings;
  memberships: MembershipPlansSettings;
  marketplace: GigsProjectsOrdersSettings;
  wallets: WalletsWithdrawalsSettings;
  localization: LanguageCurrencySettings;
  security: SecurityRegistrationSettings;
  integrations: EmailsIntegrationsSettings;
}

// Sensible Out-of-the-Box Defaults
export const DEFAULT_SITE_SETTINGS: SiteSettingsState = {
  website: {
    siteName: 'WorkPerHour',
    siteTagline: 'Hire Top Freelancers & Discover Quality Services',
    supportEmail: 'support@workperhour.com',
    contactPhone: '+1 (800) 555-WORK',
    helpdeskUrl: 'https://support.workperhour.com',
    maintenanceMode: false,
    copyrightText: '© 2026 WorkPerHour Inc. All rights reserved.'
  },
  commission: {
    commissionPercent: DEFAULT_FEE_CONFIG.commissionPercent, // 20% platform take rate
    buyerProcessingFeePercent: DEFAULT_FEE_CONFIG.buyerFeePercent, // 1% client service fee
    smallOrderFeeAmount: DEFAULT_FEE_CONFIG.smallOrderFee, // $1.00 flat fee...
    smallOrderFeeThreshold: DEFAULT_FEE_CONFIG.smallOrderThreshold, // ...on orders under $200
    refundClientFeesOnFullRefund: true,
    minimumOrderAmount: 5.0,
    escrowProtectionDays: 14, // 14-day mandatory vault
    commissionDeductionTiming: 'on_escrow_release'
  },
  memberships: {
    membershipsEnabled: true,
    freelancerPlans: [
      { id: 'plan_free', name: 'Standard Freelancer', priceMonthly: 0, bidsPerMonth: 0, commissionDiscountPercent: 0, featuredBadge: false, enabled: true },
      { id: 'plan_pro', name: 'WorkPerHour Pro Talent', priceMonthly: 29, bidsPerMonth: 0, commissionDiscountPercent: 2, featuredBadge: true, enabled: true }
    ],
    buyerPlans: [
      { id: 'buyer_free', name: 'Standard Client', priceMonthly: 0, jobPostsPerMonth: 0, zeroBuyerFee: false, enabled: true },
      { id: 'buyer_enterprise', name: 'Enterprise Client', priceMonthly: 99, jobPostsPerMonth: 0, zeroBuyerFee: true, enabled: true }
    ]
  },
  marketplace: {
    gigModerationRequired: false, // published directly by default
    projectModerationRequired: false,
    minimumGigPrice: 5,
    maximumGigPrice: 10000,
    minimumProjectBudget: 5,
    maximumProjectBudget: 50000,
    maxActiveOrdersPerFreelancer: 0, // 0 for unlimited (allows high-velocity sellers and buyers without artificial caps)
    autoCompleteDeliveredDays: 3,
    autoCompleteDeliveredEnabled: true,
    allowBuyerCancellationRequests: true,
    featuredGigFee: 10
  },
  wallets: {
    minimumWithdrawalAmount: 3,
    maximumWithdrawalPerTransaction: 5000,
    dailyWithdrawalLimit: 10000,
    payoutProcessingSchedule: 'manual_review_over_threshold',
    manualReviewThresholdAmount: 500,
    platformCoversGatewayFees: true,
    allowedPayoutMethods: {
      upi: true,
      bankTransfer: true,
      stripeConnect: true,
      razorpayX: true,
      paypal: true
    },
    depositHoldDaysBeforeWithdraw: 0
  },
  localization: {
    defaultCurrency: 'USD',
    currencySymbolPlacement: 'before',
    decimalPlaces: 2,
    primaryLanguage: 'en_US',
    dateFormat: 'YYYY-MM-DD',
    timezone: 'UTC'
  },
  security: {
    allowNewRegistrations: true,
    requireEmailVerification: true,
    requireKycForPayouts: true,
    requireAdmin2FA: true,
    maxFailedLoginsLockout: 5,
    sessionTimeoutMinutes: 60,
    minPasswordLength: 6
  },
  integrations: {
    emailSenderName: 'WorkPerHour Notifications',
    emailSenderAddress: 'notifications@workperhour.com',
    sendWelcomeEmail: true,
    sendOrderStatusEmails: true,
    sendPayoutStatusEmails: true,
    sendDisputeAdminAlerts: true,
    stripeEnabled: true,
    stripePublishableKeyMasked: 'pk_test_51Mz...••••',
    razorpayEnabled: true
  }
};

export class SiteSettingsService {
  private settings: SiteSettingsState;
  private history: SettingsHistoryItem[] = [];

  constructor() {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SITE_SETTINGS));
    this.loadFromDisk();
    this.syncFeesToLedger();
  }

  private normalizeCommissionSettings(commission: PlatformCommissionSettings): PlatformCommissionSettings {
    const rawComm = Number(commission.commissionPercent);
    const normalizedCommissionPercent = Number.isFinite(rawComm) && rawComm >= 0 && rawComm <= 100
      ? rawComm
      : DEFAULT_SITE_SETTINGS.commission.commissionPercent;

    const rawBuyerFee = Number(commission.buyerProcessingFeePercent);
    const normalizedBuyerProcessingFeePercent = Number.isFinite(rawBuyerFee) && rawBuyerFee >= 0 && rawBuyerFee <= 100
      ? rawBuyerFee
      : DEFAULT_FEE_CONFIG.buyerFeePercent;

    const rawSmallOrderFee = Number(commission.smallOrderFeeAmount);
    const normalizedSmallOrderFeeAmount = Number.isFinite(rawSmallOrderFee) && rawSmallOrderFee >= 0
      ? rawSmallOrderFee
      : DEFAULT_FEE_CONFIG.smallOrderFee;

    const rawSmallOrderThreshold = Number(commission.smallOrderFeeThreshold);
    const normalizedSmallOrderFeeThreshold = Number.isFinite(rawSmallOrderThreshold) && rawSmallOrderThreshold >= 0
      ? rawSmallOrderThreshold
      : DEFAULT_FEE_CONFIG.smallOrderThreshold;

    const rawMinOrder = Number(commission.minimumOrderAmount);
    const normalizedMinimumOrderAmount = Number.isFinite(rawMinOrder) && rawMinOrder >= 0
      ? rawMinOrder
      : (DEFAULT_FEE_CONFIG.minimumOrderAmount ?? 5.00);

    const cleaned: PlatformCommissionSettings = {
      ...commission,
      commissionPercent: normalizedCommissionPercent,
      buyerProcessingFeePercent: normalizedBuyerProcessingFeePercent,
      smallOrderFeeAmount: normalizedSmallOrderFeeAmount,
      smallOrderFeeThreshold: normalizedSmallOrderFeeThreshold,
      minimumOrderAmount: normalizedMinimumOrderAmount
    };
    delete (cleaned as any).featuredGigFee;
    delete (cleaned as any).featureGigFee;
    return cleaned;
  }

  private normalizeMarketplaceGigLimits(marketplace: GigsProjectsOrdersSettings): GigsProjectsOrdersSettings {
    const rawMin = Number(marketplace.minimumGigPrice);
    const normalizedMin = Number.isFinite(rawMin) && rawMin >= 0
      ? rawMin
      : DEFAULT_SITE_SETTINGS.marketplace.minimumGigPrice;
    const rawMax = Number(marketplace.maximumGigPrice);
    const normalizedMax =
      Number.isFinite(rawMax) && rawMax > 0
        ? Math.min(10000, Math.max(normalizedMin, rawMax))
        : 10000;
    const rawMinProjectBudget = Number(marketplace.minimumProjectBudget);
    const normalizedMinProjectBudget = Number.isFinite(rawMinProjectBudget) && rawMinProjectBudget >= 0
      ? rawMinProjectBudget
      : DEFAULT_SITE_SETTINGS.marketplace.minimumProjectBudget;
    const rawMaxProjectBudget = Number(marketplace.maximumProjectBudget);
    const normalizedMaxProjectBudget =
      Number.isFinite(rawMaxProjectBudget) && rawMaxProjectBudget > 0
        ? Math.max(normalizedMinProjectBudget, rawMaxProjectBudget)
        : 50000;
    const rawFeaturedGigFee = Number(marketplace.featuredGigFee);
    const normalizedFeaturedGigFee =
      Number.isFinite(rawFeaturedGigFee) && rawFeaturedGigFee >= 0
        ? rawFeaturedGigFee
        : DEFAULT_SITE_SETTINGS.marketplace.featuredGigFee;
    return {
      ...marketplace,
      minimumGigPrice: normalizedMin,
      maximumGigPrice: normalizedMax,
      minimumProjectBudget: normalizedMinProjectBudget,
      maximumProjectBudget: normalizedMaxProjectBudget,
      featuredGigFee: normalizedFeaturedGigFee
    };
  }

  private resolvePersistedFeaturedGigFee(parsed: any): number {
    const defaultFee = DEFAULT_SITE_SETTINGS.marketplace.featuredGigFee;
    const rawMarketplaceFee = parsed?.marketplace?.featuredGigFee ?? parsed?.marketplace?.featureGigFee;
    const rawCommissionFee = parsed?.commission?.featuredGigFee ?? parsed?.commission?.featureGigFee;
    const rawFlatFee = parsed?.featuredGigFee ?? parsed?.featureGigFee;

    const hasMarketplaceFee = rawMarketplaceFee !== undefined && rawMarketplaceFee !== null && Number.isFinite(Number(rawMarketplaceFee)) && Number(rawMarketplaceFee) >= 0;
    const hasCommissionFee = rawCommissionFee !== undefined && rawCommissionFee !== null && Number.isFinite(Number(rawCommissionFee)) && Number(rawCommissionFee) >= 0;
    const hasFlatFee = rawFlatFee !== undefined && rawFlatFee !== null && Number.isFinite(Number(rawFlatFee)) && Number(rawFlatFee) >= 0;

    if (hasMarketplaceFee && hasCommissionFee) {
      const mFee = Number(rawMarketplaceFee);
      const cFee = Number(rawCommissionFee);
      // If marketplace holds the factory default (10) while commission holds a custom non-default value,
      // preserve the custom value from commission so the default marketplace merge never masks it.
      if (mFee === defaultFee && cFee !== defaultFee) {
        return cFee;
      }
      return mFee;
    }
    if (hasMarketplaceFee) {
      return Number(rawMarketplaceFee);
    }
    if (hasCommissionFee) {
      return Number(rawCommissionFee);
    }
    if (hasFlatFee) {
      return Number(rawFlatFee);
    }
    return defaultFee;
  }

  public loadFromState(parsed: any) {
    if (parsed && typeof parsed === 'object') {
      const resolvedFeaturedGigFee = this.resolvePersistedFeaturedGigFee(parsed);
      const mergedCommission = this.normalizeCommissionSettings({
        ...DEFAULT_SITE_SETTINGS.commission,
        ...(parsed.commission || {})
      });
      const mergedMarketplace = this.normalizeMarketplaceGigLimits({
        ...DEFAULT_SITE_SETTINGS.marketplace,
        ...(parsed.marketplace || {}),
        featuredGigFee: resolvedFeaturedGigFee
      });
      this.settings = {
        website: { ...DEFAULT_SITE_SETTINGS.website, ...(parsed.website || {}) },
        commission: mergedCommission,
        memberships: { ...DEFAULT_SITE_SETTINGS.memberships, ...(parsed.memberships || {}) },
        marketplace: mergedMarketplace,
        wallets: { ...DEFAULT_SITE_SETTINGS.wallets, ...(parsed.wallets || {}) },
        localization: { ...DEFAULT_SITE_SETTINGS.localization, ...(parsed.localization || {}) },
        security: { ...DEFAULT_SITE_SETTINGS.security, ...(parsed.security || {}), requireEmailVerification: true },
        integrations: { ...DEFAULT_SITE_SETTINGS.integrations, ...(parsed.integrations || {}) },
      };
      this.syncFeesToLedger();
    }
  }

  private loadFromDisk() {
    // Deprecated: Site settings are now loaded from PostgreSQL via hydrateStoreFromPostgres()
    this.syncFeesToLedger();
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
        const persisted = await postgresStore.loadSiteSettings();
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

  public async saveToDatabase(): Promise<void> {
    const { postgresStore } = await import('../../db/postgresStore.js');
    await postgresStore.saveSiteSettings(this.settings);
    this.lastRefreshedAt = Date.now();
  }

  public saveToDisk() {
    this.saveToDatabase().catch(err => {
      console.error('[SiteSettingsService] Failed to save site settings in background:', err);
    });
  }

  public getSettings(): SiteSettingsState {
    if (Date.now() - this.lastRefreshedAt > 5000) {
      void this.refreshFromDatabase(false);
    }
    return JSON.parse(JSON.stringify(this.settings));
  }

  public getSettingsHistory(): SettingsHistoryItem[] {
    return [...this.history];
  }

  // Shared Fee Calculation Service: Used across entire application.
  // Delegates to src/shared/fees.ts so the ledger, the API and the UI all use identical math.
  public getFeeConfig(customCommissionPercent?: number): FeeConfig {
    const c = this.settings.commission;
    return {
      commissionPercent: customCommissionPercent !== undefined ? customCommissionPercent : c.commissionPercent,
      buyerFeePercent: c.buyerProcessingFeePercent ?? DEFAULT_FEE_CONFIG.buyerFeePercent,
      smallOrderFee: c.smallOrderFeeAmount ?? DEFAULT_FEE_CONFIG.smallOrderFee,
      smallOrderThreshold: c.smallOrderFeeThreshold ?? DEFAULT_FEE_CONFIG.smallOrderThreshold,
      minimumOrderAmount: c.minimumOrderAmount ?? (DEFAULT_FEE_CONFIG.minimumOrderAmount ?? 5.00)
    };
  }

  public calculateFeeSplit(orderAmount: number, customCommissionPercent?: number) {
    const cfg = this.getFeeConfig(customCommissionPercent);
    const f = calculateOrderFees(Math.max(0, orderAmount), cfg);
    return {
      orderAmount: f.gigPrice,
      commissionPercent: cfg.commissionPercent,
      platformFee: f.platformCommission,
      freelancerPercent: f.freelancerPercent,
      freelancerAmount: f.freelancerNet,
      buyerProcessingFeePercent: cfg.buyerFeePercent,
      buyerFee: f.serviceFee,
      smallOrderFee: f.smallOrderFee,
      totalBuyerCharged: f.clientTotal
    };
  }

  // Pushes every fee rule to the finance ledger, which is what actually enforces them on money movement.
  private syncFeesToLedger() {
    const c = this.settings.commission;
    import('../finance/financeService.js').then(({ financeService }) => {
      financeService.configure({
        commissionPercent: c.commissionPercent,
        buyerFeePercent: c.buyerProcessingFeePercent ?? DEFAULT_FEE_CONFIG.buyerFeePercent,
        smallOrderFee: c.smallOrderFeeAmount ?? DEFAULT_FEE_CONFIG.smallOrderFee,
        smallOrderThreshold: c.smallOrderFeeThreshold ?? DEFAULT_FEE_CONFIG.smallOrderThreshold,
        refundClientFeesOnFullRefund: c.refundClientFeesOnFullRefund,
        minimumOrderAmount: c.minimumOrderAmount ?? 5.00
      });
    }).catch(() => {});
  }

  // Update a specific section of settings
  public updateSection<K extends keyof SiteSettingsState>(
    section: K,
    updates: Partial<SiteSettingsState[K]>,
    actor: string = 'Super Admin'
  ): SiteSettingsState[K] {
    if (section === 'localization' && (updates as any).defaultCurrency && (updates as any).defaultCurrency !== 'USD') {
      throw new Error('Only USD is supported as the platform default currency.');
    }
    const currentSection = this.settings[section];
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Track changed keys in history
    for (const [key, val] of Object.entries(updates)) {
      const oldVal = (currentSection as any)[key];
      const oldStr = typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal);
      const newStr = typeof val === 'object' ? JSON.stringify(val) : String(val);

      if (oldStr !== newStr) {
        this.history.unshift({
          id: `SET-HIST-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`,
          timestamp,
          section: section.charAt(0).toUpperCase() + section.slice(1),
          settingName: key,
          oldValue: oldStr,
          newValue: newStr,
          actor,
          notes: `Updated ${key} in ${section} section`
        });
      }
    }

    // Apply updates
    const mergedSection = {
      ...currentSection,
      ...updates
    };
    this.settings[section] =
      section === 'marketplace'
        ? (this.normalizeMarketplaceGigLimits(mergedSection as GigsProjectsOrdersSettings) as SiteSettingsState[K])
        : section === 'commission'
          ? (this.normalizeCommissionSettings(mergedSection as PlatformCommissionSettings) as SiteSettingsState[K])
          : mergedSection;

    // If any fee rule changed, sync immediately to the double-entry finance ledger
    if (section === 'commission') {
      try {
        this.syncFeesToLedger();
      } catch (err) {
        // Invalid fee values must never reach money movement: roll the section back and re-throw.
        this.settings[section] = currentSection;
        this.syncFeesToLedger();
        throw err;
      }
    }

    this.saveToDisk();
    return JSON.parse(JSON.stringify(this.settings[section]));
  }

  // Reset a section or all settings back to default (Awaits database persistence)
  public async resetToDefaults(section?: keyof SiteSettingsState, actor: string = 'Super Admin'): Promise<SiteSettingsState> {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

    if (section) {
      this.settings[section] = JSON.parse(JSON.stringify(DEFAULT_SITE_SETTINGS[section]));
      this.history.unshift({
        id: `SET-HIST-${Date.now()}`,
        timestamp,
        section: section.charAt(0).toUpperCase() + section.slice(1),
        settingName: 'Reset Section',
        oldValue: 'Custom Values',
        newValue: 'Factory Defaults',
        actor,
        notes: `Reset ${section} section to default configuration`
      });

      if (section === 'commission') {
        this.syncFeesToLedger();
      }
    } else {
      this.settings = JSON.parse(JSON.stringify(DEFAULT_SITE_SETTINGS));
      this.history.unshift({
        id: `SET-HIST-${Date.now()}`,
        timestamp,
        section: 'All Settings',
        settingName: 'Factory Reset',
        oldValue: 'Custom Values',
        newValue: 'Factory Defaults',
        actor,
        notes: 'Reset all 9 settings sections back to platform factory defaults'
      });
      try {
        const { financeService } = await import('../finance/financeService.js');
        financeService.setPlatformCommissionRate(DEFAULT_SITE_SETTINGS.commission.commissionPercent);
      } catch {}
    }

    await this.saveToDatabase();
    return this.getSettings();
  }

  public getFlattenedSettings() {
    const s = this.settings;
    return {
      platformName: s.website.siteName,
      brandName: s.website.siteName,
      supportEmail: s.website.supportEmail,
      currency: s.localization.defaultCurrency,
      currencySymbol: '$',
      freelancerCommissionRate: s.commission.commissionPercent,
      buyerProcessingFeeRate: s.commission.buyerProcessingFeePercent ?? DEFAULT_FEE_CONFIG.buyerFeePercent,
      clientServiceFee: s.commission.buyerProcessingFeePercent ?? DEFAULT_FEE_CONFIG.buyerFeePercent,
      smallOrderFee: s.commission.smallOrderFeeAmount ?? DEFAULT_FEE_CONFIG.smallOrderFee,
      smallOrderFeeAmount: s.commission.smallOrderFeeAmount ?? DEFAULT_FEE_CONFIG.smallOrderFee,
      smallOrderFeeThreshold: s.commission.smallOrderFeeThreshold ?? DEFAULT_FEE_CONFIG.smallOrderThreshold,
      minOrderAmount: s.commission.minimumOrderAmount ?? 5.00,
      minimumOrder: s.commission.minimumOrderAmount ?? 5.00,
      minimumOrderAmount: s.commission.minimumOrderAmount ?? 5.00,
      featuredGigFee: s.marketplace.featuredGigFee ?? DEFAULT_SITE_SETTINGS.marketplace.featuredGigFee,
      urgentProjectFee: (s.marketplace as any).urgentProjectFee ?? 25,
      escrowHoldDays: s.commission.escrowProtectionDays,
      autoCompleteDeliveredDays: s.marketplace.autoCompleteDeliveredDays,
      autoCompleteDays: s.marketplace.autoCompleteDeliveredDays,
      reviewWindowDays: s.marketplace.autoCompleteDeliveredDays,
      autoCompleteDeliveredEnabled: s.marketplace.autoCompleteDeliveredEnabled,
      autoCompleteEnabled: s.marketplace.autoCompleteDeliveredEnabled,
      disputeWindowDays: 14,
      minPayoutThreshold: s.wallets.minimumWithdrawalAmount,
      minimumWithdrawal: s.wallets.minimumWithdrawalAmount,
      instantPayoutFeeRate: 1.5,
      freelancerOnboardingMode: (s.marketplace as any).freelancerOnboardingMode ?? 'open',
      maintenanceMode: s.website.maintenanceMode,
      minimumGigPrice: s.marketplace.minimumGigPrice,
      maximumGigPrice: s.marketplace.maximumGigPrice,
      minimumProjectBudget: s.marketplace.minimumProjectBudget,
      maximumProjectBudget: s.marketplace.maximumProjectBudget,
      gigModerationRequired: s.marketplace.gigModerationRequired,
      projectModerationRequired: s.marketplace.projectModerationRequired,
      allowNewRegistrations: s.security.allowNewRegistrations ?? true,
      requireEmailVerification: true
    };
  }

  public updateFromFlatObject(body: any, actor: string = 'Super Admin') {
    if (!body || typeof body !== 'object') return this.getFlattenedSettings();
    if (body.defaultCurrency && body.defaultCurrency !== 'USD') {
      throw new Error('Only USD is supported as the platform default currency.');
    }

    const commissionUpdates: Partial<PlatformCommissionSettings> = {};
    const marketplaceUpdates: Partial<GigsProjectsOrdersSettings> & Record<string, any> = {};
    const walletUpdates: Partial<WalletsWithdrawalsSettings> = {};
    const websiteUpdates: Partial<WebsiteSettings> = {};
    const localizationUpdates: Partial<LanguageCurrencySettings> = {};

    if (body.freelancerCommissionRate !== undefined) commissionUpdates.commissionPercent = Number(body.freelancerCommissionRate);
    if (body.escrowHoldDays !== undefined) {
      commissionUpdates.escrowProtectionDays = Number(body.escrowHoldDays);
    }
    if (body.buyerProcessingFeeRate !== undefined || body.clientServiceFee !== undefined || body.buyerFee !== undefined) {
      commissionUpdates.buyerProcessingFeePercent = Number(body.buyerProcessingFeeRate ?? body.clientServiceFee ?? body.buyerFee);
    }
    if (body.smallOrderFeeAmount !== undefined || body.smallOrderFee !== undefined) {
      commissionUpdates.smallOrderFeeAmount = Number(body.smallOrderFeeAmount ?? body.smallOrderFee);
    }
    if (body.smallOrderFeeThreshold !== undefined || body.smallOrderThreshold !== undefined) {
      commissionUpdates.smallOrderFeeThreshold = Number(body.smallOrderFeeThreshold ?? body.smallOrderThreshold);
    }
    if (body.minOrderAmount !== undefined || body.minimumOrderAmount !== undefined || body.minimumOrder !== undefined) {
      commissionUpdates.minimumOrderAmount = Number(body.minOrderAmount ?? body.minimumOrderAmount ?? body.minimumOrder);
    }

    if (body.autoCompleteDays !== undefined || body.autoCompleteDeliveredDays !== undefined || body.reviewWindowDays !== undefined) {
      marketplaceUpdates.autoCompleteDeliveredDays = Number(body.autoCompleteDays ?? body.autoCompleteDeliveredDays ?? body.reviewWindowDays);
    }
    if (body.autoCompleteEnabled !== undefined || body.autoCompleteDeliveredEnabled !== undefined) {
      marketplaceUpdates.autoCompleteDeliveredEnabled = Boolean(body.autoCompleteEnabled ?? body.autoCompleteDeliveredEnabled);
    }
    if (body.minimumGigPrice !== undefined || body.minGigPrice !== undefined) {
      marketplaceUpdates.minimumGigPrice = Number(body.minimumGigPrice ?? body.minGigPrice);
    }
    if (body.maximumGigPrice !== undefined || body.maxGigPrice !== undefined) {
      marketplaceUpdates.maximumGigPrice = Number(body.maximumGigPrice ?? body.maxGigPrice);
    }
    if (body.minimumProjectBudget !== undefined || body.minProjectBudget !== undefined) {
      marketplaceUpdates.minimumProjectBudget = Number(body.minimumProjectBudget ?? body.minProjectBudget);
    }
    if (body.maximumProjectBudget !== undefined || body.maxProjectBudget !== undefined) {
      marketplaceUpdates.maximumProjectBudget = Number(body.maximumProjectBudget ?? body.maxProjectBudget);
    }
    if (body.gigModerationRequired !== undefined) {
      marketplaceUpdates.gigModerationRequired = Boolean(body.gigModerationRequired);
    }
    if (body.projectModerationRequired !== undefined) {
      marketplaceUpdates.projectModerationRequired = Boolean(body.projectModerationRequired);
    }
    const incomingFeaturedFee =
      body.featuredGigFee ??
      body.featureGigFee ??
      body.marketplace?.featuredGigFee ??
      body.marketplace?.featureGigFee ??
      body.commission?.featuredGigFee ??
      body.commission?.featureGigFee;
    if (incomingFeaturedFee !== undefined) {
      marketplaceUpdates.featuredGigFee = Number(incomingFeaturedFee);
    }
    if (body.urgentProjectFee !== undefined) {
      marketplaceUpdates.urgentProjectFee = Number(body.urgentProjectFee);
    }

    if (body.minPayoutThreshold !== undefined || body.minimumWithdrawal !== undefined) {
      walletUpdates.minimumWithdrawalAmount = Number(body.minPayoutThreshold ?? body.minimumWithdrawal);
    }

    if (body.brandName !== undefined || body.platformName !== undefined || body.siteName !== undefined) {
      websiteUpdates.siteName = String(body.brandName ?? body.platformName ?? body.siteName);
    }
    if (body.supportEmail !== undefined) {
      websiteUpdates.supportEmail = String(body.supportEmail);
    }
    if (body.maintenanceMode !== undefined) {
      websiteUpdates.maintenanceMode = Boolean(body.maintenanceMode);
    }

    if (body.currency !== undefined) {
      const curStr = String(body.currency);
      const matched = curStr.match(/^[A-Z]{3}/);
      if (matched) localizationUpdates.defaultCurrency = matched[0] as any;
    }

    const securityUpdates: Partial<SecurityRegistrationSettings> = {};

    if (body.allowNewRegistrations !== undefined) {
      securityUpdates.allowNewRegistrations = Boolean(body.allowNewRegistrations);
    }
    // Compulsory email verification: always keep mandatory
    securityUpdates.requireEmailVerification = true;

    if (Object.keys(commissionUpdates).length > 0) this.updateSection('commission', commissionUpdates, actor);
    if (Object.keys(marketplaceUpdates).length > 0) this.updateSection('marketplace', marketplaceUpdates, actor);
    if (Object.keys(walletUpdates).length > 0) this.updateSection('wallets', walletUpdates, actor);
    if (Object.keys(websiteUpdates).length > 0) this.updateSection('website', websiteUpdates, actor);
    if (Object.keys(localizationUpdates).length > 0) this.updateSection('localization', localizationUpdates, actor);
    if (Object.keys(securityUpdates).length > 0) this.updateSection('security', securityUpdates, actor);

    this.saveToDisk();
    return this.getFlattenedSettings();
  }
}

// Global Singleton Instance
export const siteSettings = new SiteSettingsService();
