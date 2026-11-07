import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  ArrowRight,
  Wallet,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  CreditCard
} from 'lucide-react';
import { getAuthToken } from '../../utils/authToken';
import { getDeviceId } from '../../utils/deviceId';
import { CheckoutReturnMetadata } from '../../utils/gatewayCheckout';

interface CheckoutResultViewProps {
  mode: 'success' | 'cancel' | 'pay';
  currentPath: string;
  navigate: (to: string, e?: React.MouseEvent) => void;
  onRefreshUser?: () => Promise<void> | void;
}

interface CheckoutSessionDetails {
  sessionId: string;
  userId?: string;
  gateway: string;
  purpose: string;
  orderId?: string | null;
  amount: number;
  currency: string;
  status: string;
  paypalOrderId?: string | null;
  paypalCaptureId?: string | null;
  walletBalance?: number;
  alreadyProcessed?: boolean;
  metadata?: CheckoutReturnMetadata | null;
}

function formatUsd(val: number | undefined | null): string {
  const num = Number(val || 0);
  if (!Number.isFinite(num)) return '$0.00';
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const CheckoutResultView: React.FC<CheckoutResultViewProps> = ({
  mode,
  currentPath,
  navigate,
  onRefreshUser
}) => {
  const [phase, setPhase] = useState<'processing' | 'completed' | 'pending' | 'cancelled' | 'failed'>(
    mode === 'cancel' ? 'cancelled' : mode === 'pay' ? 'pending' : 'processing'
  );
  const [session, setSession] = useState<CheckoutSessionDetails | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>(
    mode === 'cancel'
      ? 'Payment was cancelled. Your wallet and order have not been charged.'
      : 'Confirming your payment with PayPal...'
  );
  const [completedWorkstreamId, setCompletedWorkstreamId] = useState<string | null>(null);
  const [continuationSummary, setContinuationSummary] = useState<string | null>(null);
  const [isContinuingAction, setIsContinuingAction] = useState(false);

  const captureStartedRef = useRef(false);
  const continuationRanRef = useRef(false);

  const buildHeaders = (): Record<string, string> => {
    const token = getAuthToken();
    return {
      'Content-Type': 'application/json',
      'x-device-id': getDeviceId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  };

  const getQueryParams = () => {
    const qIdx = currentPath.indexOf('?');
    const search =
      qIdx >= 0
        ? currentPath.slice(qIdx)
        : typeof window !== 'undefined'
        ? window.location.search
        : '';
    const params = new URLSearchParams(search);
    return {
      sessionId: params.get('session_id') || params.get('sessionId') || '',
      token: params.get('token') || params.get('order_id') || params.get('paypal_order_id') || '',
      payerId: params.get('PayerID') || '',
      gateway: params.get('gateway') || 'paypal',
      amount: Number(params.get('amount') || 0)
    };
  };

  const executeContinuationIfNeeded = async (sess: CheckoutSessionDetails) => {
    if (continuationRanRef.current) return;
    const meta = sess.metadata;
    if (!meta || !meta.returnAction || meta.returnAction === 'wallet_topup') {
      if (sess.orderId) setCompletedWorkstreamId(sess.orderId);
      return;
    }
    if (meta.actionCompleted) {
      if (meta.actionResult?.workstreamOrderId || meta.actionResult?.orderId || sess.orderId) {
        setCompletedWorkstreamId(meta.actionResult?.workstreamOrderId || meta.actionResult?.orderId || sess.orderId || null);
      }
      if (meta.actionResult?.summary) {
        setContinuationSummary(meta.actionResult.summary);
      }
      return;
    }

    continuationRanRef.current = true;
    setIsContinuingAction(true);
    const headers = buildHeaders();

    try {
      let actionResult: any = null;

      if (meta.returnAction === 'create_gig_order' && meta.gigOrderPayload) {
        setStatusMessage('Payment confirmed! Creating your funded escrow order...');
        const orderRes = await fetch('/api/orders', {
          method: 'POST',
          headers: {
            ...headers,
            'x-idempotency-key': `chk_order_${sess.sessionId}`
          },
          body: JSON.stringify(meta.gigOrderPayload)
        });
        const orderData = await orderRes.json().catch(() => ({}));
        if (!orderRes.ok) {
          throw new Error(
            orderData.error ||
              'Your wallet was credited, but automatic order placement encountered an issue. Your funds are safely in your FivePA Wallet.'
          );
        }
        const createdId = orderData.id;
        setCompletedWorkstreamId(createdId);
        const summary = `Order #${createdId} ("${orderData.title || meta.gigOrderPayload.title}") has been created and funded in Escrow!`;
        setContinuationSummary(summary);
        actionResult = { orderId: createdId, workstreamOrderId: createdId, summary };
      } else if (meta.returnAction === 'accept_proposal' && meta.proposalId) {
        setStatusMessage('Payment confirmed! Hiring freelancer and funding project escrow...');
        const propRes = await fetch(`/api/proposals/${meta.proposalId}/accept`, {
          method: 'POST',
          headers
        });
        const propData = await propRes.json().catch(() => ({}));
        if (!propRes.ok) {
          throw new Error(
            propData.error ||
              'Your wallet was credited, but accepting the proposal requires one more click on the Project page.'
          );
        }
        const wsId = propData.workstreamOrderId || propData.order?.id;
        if (wsId) setCompletedWorkstreamId(wsId);
        const summary = `Proposal accepted and ${formatUsd(sess.amount)} funded in project escrow!`;
        setContinuationSummary(summary);
        actionResult = { workstreamOrderId: wsId, proposalId: meta.proposalId, summary };
      } else if (meta.returnAction === 'accept_offer' && meta.offerId) {
        setStatusMessage('Payment confirmed! Completing WorkStream payment...');
        const offRes = await fetch(`/api/offers/${meta.offerId}/accept`, {
          method: 'POST',
          headers,
          body: JSON.stringify(meta.orderId ? { workstreamId: meta.orderId } : {})
        });
        const offData = await offRes.json().catch(() => ({}));
        if (!offRes.ok) {
          throw new Error(
            offData.error ||
              'Your wallet was credited, but completing the WorkStream offer requires one more click inside the WorkStream.'
          );
        }
        const wsId = offData.newOrder?.id || offData.order?.id || meta.orderId || sess.orderId;
        if (wsId) setCompletedWorkstreamId(wsId);
        const summary = `WorkStream ${offData.offer?.kind === 'invoice' ? 'invoice paid' : 'proposal/deposit funded in escrow'} (${formatUsd(offData.offer?.amount || sess.amount)})!`;
        setContinuationSummary(summary);
        actionResult = { workstreamOrderId: wsId, offerId: meta.offerId, summary };
      } else if (meta.returnAction === 'escrow_deposit' && meta.escrowPayload) {
        setStatusMessage('Payment confirmed! Funding order escrow...');
        const escRes = await fetch('/api/payments/escrow/deposit', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            orderId: meta.escrowPayload.orderId,
            amount: meta.escrowPayload.amount,
            title: meta.escrowPayload.title,
            fundSource: 'wallet'
          })
        });
        const escData = await escRes.json().catch(() => ({}));
        if (!escRes.ok) {
          throw new Error(
            escData.error || 'Your wallet was credited, but transferring funds into order escrow failed.'
          );
        }
        setCompletedWorkstreamId(meta.escrowPayload.orderId);
        const summary = `Deposited ${formatUsd(meta.escrowPayload.amount)} into Order Escrow!`;
        setContinuationSummary(summary);
        actionResult = { workstreamOrderId: meta.escrowPayload.orderId, summary };
      } else if (meta.returnAction === 'feature_gig' && meta.featureGigId) {
        setStatusMessage('Payment confirmed! Activating Featured Gig placement...');
        const featRes = await fetch(`/api/gigs/${meta.featureGigId}/feature`, {
          method: 'PATCH',
          headers: {
            ...headers,
            'Idempotency-Key': `chk_feat_${sess.sessionId}`,
            'X-Idempotency-Key': `chk_feat_${sess.sessionId}`
          },
          body: JSON.stringify({
            featured: true,
            idempotencyKey: `chk_feat_${sess.sessionId}`,
            operationId: `chk_feat_${sess.sessionId}`
          })
        });
        const featData = await featRes.json().catch(() => ({}));
        if (!featRes.ok) {
          throw new Error(
            featData.error || 'Your wallet was credited, but featuring the gig requires clicking Feature It again.'
          );
        }
        const summary = `Gig featured successfully!`;
        setContinuationSummary(summary);
        actionResult = { featureGigId: meta.featureGigId, summary };
      }

      if (actionResult) {
        await fetch(`/api/payments/checkout/${encodeURIComponent(sess.sessionId)}/complete-action`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ actionResult })
        }).catch(() => {});
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Follow-up order action could not be completed automatically.');
    } finally {
      setIsContinuingAction(false);
      if (onRefreshUser) {
        try {
          await onRefreshUser();
        } catch {}
      }
    }
  };

  useEffect(() => {
    const { sessionId, token } = getQueryParams();

    if (mode === 'cancel') {
      setPhase('cancelled');
      if (sessionId) {
        fetch(`/api/payments/checkout/${encodeURIComponent(sessionId)}/cancel`, {
          method: 'POST',
          headers: buildHeaders()
        })
          .then(r => r.json())
          .then(() => {
            return fetch(`/api/payments/checkout/${encodeURIComponent(sessionId)}`, {
              headers: buildHeaders()
            });
          })
          .then(r => (r.ok ? r.json() : null))
          .then(data => {
            if (data) setSession(data);
          })
          .catch(() => {});
      }
      return;
    }

    if (mode === 'pay') {
      setPhase('pending');
      if (sessionId) {
        fetch(`/api/payments/checkout/${encodeURIComponent(sessionId)}`, {
          headers: buildHeaders()
        })
          .then(r => (r.ok ? r.json() : null))
          .then(data => {
            if (data) setSession(data);
          })
          .catch(() => {});
      }
      return;
    }

    // mode === 'success'
    if (captureStartedRef.current) return;
    captureStartedRef.current = true;

    if (!sessionId && !token) {
      setPhase('failed');
      setErrorMessage('Missing checkout session identifier (`session_id` or PayPal `token`).');
      return;
    }

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollAttempts = 0;

    const runCaptureAndVerify = async () => {
      try {
        setStatusMessage('Capturing and verifying your PayPal payment...');
        const capRes = await fetch('/api/payments/paypal/capture', {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({
            sessionId: sessionId || undefined,
            paypalOrderId: token || undefined
          })
        });
        const capData = await capRes.json().catch(() => ({}));

        if (capRes.ok && (capData.status === 'completed' || capData.ok)) {
          setSession(capData);
          setPhase('completed');
          setStatusMessage('Payment captured and verified!');
          if (onRefreshUser) {
            try {
              await onRefreshUser();
            } catch {}
          }
          await executeContinuationIfNeeded(capData);
          return;
        }

        if (capData.status === 'pending') {
          setSession(capData);
          setPhase('pending');
          setStatusMessage('PayPal payment is pending confirmation. Checking status automatically...');
          if (sessionId) {
            pollTimer = setInterval(async () => {
              pollAttempts += 1;
              if (pollAttempts > 15) {
                if (pollTimer) clearInterval(pollTimer);
                return;
              }
              try {
                const pollRes = await fetch(`/api/payments/checkout/${encodeURIComponent(sessionId)}`, {
                  headers: buildHeaders()
                });
                if (!pollRes.ok) return;
                const pollData = await pollRes.json();
                setSession(pollData);
                if (pollData.status === 'completed') {
                  if (pollTimer) clearInterval(pollTimer);
                  setPhase('completed');
                  setStatusMessage('Payment confirmed via PayPal webhook!');
                  if (onRefreshUser) {
                    try {
                      await onRefreshUser();
                    } catch {}
                  }
                  await executeContinuationIfNeeded(pollData);
                } else if (pollData.status === 'failed' || pollData.status === 'cancelled') {
                  if (pollTimer) clearInterval(pollTimer);
                  setPhase('failed');
                  setErrorMessage(`PayPal reported payment status: ${pollData.status}.`);
                }
              } catch {}
            }, 2000);
          }
          return;
        }

        // Check session state directly in case webhook already completed it
        if (sessionId) {
          const checkRes = await fetch(`/api/payments/checkout/${encodeURIComponent(sessionId)}`, {
            headers: buildHeaders()
          });
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            setSession(checkData);
            if (checkData.status === 'completed') {
              setPhase('completed');
              setStatusMessage('Payment confirmed!');
              if (onRefreshUser) {
                try {
                  await onRefreshUser();
                } catch {}
              }
              await executeContinuationIfNeeded(checkData);
              return;
            }
          }
        }

        setPhase('failed');
        setErrorMessage(capData.error || 'Could not capture or verify payment with PayPal.');
      } catch (err: any) {
        setPhase('failed');
        setErrorMessage(err?.message || 'Network error while verifying your PayPal payment.');
      }
    };

    void runCaptureAndVerify();

    return () => {
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [mode, currentPath]);

  const handleSimulatedApproval = async () => {
    const { sessionId, token } = getQueryParams();
    if (!sessionId) return;
    setPhase('processing');
    setErrorMessage(null);
    try {
      const capRes = await fetch('/api/payments/paypal/capture', {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          sessionId,
          paypalOrderId: token || `sim_order_${sessionId}`
        })
      });
      const capData = await capRes.json().catch(() => ({}));
      if (!capRes.ok) {
        setPhase('failed');
        setErrorMessage(capData.error || 'Simulated capture failed.');
        return;
      }
      setSession(capData);
      setPhase('completed');
      setStatusMessage('Payment captured and verified!');
      if (onRefreshUser) {
        try {
          await onRefreshUser();
        } catch {}
      }
      await executeContinuationIfNeeded(capData);
    } catch (err: any) {
      setPhase('failed');
      setErrorMessage(err?.message || 'Failed to complete simulated checkout.');
    }
  };

  const { sessionId: querySessionId, token: queryToken, amount: queryAmount } = getQueryParams();
  const displayAmount = session?.amount ?? queryAmount;
  const returnPath = session?.metadata?.returnPath;

  return (
    <div className="max-w-2xl mx-auto py-12 px-4 sm:px-6">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Top Banner */}
        <div
          className={`px-8 py-7 border-b flex items-center gap-4 ${
            phase === 'completed'
              ? 'bg-emerald-50/70 border-emerald-100'
              : phase === 'cancelled'
              ? 'bg-amber-50/70 border-amber-100'
              : phase === 'failed'
              ? 'bg-rose-50/70 border-rose-100'
              : 'bg-slate-50 border-slate-100'
          }`}
        >
          {phase === 'completed' && (
            <div className="w-12 h-12 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-xs">
              <CheckCircle2 className="w-6 h-6" />
            </div>
          )}
          {(phase === 'processing' || phase === 'pending') && (
            <div className="w-12 h-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shrink-0">
              {mode === 'pay' ? <CreditCard className="w-6 h-6" /> : <RefreshCw className="w-6 h-6 animate-spin" />}
            </div>
          )}
          {phase === 'cancelled' && (
            <div className="w-12 h-12 rounded-2xl bg-amber-500 text-white flex items-center justify-center shrink-0">
              <Clock className="w-6 h-6" />
            </div>
          )}
          {phase === 'failed' && (
            <div className="w-12 h-12 rounded-2xl bg-rose-600 text-white flex items-center justify-center shrink-0">
              <XCircle className="w-6 h-6" />
            </div>
          )}

          <div>
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
              {mode === 'pay'
                ? 'Sandbox Payment Gateway'
                : session?.gateway
                ? `${session.gateway.toUpperCase()} Checkout`
                : 'PayPal Checkout'}
            </span>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight mt-0.5">
              {phase === 'completed'
                ? 'Payment Successful'
                : phase === 'cancelled'
                ? 'Payment Cancelled'
                : phase === 'failed'
                ? 'Payment Could Not Be Completed'
                : mode === 'pay'
                ? 'Approve Payment Checkout'
                : 'Finalizing Your Payment...'}
            </h1>
          </div>
        </div>

        {/* Body */}
        <div className="p-8 space-y-6">
          <p className="text-sm text-slate-600 leading-relaxed">{statusMessage}</p>

          {isContinuingAction && (
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center gap-3 text-xs font-bold text-emerald-900">
              <RefreshCw className="w-4 h-4 animate-spin text-emerald-600 shrink-0" />
              <span>Completing your order and locking funds in Escrow...</span>
            </div>
          )}

          {continuationSummary && (
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-emerald-900">
                  Order & Escrow Funded
                </div>
                <div className="text-sm font-medium text-emerald-800 mt-0.5">{continuationSummary}</div>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-rose-900">Payment Notice</div>
                <div className="text-xs text-rose-800 mt-1 leading-relaxed">{errorMessage}</div>
              </div>
            </div>
          )}

          {/* Receipt Breakdown Card */}
          <div className="rounded-2xl bg-slate-50 border border-slate-200/80 p-5 space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Checkout Session</span>
              <span className="font-mono font-semibold text-slate-800">
                {session?.sessionId || querySessionId || '—'}
              </span>
            </div>

            {(session?.paypalOrderId || queryToken) && (
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>PayPal Order ID</span>
                <span className="font-mono font-semibold text-slate-800">
                  {session?.paypalOrderId || queryToken}
                </span>
              </div>
            )}

            {session?.paypalCaptureId && (
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>PayPal Capture ID</span>
                <span className="font-mono font-semibold text-emerald-700">{session.paypalCaptureId}</span>
              </div>
            )}

            {session?.metadata?.title && (
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Item / Order</span>
                <span className="font-semibold text-slate-800 truncate max-w-[260px]">
                  {session.metadata.title}
                </span>
              </div>
            )}

            <div className="pt-3 border-t border-slate-200 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                {phase === 'completed' ? 'Amount Paid (USD)' : 'Checkout Amount (USD)'}
              </span>
              <span className="text-lg font-extrabold text-slate-900">
                {displayAmount > 0 ? formatUsd(displayAmount) : '—'}
              </span>
            </div>

            {typeof session?.walletBalance === 'number' && phase === 'completed' && !continuationSummary && (
              <div className="flex items-center justify-between text-xs text-emerald-700 font-semibold pt-1">
                <span>Available FivePA Wallet Balance</span>
                <span>{formatUsd(session.walletBalance)}</span>
              </div>
            )}
          </div>

          {/* Simulated Approval Controls when on /checkout/pay */}
          {mode === 'pay' && phase === 'pending' && (
            <div className="pt-2 flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={handleSimulatedApproval}
                className="flex-1 py-3.5 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-wider transition flex items-center justify-center gap-2 cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                Approve & Complete Sandbox Payment
              </button>
              <button
                type="button"
                onClick={() =>
                  navigate(`/checkout/cancel?session_id=${encodeURIComponent(session?.sessionId || querySessionId)}`)
                }
                className="py-3.5 px-5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 font-bold text-xs uppercase tracking-wider transition cursor-pointer"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Action Buttons */}
          {mode !== 'pay' && (
            <div className="pt-2 flex flex-wrap items-center gap-3">
              {completedWorkstreamId && (
                <button
                  type="button"
                  onClick={e => navigate(`/workstream/${completedWorkstreamId}`, e)}
                  className="px-6 py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-wider transition flex items-center gap-2 shadow-xs cursor-pointer"
                >
                  <span>Open WorkStream</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}

              {returnPath && !completedWorkstreamId && (
                <button
                  type="button"
                  onClick={e => navigate(returnPath, e)}
                  className="px-6 py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-wider transition flex items-center gap-2 shadow-xs cursor-pointer"
                >
                  <span>Return to Previous Page</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}

              <button
                type="button"
                onClick={e => navigate('/payments', e)}
                className={`px-5 py-3.5 rounded-xl font-bold text-xs uppercase tracking-wider transition flex items-center gap-2 cursor-pointer ${
                  completedWorkstreamId || returnPath
                    ? 'border border-slate-200 text-slate-700 hover:bg-slate-50'
                    : 'bg-slate-900 hover:bg-slate-800 text-white'
                }`}
              >
                <Wallet className="w-4 h-4" />
                <span>Go to Wallet & Payments</span>
              </button>

              <button
                type="button"
                onClick={e => navigate('/gigs', e)}
                className="px-5 py-3.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 font-bold text-xs uppercase tracking-wider transition flex items-center gap-1.5 cursor-pointer"
              >
                <span>Browse Marketplace</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
