// Authoritative Single Source of Truth for WorkPerHour / FivePA Fee Policy & Calculations.
// Canonical Defaults:
// - 20% Freelancer Commission
// - 1% Buyer Service Fee
// - $1.00 Small Order Fee for orders strictly below $200
// - $1.00 Minimum Order Amount

export interface FeeConfig {
  /** Platform commission taken from the gig price (freelancer keeps 100 - this). Default 20. */
  commissionPercent: number;
  /** Client service fee charged on top of the gig price. Default 1. */
  buyerFeePercent: number;
  /** Flat fee added when the gig price is strictly under the threshold. Default 1.00. */
  smallOrderFee: number;
  /** Orders with a gig price strictly below this get the small-order fee. Default 200. */
  smallOrderThreshold: number;
  /** Minimum order amount allowed. Default 1.00. */
  minimumOrderAmount?: number;
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  commissionPercent: 20,
  buyerFeePercent: 1,
  smallOrderFee: 1.00,
  smallOrderThreshold: 200,
  minimumOrderAmount: 1.00
};

export const DEFAULT_FEE_POLICY: FeeConfig = DEFAULT_FEE_CONFIG;

export interface OrderFeeBreakdown {
  gigPrice: number;          // what the freelancer's gig/extras cost (escrowed amount)
  serviceFee: number;        // client service fee (buyerFeePercent of gigPrice)
  buyerFee?: number;         // alias for serviceFee
  smallOrderFee: number;     // flat fee, 0 when gigPrice >= threshold
  clientTotal: number;       // gigPrice + serviceFee + smallOrderFee: what the client pays
  platformCommission: number;// commissionPercent of gigPrice, taken at escrow release
  freelancerNet: number;     // gigPrice - platformCommission
  freelancerPercent: number; // 100 - commissionPercent
  platformRevenue: number;   // commission + serviceFee + smallOrderFee
  cents: {
    gigPrice: number;
    serviceFee: number;
    smallOrderFee: number;
    clientTotal: number;
    platformCommission: number;
    freelancerNet: number;
  };
}

/** Percent of an integer-cent amount, rounded half-up to a whole cent. */
export function percentOfCents(cents: number, percent: number): number {
  const bps = Math.round(percent * 100); // 1% -> 100 basis points
  return Math.floor((cents * bps + 5000) / 10000);
}

export function toCents(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new Error('Amount must be a non-negative number.');
  }
  return Math.round(amount * 100);
}

