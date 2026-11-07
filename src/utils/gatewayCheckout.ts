import { getAuthToken } from './authToken';
import { getDeviceId } from './deviceId';

export interface CheckoutReturnMetadata {
  returnAction?:
    | 'wallet_topup'
    | 'create_gig_order'
    | 'accept_proposal'
    | 'accept_offer'
    | 'escrow_deposit'
    | 'feature_gig';
  returnPath?: string;
  title?: string;
  gigOrderPayload?: {
    title: string;
    amount: number;
    buyerId?: string;
    sellerId: string;
    gigId?: string;
    extraIds?: string[];
    dueDate?: string;
    requirements?: string;
  };
  proposalId?: string;
  projectId?: string;
  offerId?: string;
  orderId?: string;
  escrowPayload?: {
    orderId: string;
    amount: number;
    title?: string;
  };
  featureGigId?: string;
  actionCompleted?: boolean;
  actionResult?: any;
}

export interface InitiateGatewayCheckoutParams {
  amount: number;
  currency?: string;
  gateway?: 'paypal' | 'stripe' | 'razorpay';
  purpose?: 'deposit' | 'order_payment' | 'escrow_funding';
  orderId?: string;
  description?: string;
  metadata?: CheckoutReturnMetadata;
  headers?: Record<string, string>;
}

export async function initiateGatewayCheckout(
  params: InitiateGatewayCheckoutParams
): Promise<{ redirected: boolean; sessionId: string; redirectUrl: string; providerOrderId?: string }> {
  const token = getAuthToken();
  const cleanAmount = Math.max(1, Number(Number(params.amount || 0).toFixed(2)));
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-device-id': getDeviceId(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(params.headers || {})
  };

  const res = await fetch('/api/payments/gateway/checkout', {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({
      amount: cleanAmount,
      currency: params.currency || 'USD',
      ...(params.gateway ? { gateway: params.gateway } : {}),
      purpose: params.purpose || 'deposit',
      ...(params.orderId ? { orderId: params.orderId } : {}),
      ...(params.description ? { description: params.description } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {})
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Failed to initialize payment gateway checkout (HTTP ${res.status}).`);
  }

  if (data.redirectUrl && typeof window !== 'undefined') {
    window.location.href = data.redirectUrl;
    return {
      redirected: true,
      sessionId: data.sessionId,
      redirectUrl: data.redirectUrl,
      providerOrderId: data.providerOrderId
    };
  }

  throw new Error('Payment gateway did not return a valid approval URL.');
}
