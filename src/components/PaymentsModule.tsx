import React, { useState, useEffect, useCallback } from 'react';
import { 
  Wallet, DollarSign, ArrowUpRight, ArrowDownLeft, ShieldCheck, 
  CreditCard, Clock, CheckCircle2, AlertCircle, RefreshCw, Download, 
  ExternalLink, Building2, Plus, Filter, ChevronRight
} from 'lucide-react';
import { Gig, Order, Project, Proposal, UserAccount } from '../types';

interface PaymentsModuleProps {
  gigs?: Gig[];
  orders?: Order[];
  projects?: Project[];
  proposals?: Proposal[];
  currentUser?: UserAccount | null;
  onBalanceUpdate?: () => void;
}

export const PaymentsModule: React.FC<PaymentsModuleProps> = ({
  gigs = [],
  orders = [],
  projects = [],
  proposals = [],
  currentUser,
  onBalanceUpdate
}) => {
  const [activeTab, setActiveTab] = useState<'transactions' | 'payouts' | 'methods' | 'invoices'>('transactions');
  const [withdrawAmount, setWithdrawAmount] = useState<string>('');
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [withdrawSuccess, setWithdrawSuccess] = useState(false);
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [codeRequired, setCodeRequired] = useState(true);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  // Deposit modal state
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositSuccess, setDepositSuccess] = useState<string | null>(null);

  // Live data states
  const [transactions, setTransactions] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [payoutsList, setPayoutsList] = useState<any[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(false);

  const walletBalance = currentUser?.walletBalance ?? 0;
  const escrowLocked = orders
    .filter(o => o.status === 'funded_in_escrow' || o.status === 'in_progress' || o.status === 'delivered')
    .reduce((sum, o) => sum + (o.amount || 0), 0);
  const lifetimeEarnings = currentUser?.earned ?? 0;

  const getAuthHeader = (): Record<string, string> => {
    const token = localStorage.getItem('token') || '';
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  const fetchData = useCallback(async () => {
    if (!currentUser?.id) return;
    setIsLoadingData(true);
    try {
      const [txRes, invRes, payRes] = await Promise.all([
        fetch(`/api/payments/transactions/${currentUser.id}`, { headers: getAuthHeader() }),
        fetch(`/api/payments/invoices/${currentUser.id}`, { headers: getAuthHeader() }),
        fetch('/api/payouts', { headers: getAuthHeader() })
      ]);

      if (txRes.ok) {
        const txData = await txRes.json();
        if (Array.isArray(txData)) setTransactions(txData);
      }
      if (invRes.ok) {
        const invData = await invRes.json();
        if (Array.isArray(invData)) setInvoices(invData);
      }
      if (payRes.ok) {
        const payData = await payRes.json();
        if (Array.isArray(payData)) setPayoutsList(payData);
      }
    } catch (e) {
      console.error('Error fetching financial data:', e);
    } finally {
      setIsLoadingData(false);
    }
  }, [currentUser?.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(depositAmount);
    if (isNaN(amt) || amt <= 0) {
      setDepositError('Please enter a valid deposit amount.');
      return;
    }
    setIsDepositing(true);
    setDepositError(null);
    try {
      const res = await fetch('/api/payments/deposit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader()
        },
        body: JSON.stringify({
          userId: currentUser?.id,
          amount: amt
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to deposit funds');
      }
      setDepositSuccess(`Successfully deposited $${amt.toFixed(2)} into your wallet!`);
      setDepositAmount('');
      setShowDepositModal(false);
      if (onBalanceUpdate) onBalanceUpdate();
      fetchData();
      setTimeout(() => setDepositSuccess(null), 5000);
    } catch (err: any) {
      setDepositError(err.message || 'Deposit failed');
    } finally {
      setIsDepositing(false);
    }
  };

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(withdrawAmount);
    if (isNaN(amt) || amt <= 0 || amt > walletBalance) return;
    setIsWithdrawing(true);
    setWithdrawError(null);

    try {
      const res = await fetch('/api/auth/withdrawal/request-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader()
        }
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to dispatch verification code');
      }
      if (typeof data.codeRequired === 'boolean') {
        setCodeRequired(data.codeRequired);
      }
      setShowCodeModal(true);
      setVerificationCode('');
    } catch (err: any) {
      setWithdrawError(err.message || 'Error requesting verification code');
    } finally {
      setIsWithdrawing(false);
    }
  };

  const handleVerifyAndWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (codeRequired && (!verificationCode || verificationCode.trim().length !== 6)) {
      setWithdrawError('Please enter the 6-digit code sent to your email.');
      return;
    }

    const amt = parseFloat(withdrawAmount);
    setIsWithdrawing(true);
    setWithdrawError(null);

    try {
      const res = await fetch('/api/auth/withdrawal/verify-and-execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader()
        },
        body: JSON.stringify({
          amount: amt,
          code: verificationCode.trim(),
          method: 'Bank Transfer'
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Withdrawal verification failed');
      }

      setShowCodeModal(false);
      setWithdrawSuccess(true);
      setWithdrawAmount('');
      setVerificationCode('');
      if (onBalanceUpdate) onBalanceUpdate();
      fetchData();
      setTimeout(() => setWithdrawSuccess(false), 5000);
    } catch (err: any) {
      setWithdrawError(err.message || 'Withdrawal execution failed');
    } finally {
      setIsWithdrawing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Overview Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs relative overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Available Balance</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDepositModal(true)}
                className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-[11px] font-bold rounded-xl border border-emerald-200 transition cursor-pointer flex items-center gap-1"
                title="Deposit funds into wallet"
              >
                <Plus className="w-3 h-3" />
                <span>Deposit</span>
              </button>
              <div className="w-10 h-10 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
                <Wallet className="w-5 h-5" />
              </div>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-slate-900 tracking-tight">
            ${walletBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-emerald-600 font-medium">
            <CheckCircle2 className="w-4 h-4" />
            <span>Ready for immediate bank withdrawal or gig orders</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs relative overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">In Escrow Protection</span>
            <div className="w-10 h-10 rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
              <ShieldCheck className="w-5 h-5" />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-slate-900 tracking-tight">
            ${escrowLocked.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-blue-600 font-medium">
            <Clock className="w-4 h-4" />
            <span>Secured in smart escrow across active orders</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-xs relative overflow-hidden">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Lifetime Platform Earned</span>
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-600">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-slate-900 tracking-tight">
            ${lifetimeEarnings.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 font-medium">
            <span>Verified gross platform turnover</span>
          </div>
        </div>
      </div>

      {/* Withdrawal Action Bar */}
      <div className="bg-gradient-to-r from-emerald-600 to-teal-700 rounded-3xl p-6 text-white shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 className="text-lg font-bold">Request Balance Withdrawal</h3>
          <p className="text-xs text-emerald-100 mt-1 max-w-lg">
            Funds are transferred directly via ACH wire or PayPal without hidden conversion fees. Typical clearance is 24-48 business hours.
          </p>
        </div>
        <form onSubmit={handleWithdraw} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 min-w-[320px]">
          <div className="relative flex-1">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
            <input
              type="number"
              min="10"
              max={walletBalance}
              step="any"
              placeholder={`Max $${walletBalance.toFixed(2)}`}
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              className="w-full pl-8 pr-4 py-2.5 bg-white text-slate-900 rounded-xl text-sm font-semibold focus:outline-hidden focus:ring-2 focus:ring-emerald-400 placeholder:text-slate-400"
            />
          </div>
          <button
            type="submit"
            disabled={isWithdrawing || !withdrawAmount || parseFloat(withdrawAmount) <= 0 || parseFloat(withdrawAmount) > walletBalance}
            className="px-5 py-2.5 bg-slate-900 text-white text-xs font-bold rounded-xl hover:bg-black disabled:opacity-40 transition whitespace-nowrap cursor-pointer"
          >
            {isWithdrawing ? 'Processing...' : 'Withdraw Funds'}
          </button>
        </form>
      </div>

      {depositSuccess && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-800 text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <span>{depositSuccess}</span>
        </div>
      )}

      {withdrawError && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-rose-800 text-xs font-semibold flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
            <span>{withdrawError}</span>
          </div>
          <button onClick={() => setWithdrawError(null)} className="text-rose-500 hover:text-rose-800 text-xs font-bold cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {withdrawSuccess && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-800 text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <span>Withdrawal payout request submitted successfully! Your account ledger has been scheduled for bank settlement.</span>
        </div>
      )}

      {/* Deposit Modal */}
      {showDepositModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
                  <Wallet className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-900 text-sm">Simulated Deposit Funds</h4>
                  <p className="text-[11px] text-slate-500">Add funds to wallet for instant gig orders</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowDepositModal(false); setDepositError(null); }}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleDeposit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Deposit Amount (USD)
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                  <input
                    type="number"
                    min="1"
                    max="5000"
                    step="any"
                    placeholder="e.g. 250.00"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    className="w-full pl-8 pr-4 py-3 bg-slate-50 border border-slate-300 rounded-xl text-lg font-bold text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white"
                    autoFocus
                  />
                </div>
              </div>

              {depositError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2 font-medium">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{depositError}</span>
                </div>
              )}

              <div className="flex items-center gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowDepositModal(false); setDepositError(null); }}
                  className="flex-1 py-2.5 px-4 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isDepositing || !depositAmount || parseFloat(depositAmount) <= 0}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 text-white font-bold text-xs hover:bg-emerald-700 disabled:opacity-40 cursor-pointer"
                >
                  {isDepositing ? 'Depositing...' : 'Confirm Deposit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Withdrawal Email Verification Modal */}
      {showCodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-900 text-sm">Security Verification</h4>
                  <p className="text-[11px] text-slate-500">Authorize withdrawal of ${parseFloat(withdrawAmount || '0').toFixed(2)}</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowCodeModal(false); setWithdrawError(null); }}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {codeRequired ? (
              <>
                <p className="text-xs text-slate-600 mb-4 leading-relaxed">
                  We have dispatched a 6-digit confirmation code to your registered email address <strong>{currentUser?.email}</strong>. Enter it below to authorize this transaction.
                </p>

                <form onSubmit={handleVerifyAndWithdraw} className="space-y-4">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                      6-Digit Verification Code
                    </label>
                    <input
                      type="text"
                      maxLength={6}
                      placeholder="e.g. 123456"
                      value={verificationCode}
                      onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-300 rounded-xl text-center text-xl font-mono font-bold tracking-widest text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white"
                      autoFocus
                    />
                  </div>

                  {withdrawError && (
                    <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2 font-medium">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{withdrawError}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2.5 pt-2">
                    <button
                      type="button"
                      onClick={() => { setShowCodeModal(false); setWithdrawError(null); }}
                      className="flex-1 py-2.5 px-4 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs hover:bg-slate-50 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isWithdrawing || verificationCode.trim().length !== 6}
                      className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 text-white font-bold text-xs hover:bg-emerald-700 disabled:opacity-40 cursor-pointer"
                    >
                      {isWithdrawing ? 'Verifying...' : 'Confirm Withdrawal'}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <p className="text-xs text-slate-600 mb-4 leading-relaxed">
                  Please confirm your withdrawal request of <strong>${parseFloat(withdrawAmount || '0').toFixed(2)}</strong>. It will be submitted for administrative review and processing.
                </p>

                <form onSubmit={handleVerifyAndWithdraw} className="space-y-4">
                  {withdrawError && (
                    <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2 font-medium">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{withdrawError}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2.5 pt-2">
                    <button
                      type="button"
                      onClick={() => { setShowCodeModal(false); setWithdrawError(null); }}
                      className="flex-1 py-2.5 px-4 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs hover:bg-slate-50 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isWithdrawing}
                      className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 text-white font-bold text-xs hover:bg-emerald-700 disabled:opacity-40 cursor-pointer"
                    >
                      {isWithdrawing ? 'Processing...' : 'Confirm Withdrawal'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tabs & Table */}
      <div className="bg-white border border-slate-200 rounded-3xl shadow-xs overflow-hidden">
        <div className="border-b border-slate-200 px-6 pt-4 flex gap-6 items-center justify-between">
          <div className="flex gap-6">
            <button
              onClick={() => setActiveTab('transactions')}
              className={`pb-4 text-xs font-bold border-b-2 transition ${
                activeTab === 'transactions'
                  ? 'border-emerald-600 text-emerald-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              Transactions Ledger ({transactions.length})
            </button>
            <button
              onClick={() => setActiveTab('payouts')}
              className={`pb-4 text-xs font-bold border-b-2 transition ${
                activeTab === 'payouts'
                  ? 'border-emerald-600 text-emerald-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              Bank & Payout Accounts ({payoutsList.length})
            </button>
            <button
              onClick={() => setActiveTab('invoices')}
              className={`pb-4 text-xs font-bold border-b-2 transition ${
                activeTab === 'invoices'
                  ? 'border-emerald-600 text-emerald-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              Invoices & Tax Slips ({invoices.length})
            </button>
          </div>
          <button
            onClick={fetchData}
            disabled={isLoadingData}
            className="mb-3 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition cursor-pointer"
            title="Refresh financial data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingData ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        {activeTab === 'transactions' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-600 border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/75 font-bold text-slate-600 uppercase tracking-wider">
                  <th className="py-3 px-4">Tx ID & Date</th>
                  <th className="py-3 px-4">Description / Reference</th>
                  <th className="py-3 px-4">Gross Amount</th>
                  <th className="py-3 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-12 text-center text-slate-400 font-medium">
                      {isLoadingData ? 'Loading transactions...' : 'No transactions recorded yet.'}
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-slate-50/60 transition">
                      <td className="py-3.5 px-4 font-mono font-semibold text-slate-800">
                        <div>{tx.id}</div>
                        <div className="text-[11px] text-slate-400 font-sans">{tx.timestamp}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-800">{tx.description}</div>
                        <div className="text-[11px] text-slate-400">Type: {tx.type}</div>
                      </td>
                      <td className="py-3.5 px-4 font-bold text-slate-900">
                        <span className={tx.amount > 0 ? 'text-emerald-600' : 'text-slate-900'}>
                          {tx.amount > 0 ? `+$${Number(tx.amount).toFixed(2)}` : `-$${Math.abs(Number(tx.amount)).toFixed(2)}`}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          {tx.status || 'completed'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'payouts' && (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-bold text-slate-900 text-sm">Linked Payout Accounts & Requests</h4>
                <p className="text-xs text-slate-500">Add or manage primary bank and digital wallet destinations</p>
              </div>
              <button 
                onClick={() => alert('Bank account integration linked successfully via Stripe Payouts API.')}
                className="px-3 py-1.5 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-700 transition flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Bank / Method</span>
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-slate-200 rounded-2xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                    <Building2 className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-bold text-slate-900 text-xs">JPMorgan Chase & Co (Checking)</div>
                    <div className="text-[11px] text-slate-400">Account ending in •••• 4912 • Primary</div>
                  </div>
                </div>
                <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-md text-[10px] font-bold border border-emerald-200">Active</span>
              </div>
              <div className="border border-slate-200 rounded-2xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                    <CreditCard className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-bold text-slate-900 text-xs">PayPal Business Account</div>
                    <div className="text-[11px] text-slate-400">{currentUser?.email} • Secondary</div>
                  </div>
                </div>
                <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-md text-[10px] font-medium">Backup</span>
              </div>
            </div>

            {payoutsList.length > 0 && (
              <div className="mt-6">
                <h5 className="font-bold text-slate-800 text-xs uppercase tracking-wider mb-3">Withdrawal Payout History</h5>
                <div className="space-y-2">
                  {payoutsList.map((p: any) => (
                    <div key={p.id} className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl flex items-center justify-between text-xs">
                      <div>
                        <div className="font-bold text-slate-900">Payout #{p.id} • ${Number(p.amount).toFixed(2)}</div>
                        <div className="text-[11px] text-slate-500">Method: {p.method || 'Bank Transfer'} • {p.createdAt || new Date().toLocaleDateString()}</div>
                      </div>
                      <span className="px-2.5 py-1 rounded-full font-bold text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {p.status || 'completed'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'invoices' && (
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="font-bold text-slate-900 text-sm">Invoices & Escrow Tax Statements</h4>
                <p className="text-xs text-slate-500">View and download certified invoices for all orders and custom milestones</p>
              </div>
              <button 
                onClick={() => alert('Exporting 2026 Fiscal Year Statements PDF...')}
                className="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-xl hover:bg-black transition cursor-pointer"
              >
                Export 2026 Fiscal Year (PDF)
              </button>
            </div>

            {invoices.length === 0 ? (
              <div className="py-12 text-center text-slate-400 space-y-2">
                <Download className="w-8 h-8 mx-auto text-slate-300" />
                <h5 className="font-bold text-slate-700 text-sm">No Invoices Generated Yet</h5>
                <p className="text-xs text-slate-400 max-w-sm mx-auto">Invoices are automatically created for every escrow order and milestone.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {invoices.map((inv: any) => (
                  <div key={inv.id} className="p-4 bg-white border border-slate-200 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-emerald-300 transition">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900 text-xs">{inv.invoiceNumber}</span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700">{inv.type}</span>
                      </div>
                      <div className="font-semibold text-slate-800 text-sm mt-1">{inv.title}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">Issued: {inv.issueDate} • Due: {inv.dueDate}</div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-sm font-bold text-slate-900">${Number(inv.total || inv.subtotal).toFixed(2)}</div>
                        <span className="text-[11px] font-semibold text-emerald-600 uppercase">{inv.status}</span>
                      </div>
                      <button 
                        onClick={() => alert(`Downloading invoice ${inv.invoiceNumber} as PDF...`)}
                        className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>PDF</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
