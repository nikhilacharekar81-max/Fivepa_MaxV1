import React from 'react';
import { Sparkles } from 'lucide-react';

interface ForgotPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  forgotStep: 'request' | 'verify' | 'reset';
  setForgotStep: (step: 'request' | 'verify' | 'reset') => void;
  forgotQuery: string;
  setForgotQuery: (val: string) => void;
  forgotCode: string;
  setForgotCode: (val: string) => void;
  mockForgotCodeDisplay: string | null;
  newPassword: string;
  setNewPassword: (val: string) => void;
  confirmNewPassword: string;
  setConfirmNewPassword: (val: string) => void;
  handleForgotRequest: (e: React.FormEvent) => void;
  handleForgotVerify: (e: React.FormEvent) => void;
  handleForgotReset: (e: React.FormEvent) => void;
  setForgotCodeEmpty: () => void;
}

export const ForgotPasswordModal: React.FC<ForgotPasswordModalProps> = ({
  isOpen,
  onClose,
  forgotStep,
  setForgotStep,
  forgotQuery,
  setForgotQuery,
  forgotCode,
  setForgotCode,
  mockForgotCodeDisplay,
  newPassword,
  setNewPassword,
  confirmNewPassword,
  setConfirmNewPassword,
  handleForgotRequest,
  handleForgotVerify,
  handleForgotReset,
  setForgotCodeEmpty
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-slate-200 relative">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-fiverr-dark">Forgot Password</h2>
            <p className="text-xs text-fiverr-muted">Reset password via Email or SMS</p>
          </div>
          <button 
            onClick={() => {
              onClose();
              setForgotStep('request');
              setForgotCode('');
              setNewPassword('');
              setConfirmNewPassword('');
            }} 
            className="text-slate-400 hover:text-fiverr-dark p-1.5 rounded-xl hover:bg-slate-100 transition cursor-pointer text-xs font-bold"
          >
            ✕ Close
          </button>
        </div>
        {forgotStep === 'request' && (
          <form onSubmit={handleForgotRequest} className="space-y-4">
            <div>
              <label className="text-xs font-bold text-fiverr-dark block mb-1">Registered Email or Mobile Number</label>
              <input 
                type="text" 
                placeholder="user@example.com or +1234567890" 
                value={forgotQuery} 
                onChange={(e) => setForgotQuery(e.target.value)} 
                required 
                className="w-full px-4 py-2.5 border rounded-xl text-sm" 
              />
            </div>
            <button type="submit" className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-sm transition cursor-pointer">
              Send Recovery Code
            </button>
          </form>
        )}
        {forgotStep === 'verify' && (
          <form onSubmit={handleForgotVerify} className="space-y-4">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 space-y-1">
              <p className="font-semibold">Enter the 6-digit recovery OTP code sent to {forgotQuery}.</p>
              {mockForgotCodeDisplay && (
                <div className="p-2.5 bg-amber-50 border border-amber-300 rounded-xl text-amber-900 flex items-center justify-between mt-2">
                  <span className="font-bold uppercase tracking-wider text-[10px] flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    <span>TEST MODE - code: {mockForgotCodeDisplay}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setForgotCode(mockForgotCodeDisplay)}
                    className="px-2 py-0.5 bg-amber-600 hover:bg-amber-700 text-white font-bold text-[10px] rounded transition cursor-pointer shrink-0"
                  >
                    Fill code
                  </button>
                </div>
              )}
            </div>
            <div>
              <label className="text-xs font-bold text-fiverr-dark block mb-1">6-Digit Recovery OTP</label>
              <input 
                type="text" 
                maxLength={6} 
                placeholder="123456" 
                value={forgotCode} 
                onChange={(e) => setForgotCode(e.target.value)} 
                required 
                className="w-full px-4 py-3 border rounded-xl text-center text-lg font-mono font-bold tracking-widest text-fiverr-dark" 
              />
            </div>
            <button type="submit" className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-sm transition cursor-pointer">
              Verify Recovery Code
            </button>
          </form>
        )}
        {forgotStep === 'reset' && (
          <form onSubmit={handleForgotReset} className="space-y-4">
            <div>
              <label className="text-xs font-bold text-fiverr-dark block mb-1">New Password (min 6 characters)</label>
              <input 
                type="password" 
                minLength={6}
                placeholder="At least 6 characters" 
                value={newPassword} 
                onChange={(e) => setNewPassword(e.target.value)} 
                required 
                className="w-full px-4 py-2.5 border rounded-xl text-sm" 
              />
            </div>
            <div>
              <label className="text-xs font-bold text-fiverr-dark block mb-1">Confirm New Password</label>
              <input 
                type="password" 
                minLength={6}
                placeholder="Confirm new password" 
                value={confirmNewPassword} 
                onChange={(e) => setConfirmNewPassword(e.target.value)} 
                required 
                className="w-full px-4 py-2.5 border rounded-xl text-sm" 
              />
            </div>
            <button type="submit" className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm transition cursor-pointer">
              Save New Password & Proceed to Login
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