export function validateFeeConfig(cfg: FeeConfig): void {
  const pct = (v: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
  if (!pct(cfg.commissionPercent)) throw new Error('commissionPercent must be between 0 and 100.');
  if (!pct(cfg.buyerFeePercent)) throw new Error('buyerFeePercent must be between 0 and 100.');
  if (typeof cfg.smallOrderFee !== 'number' || !Number.isFinite(cfg.smallOrderFee) || cfg.smallOrderFee < 0) {
    throw new Error('smallOrderFee must be a non-negative number.');
  }
  if (typeof cfg.smallOrderThreshold !== 'number' || !Number.isFinite(cfg.smallOrderThreshold) || cfg.smallOrderThreshold < 0) {
    throw new Error('smallOrderThreshold must be a non-negative number.');
  }
}

/**
 * FivePA Fee Rules:
 *  1. Freelancer commission: platform keeps commissionPercent (20%) of the gig price; freelancer gets the rest (80%).
 *  2. Client service fee: buyerFeePercent (1%) of the gig price, charged on top.
 *  3. Small-order fee: flat smallOrderFee ($1.00) on top when the gig price is strictly under smallOrderThreshold ($200).
 *     The threshold is tested against the gig price (gig + extras), before the service fee.
 */
export function calculateOrderFees(gigPrice: number, cfg: FeeConfig = DEFAULT_FEE_CONFIG): OrderFeeBreakdown {
  validateFeeConfig(cfg);
  const gig = toCents(gigPrice);
  const service = percentOfCents(gig, cfg.buyerFeePercent);
  const small = gig > 0 && gig < toCents(cfg.smallOrderThreshold) ? toCents(cfg.smallOrderFee) : 0;
  const commission = percentOfCents(gig, cfg.commissionPercent);
  const net = gig - commission;
  const total = gig + service + small;
  const d = (c: number) => c / 100;
  return {
    gigPrice: d(gig),
    serviceFee: d(service),
    smallOrderFee: d(small),
    clientTotal: d(total),
    platformCommission: d(commission),
    freelancerNet: d(net),
    freelancerPercent: Math.round((100 - cfg.commissionPercent) * 100) / 100,
    platformRevenue: d(commission + service + small),
    cents: {
      gigPrice: gig,
      serviceFee: service,
      smallOrderFee: small,
      clientTotal: total,
      platformCommission: commission,
      freelancerNet: net
    }
  };
}

/**
 * Resolves the effective fee policy for an order, checking order snapshot first, then site settings, then default FivePA config.
 */
export function resolveEffectiveFeePolicy(orderSnapshot?: any, fallbackConfig: FeeConfig = DEFAULT_FEE_CONFIG): FeeConfig {
  if (!orderSnapshot) return { ...fallbackConfig };

  const commissionPercent = orderSnapshot.commission_percent ??
    (orderSnapshot.feeBreakdown?.freelancerPercent !== undefined ? (100 - orderSnapshot.feeBreakdown.freelancerPercent) : undefined) ??
    orderSnapshot.fee_breakdown?.commissionPercent ??
    fallbackConfig.commissionPercent;

  const buyerFeePercent = orderSnapshot.buyer_fee_percent ??
    orderSnapshot.feeBreakdown?.buyerFeePercent ??
    orderSnapshot.fee_breakdown?.buyerFeePercent ??
    fallbackConfig.buyerFeePercent;

  const smallOrderFee = orderSnapshot.small_order_fee_amount ??
    orderSnapshot.feeBreakdown?.smallOrderFeeAmount ??
    orderSnapshot.fee_breakdown?.smallOrderFee ??
    fallbackConfig.smallOrderFee;

  const smallOrderThreshold = orderSnapshot.small_order_threshold ??
    orderSnapshot.feeBreakdown?.smallOrderThreshold ??
    orderSnapshot.fee_breakdown?.smallOrderThreshold ??
    fallbackConfig.smallOrderThreshold;

  const minimumOrderAmount = orderSnapshot.minimum_order_amount ??
    orderSnapshot.feeBreakdown?.minimumOrderAmount ??
    orderSnapshot.fee_breakdown?.minimumOrderAmount ??
    fallbackConfig.minimumOrderAmount;

  return {
    commissionPercent,
    buyerFeePercent,
    smallOrderFee,
    smallOrderThreshold,
    minimumOrderAmount
  };
}

/**
 * Computes differential fees when topping up an existing escrow order.
 * Preserves historical policy and computes additional amounts without double-charging base fees.
 */
export function calculateDifferentialFees(previousOrderAmount: number, newTotalOrderAmount: number, policy: FeeConfig = DEFAULT_FEE_CONFIG) {
  validateFeeConfig(policy);
  const prev = calculateOrderFees(previousOrderAmount, policy);
  const next = calculateOrderFees(newTotalOrderAmount, policy);

  const additionalGigPrice = Math.max(0, next.gigPrice - prev.gigPrice);
  const additionalServiceFee = Number(Math.max(0, next.serviceFee - prev.serviceFee).toFixed(2));
  const additionalSmallOrderFee = Number(Math.max(0, next.smallOrderFee - prev.smallOrderFee).toFixed(2));
  const additionalClientTotal = Number((additionalGigPrice + additionalServiceFee + additionalSmallOrderFee).toFixed(2));
  const additionalCommission = Number(Math.max(0, next.platformCommission - prev.platformCommission).toFixed(2));
  const additionalFreelancerNet = Number((additionalGigPrice - additionalCommission).toFixed(2));

  return {
    additionalGigPrice,
    additionalServiceFee,
    additionalSmallOrderFee,
    additionalClientTotal,
    additionalCommission,
    additionalFreelancerNet,
    next,
    prev
  };
}

/**
 * Server-side helper to quote an order amount against the live Admin settings stored in PostgreSQL.
 * Fails closed if siteSettings is corrupted or unavailable.
 */
export async function quoteOrderWithLiveSettings(amount: number, client?: any): Promise<OrderFeeBreakdown> {
  const settingsModulePath = '../admin/siteSettings.js';
  const { siteSettings } = await import(/* @vite-ignore */ settingsModulePath);
  const comm = siteSettings.getSettings().commission;
  if (!comm) {
    throw new Error('Commission settings are missing or uninitialized.');
  }
  const policy: FeeConfig = {
    commissionPercent: comm.commissionPercent ?? DEFAULT_FEE_CONFIG.commissionPercent,
    buyerFeePercent: comm.buyerProcessingFeePercent ?? DEFAULT_FEE_CONFIG.buyerFeePercent,
    smallOrderFee: comm.smallOrderFeeAmount ?? DEFAULT_FEE_CONFIG.smallOrderFee,
    smallOrderThreshold: comm.smallOrderFeeThreshold ?? DEFAULT_FEE_CONFIG.smallOrderThreshold,
    minimumOrderAmount: comm.minimumOrderAmount ?? DEFAULT_FEE_CONFIG.minimumOrderAmount
  };
  return calculateOrderFees(amount, policy);
}
