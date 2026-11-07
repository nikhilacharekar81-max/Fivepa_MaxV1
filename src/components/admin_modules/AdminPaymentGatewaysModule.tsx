import React, { useState, useEffect } from 'react';
import { CreditCard, CheckCircle2, AlertTriangle, RefreshCw, Key, Copy, Globe, ShieldAlert, Radio } from 'lucide-react';

interface GatewayConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  webhookId: string;
  primary: boolean;
}

interface EnvironmentGateways {
  paypal: GatewayConfig;
  stripe: GatewayConfig;
  razorpay: GatewayConfig;
}

interface PaymentGatewaysState {
  production: EnvironmentGateways;
  sandbox: EnvironmentGateways;
  activePayPalEnvironment?: 'sandbox' | 'production';
  connectionTestStatus?: Record<string, {
    status: 'untested' | 'verified' | 'failed';
    lastTestedAt?: string;
    lastSuccessAt?: string;
    message?: string;
  }>;
}

export const AdminPaymentGatewaysModule: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'production' | 'sandbox'>('sandbox');
  const [activePayPalEnv, setActivePayPalEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [gateways, setGateways] = useState<PaymentGatewaysState | null>(null);
  const [testStatuses, setTestStatuses] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [editingGateway, setEditingGateway] = useState<'paypal' | 'stripe' | 'razorpay' | null>(null);
  const [editForm, setEditForm] = useState<GatewayConfig>({ enabled: false, clientId: '', clientSecret: '', webhookId: '', primary: false });
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState<boolean>(false);
  const [switchingEnv, setSwitchingEnv] = useState<boolean>(false);
  const [showLiveConfirmModal, setShowLiveConfirmModal] = useState<boolean>(false);
  const [copiedWebhook, setCopiedWebhook] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchGateways = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/payment-gateways');
      const data = await res.json();
      if (data.success && data.gateways) {
        setGateways(data.gateways);
        if (data.activePayPalEnvironment) {
          setActivePayPalEnv(data.activePayPalEnvironment);
        }
        if (data.connectionTestStatus) {
          setTestStatuses(data.connectionTestStatus);
        }
      }
    } catch (err) {
      console.error('Failed to load payment gateways:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGateways();
  }, []);

  const startEditing = (gwName: 'paypal' | 'stripe' | 'razorpay', config: GatewayConfig) => {
    setEditingGateway(gwName);
    setEditForm({ ...config });
    setTestResult(null);
    setError(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingGateway) return;

    if (activeTab === 'production') {
      const confirmMsg = `CONFIRMATION: You are modifying LIVE PRODUCTION gateway settings for ${editingGateway.toUpperCase()}. Are you sure?`;
      if (!window.confirm(confirmMsg)) return;
    }

    try {
      setError(null);
      setSuccessMsg(null);
      const res = await fetch(`/api/admin/payment-gateways/${activeTab}/${editingGateway}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm)
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to update gateway configuration');
      }

      setGateways(prev => prev ? ({
        ...prev,
        [activeTab]: data.environmentGateways
      }) : prev);

      setSuccessMsg(`${editingGateway.toUpperCase()} (${activeTab.toUpperCase()}) updated successfully.`);
      setEditingGateway(null);
    } catch (err: any) {
      setError(err.message || 'Failed to update gateway.');
    }
  };

  const handleTestConnection = async (gwName: 'paypal' | 'stripe' | 'razorpay') => {
    try {
      setTesting(true);
      setTestResult(null);
      const res = await fetch(`/api/admin/payment-gateways/${activeTab}/${gwName}/test`, {
        method: 'POST'
      });
      const data = await res.json();
      setTestResult({ success: data.success, message: data.message });
      await fetchGateways();
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Test connection failed.' });
    } finally {
      setTesting(false);
    }
  };

  const handleSwitchPayPalEnv = async (targetEnv: 'sandbox' | 'production', confirmed = false) => {
    if (targetEnv === 'production' && !confirmed) {
      setShowLiveConfirmModal(true);
      return;
    }

    try {
      setSwitchingEnv(true);
      setError(null);
      setSuccessMsg(null);

      const res = await fetch('/api/admin/payment-gateways/paypal/environment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: targetEnv, confirmed: true })
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to switch PayPal environment.');
      }

      setActivePayPalEnv(data.activePayPalEnvironment);
      setSuccessMsg(`Active PayPal environment switched to ${targetEnv.toUpperCase()}.`);
      setShowLiveConfirmModal(false);
      await fetchGateways();
    } catch (err: any) {
      setError(err.message || 'Failed to switch PayPal environment.');
      setShowLiveConfirmModal(false);
    } finally {
      setSwitchingEnv(false);
    }
  };

  const webhookUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/payments/webhook?gateway=paypal`;

  const copyWebhookUrl = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhook(true);
    setTimeout(() => setCopiedWebhook(false), 2000);
  };

  if (loading && !gateways) {
    return (
      <div className="p-8 text-center text-slate-400 text-xs font-semibold">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-emerald-600" />
        Loading Payment Gateways configuration...
      </div>
    );
  }

  const envState = gateways ? gateways[activeTab] : null;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-emerald-600" />
            Payment Gateways & PayPal Environment Switcher
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Manage PayPal Sandbox / Live mode switching, API credentials, webhooks, and live connectivity handshakes.
          </p>
        </div>

        <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-200">
          <button
            onClick={() => { setActiveTab('sandbox'); setEditingGateway(null); }}
            className={`px-4 py-2 text-xs font-bold rounded-xl transition cursor-pointer ${
              activeTab === 'sandbox' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            Sandbox / Testing Config
          </button>
          <button
            onClick={() => { setActiveTab('production'); setEditingGateway(null); }}
            className={`px-4 py-2 text-xs font-bold rounded-xl transition cursor-pointer ${
              activeTab === 'production' ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            Live / Production Config
          </button>
        </div>
      </div>

      {/* Active PayPal Mode Banner */}
      <div className={`p-6 border rounded-3xl shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
        activePayPalEnv === 'production'
          ? 'bg-slate-900 text-white border-slate-800'
          : 'bg-amber-500/10 border-amber-200 text-amber-950'
      }`}>
        <div className="flex items-center gap-3.5">
          <div className={`p-3 rounded-2xl ${
            activePayPalEnv === 'production' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-700'
          }`}>
            <Radio className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase font-bold tracking-wider opacity-75">Active Platform PayPal Mode:</span>
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-black uppercase tracking-wider ${
                activePayPalEnv === 'production'
                  ? 'bg-emerald-500 text-white'
                  : 'bg-amber-500 text-white'
              }`}>
                {activePayPalEnv === 'production' ? 'PAYPAL LIVE (REAL MONEY)' : 'PAYPAL SANDBOX (TESTING)'}
              </span>
            </div>
            <p className="text-xs opacity-80 mt-1">
              {activePayPalEnv === 'production'
                ? 'All new buyer order payments and wallet top-ups execute through real PayPal Live endpoints.'
                : 'All new buyer order payments and wallet top-ups execute through PayPal Sandbox Developer accounts.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {activePayPalEnv === 'sandbox' ? (
            <button
              onClick={() => handleSwitchPayPalEnv('production')}
              disabled={switchingEnv}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs transition cursor-pointer disabled:opacity-50 flex items-center gap-2"
            >
              <ShieldAlert className="w-4 h-4" />
              Switch to PayPal Live
            </button>
          ) : (
            <button
              onClick={() => handleSwitchPayPalEnv('sandbox', true)}
              disabled={switchingEnv}
              className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-xl shadow-xs transition cursor-pointer disabled:opacity-50 flex items-center gap-2"
            >
              <Radio className="w-4 h-4" />
              Switch to PayPal Sandbox
            </button>
          )}
        </div>
      </div>

      {/* Notifications */}
      {successMsg && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-xs text-emerald-800 font-semibold flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800 font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Webhook Instructions Component */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-600" />
            PayPal Webhook Endpoint Helper
          </h3>
          <span className="text-[11px] font-semibold text-slate-400">
            For {activeTab.toUpperCase()} Webhooks
          </span>
        </div>
        <p className="text-xs text-slate-500">
          Configure this URL in your PayPal Developer Dashboard under App → Webhooks (listen to <code className="bg-slate-100 px-1 py-0.5 rounded text-emerald-700 font-mono">PAYMENT.CAPTURE.COMPLETED</code> and <code className="bg-slate-100 px-1 py-0.5 rounded text-emerald-700 font-mono">CHECKOUT.ORDER.APPROVED</code>):
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={webhookUrl}
            className="flex-1 px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono text-slate-800 select-all"
          />
          <button
            onClick={copyWebhookUrl}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition cursor-pointer"
          >
            {copiedWebhook ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            {copiedWebhook ? 'Copied!' : 'Copy Webhook URL'}
          </button>
        </div>
      </div>

      {/* Gateways Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {(['paypal', 'stripe', 'razorpay'] as const).map(gwKey => {
          const cfg = envState ? envState[gwKey] : null;
          const isConfigured = Boolean(cfg?.clientId && cfg?.clientSecret);
          const testStatus = testStatuses[`${activeTab}_${gwKey}`];

          return (
            <div key={gwKey} className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs flex flex-col justify-between space-y-5">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2.5 bg-slate-100 rounded-2xl text-slate-900 font-bold uppercase text-xs">
                      {gwKey.charAt(0).toUpperCase() + gwKey.slice(1)}
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 capitalize">{gwKey}</h3>
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold mt-0.5 ${
                        cfg?.enabled ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {cfg?.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                  </div>
                  {cfg?.primary && (
                    <span className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-[10px] font-bold uppercase tracking-wider">
                      Primary
                    </span>
                  )}
                </div>

                <div className="space-y-2 text-xs text-slate-600 border-t border-slate-100 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Credentials:</span>
                    <span className={`font-bold ${isConfigured ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {isConfigured ? 'Saved' : 'Not Configured'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Client ID:</span>
                    <span className="font-mono text-[11px] text-slate-800 truncate max-w-[140px]">
                      {cfg?.clientId ? cfg.clientId : '—'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Webhook ID:</span>
                    <span className={`font-bold ${cfg?.webhookId ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {cfg?.webhookId ? cfg.webhookId : '○ Missing'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-slate-400">OAuth Handshake:</span>
                    {testStatus?.status === 'verified' ? (
                      <span className="font-bold text-emerald-600 flex items-center gap-1 text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Connection Verified
                      </span>
                    ) : testStatus?.status === 'failed' ? (
                      <span className="font-bold text-rose-600 flex items-center gap-1 text-[11px]">
                        <AlertTriangle className="w-3.5 h-3.5" /> Connection Failed
                      </span>
                    ) : (
                      <span className="text-slate-400 text-[11px]">Untested</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2 pt-3 border-t border-slate-100">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => startEditing(gwKey, cfg || { enabled: false, clientId: '', clientSecret: '', webhookId: '', primary: false })}
                    className="flex-1 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-xs transition cursor-pointer text-center shadow-xs"
                  >
                    Configure
                  </button>
                  <button
                    onClick={() => handleTestConnection(gwKey)}
                    disabled={testing}
                    className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition cursor-pointer disabled:opacity-50"
                  >
                    Test
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {testResult && (
        <div className={`p-4 rounded-2xl border text-xs font-semibold flex items-center gap-2 ${
          testResult.success ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-amber-50 text-amber-800 border-amber-200'
        }`}>
          {testResult.success ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />}
          <span>{testResult.message}</span>
        </div>
      )}

      {/* Confirmation Modal for Live Mode */}
      {showLiveConfirmModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl space-y-6">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-3 bg-rose-50 rounded-2xl">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-slate-900">Activate PayPal Live Mode?</h3>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              <strong>WARNING:</strong> You are about to switch the platform's active PayPal gateway to <strong>PAYPAL LIVE</strong>.
              All real customer purchases will charge actual money through live PayPal accounts.
            </p>

            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs text-slate-700 space-y-1">
              <p>• Ensures live Client ID and Client Secret are saved on server.</p>
              <p>• Session isolation ensures existing sandbox sessions continue testing without disruption.</p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowLiveConfirmModal(false)}
                className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleSwitchPayPalEnv('production', true)}
                disabled={switchingEnv}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs shadow-xs transition cursor-pointer disabled:opacity-50"
              >
                Confirm & Activate Live Mode
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Configuration Modal */}
      {editingGateway && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 max-w-lg w-full shadow-2xl space-y-6 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-slate-900 text-white rounded-xl">
                  <Key className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 capitalize">Configure {editingGateway} ({activeTab.toUpperCase()})</h3>
                  <p className="text-[11px] text-slate-400">AES-256-GCM encrypted credential storage</p>
                </div>
              </div>
              <button
                onClick={() => setEditingGateway(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4 text-xs">
              <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200 rounded-2xl">
                <div>
                  <span className="font-bold text-slate-900 block">Enable Gateway</span>
                  <span className="text-[11px] text-slate-500">Allow {editingGateway} checkout in {activeTab}</span>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editForm.enabled}
                    onChange={(e) => setEditForm({ ...editForm, enabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                </label>
              </div>

              <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200 rounded-2xl">
                <div>
                  <span className="font-bold text-slate-900 block">Primary Gateway</span>
                  <span className="text-[11px] text-slate-500">Designate as default checkout provider for {activeTab}</span>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editForm.primary}
                    onChange={(e) => setEditForm({ ...editForm, primary: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                </label>
              </div>

              <div>
                <label className="block text-slate-700 font-bold uppercase tracking-wider text-[10px] mb-1.5">
                  Client ID / API Key
                </label>
                <input
                  type="text"
                  value={editForm.clientId}
                  onChange={(e) => setEditForm({ ...editForm, clientId: e.target.value })}
                  placeholder={`Enter ${editingGateway} client ID...`}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:border-emerald-500 focus:bg-white font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold uppercase tracking-wider text-[10px] mb-1.5 flex items-center justify-between">
                  <span>Client Secret</span>
                  <span className="text-[10px] text-slate-400 font-normal">Stored AES-256-GCM encrypted</span>
                </label>
                <input
                  type="password"
                  value={editForm.clientSecret}
                  onChange={(e) => setEditForm({ ...editForm, clientSecret: e.target.value })}
                  placeholder="•••••••••••••••• (Leave unchanged to keep existing secret)"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:border-emerald-500 focus:bg-white font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold uppercase tracking-wider text-[10px] mb-1.5">
                  Webhook ID
                </label>
                <input
                  type="text"
                  value={editForm.webhookId}
                  onChange={(e) => setEditForm({ ...editForm, webhookId: e.target.value })}
                  placeholder="e.g. WH-8X921820..."
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:border-emerald-500 focus:bg-white font-mono"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setEditingGateway(null)}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-xs shadow-xs transition cursor-pointer"
                >
                  Save Configuration
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
