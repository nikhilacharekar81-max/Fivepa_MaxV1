import React from 'react';
import { MapPin } from 'lucide-react';
import { Order } from '../../types';
import { DEFAULT_AVATAR } from '../../constants';
import { formatCurrency } from '../../utils/formatters';

export interface FreelancerProjectActivityItem {
  id: string;
  title: string;
  buyerName: string;
  buyerAvatar: string;
  awardedDate: string;
  proposalAmount: number;
  earningsAmount: number;
  amountLabel?: string;
  location: string;
  refNumber: string;
  statusCategory: 'pending_proposals' | 'in_progress' | 'completed' | 'cancelled';
  order?: Order;
  workstreamOrderId?: string;
  projectId?: string;
}

interface UserFreelanceProjectsListProps {
  items?: FreelancerProjectActivityItem[];
  orders?: Order[];
  freelanceSubFilter: string;
  onOpenWorkstream: (orderId: string, order?: Order, projectId?: string) => void;
}

export const UserFreelanceProjectsList: React.FC<UserFreelanceProjectsListProps> = ({
  items,
  orders = [],
  freelanceSubFilter,
  onOpenWorkstream
}) => {
  const resolvedItems: FreelancerProjectActivityItem[] = items ?? orders.map(ord => {
    const isOrdCompleted = ord.status === 'completed';
    const isOrdCancelled = ord.status === 'cancelled' || (ord.status as string) === 'refunded';
    const netEarned =
      typeof (ord as any).freelancerNetEarned === 'number' && Number.isFinite((ord as any).freelancerNetEarned)
        ? Math.max(0, (ord as any).freelancerNetEarned)
        : 0;
    const hasRecognizedEarnings = netEarned > 0;
    const confirmedEscrowVal =
      typeof (ord as any).inEscrow === 'number' && Number.isFinite((ord as any).inEscrow)
        ? Math.max(0, (ord as any).inEscrow)
        : 0;
    const contractVal = Number(ord.amount || 0);

    let earningsAmount = contractVal;
    let amountLabel = 'CONTRACT VALUE';
    if (hasRecognizedEarnings) {
      earningsAmount = netEarned;
      amountLabel = 'EARNINGS';
    } else if (isOrdCancelled) {
      earningsAmount = 0;
      amountLabel = 'CANCELLED';
    } else if (confirmedEscrowVal > 0) {
      earningsAmount = confirmedEscrowVal;
      amountLabel = 'IN ESCROW';
    }

    return {
      id: ord.id,
      title: ord.title,
      buyerName: (ord as any).buyerName || ord.buyerUsername || 'Client',
      buyerAvatar: (ord as any).buyerAvatar || DEFAULT_AVATAR,
      awardedDate: ord.createdAt,
      proposalAmount: contractVal,
      earningsAmount,
      amountLabel,
      location: 'Remote',
      refNumber: ord.id.replace(/\D/g, '').slice(0, 7) || ord.id.replace(/^ord_/, '').slice(0, 7).toUpperCase(),
      statusCategory: isOrdCompleted || hasRecognizedEarnings ? 'completed' : isOrdCancelled ? 'cancelled' : 'in_progress',
      order: ord,
      workstreamOrderId: ord.id,
      projectId: ord.projectId
    };
  });

  if (resolvedItems.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500 text-sm space-y-1.5 bg-white font-sans">
        <p className="font-bold text-slate-900 text-base">No projects found under &ldquo;{freelanceSubFilter}&rdquo;.</p>
        <p className="text-slate-500 text-sm">Projects you are working on, completed projects, and proposals will appear here.</p>
      </div>
    );
  }

  return (
    <div className="bg-white divide-y divide-slate-200/80 font-sans">
      {resolvedItems.map(item => {
        const hasRecognizedEarnings = item.amountLabel === 'EARNINGS' && Number(item.earningsAmount) > 0;
        const isPendingProposal = item.statusCategory === 'pending_proposals';
        const isCancelledOrder =
          item.statusCategory === 'cancelled' ||
          item.order?.status === 'cancelled' ||
          (item.order?.status as string) === 'refunded';
        const isCompleted =
          !isCancelledOrder && (item.statusCategory === 'completed' || item.order?.status === 'completed');
        const targetOrderId = item.workstreamOrderId || item.order?.id || '';
        const rightSideAmount = isPendingProposal ? item.proposalAmount : item.earningsAmount;
        const rightSideLabel = hasRecognizedEarnings
          ? 'EARNINGS'
          : item.amountLabel && item.amountLabel !== 'EARNINGS'
            ? item.amountLabel
            : isPendingProposal
              ? 'PROPOSAL'
              : isCancelledOrder
                ? 'CANCELLED'
                : 'CONTRACT VALUE';

        return (
          <div
            key={item.id}
            className="py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition-colors"
          >
            {/* Left Side: Project Title + Metadata Row */}
            <div className="space-y-3 flex-1 min-w-0">
              <button
                type="button"
                onClick={() => onOpenWorkstream(targetOrderId, item.order, item.projectId)}
                className="text-left text-base font-bold text-slate-900 hover:text-emerald-600 transition-colors leading-snug cursor-pointer block"
              >
                {item.title}
              </button>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-slate-500">
                <div className="inline-flex items-center gap-2 text-slate-800 font-semibold">
                  <img
                    src={item.buyerAvatar || DEFAULT_AVATAR}
                    alt={item.buyerName}
                    className="w-6 h-6 rounded-full object-cover border border-slate-200 shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = DEFAULT_AVATAR;
                    }}
                  />
                  <span>{item.buyerName}</span>
                </div>

                <span>
                  {isPendingProposal ? 'Proposed:' : 'Awarded:'}{' '}
                  <strong className="font-semibold text-slate-700">{item.awardedDate}</strong>
                </span>

                <span>
                  My Proposal:{' '}
                  <strong className="font-bold text-slate-900">
                    {formatCurrency(item.proposalAmount)}
                  </strong>
                </span>

                <span className="inline-flex items-center gap-1 text-slate-500">
                  <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span>{item.location}</span>
                </span>

                <span className="text-slate-400 font-medium">#{item.refNumber}</span>

                {isCancelledOrder ? (
                  <span className="text-rose-600 font-semibold">· Cancelled</span>
                ) : (
                  isCompleted && <span className="text-emerald-600 font-semibold">· Completed</span>
                )}
              </div>
            </div>

            {/* Right Side: Project Financial Metric + VIEW PROGRESS Button */}
            <div className="flex sm:flex-col items-center sm:items-end justify-between w-full sm:w-auto shrink-0 sm:min-w-[155px] gap-2.5">
              <div className="text-left sm:text-right leading-none">
                <span className="block text-xl font-bold text-slate-900 tracking-tight">
                  {formatCurrency(rightSideAmount)}
                </span>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mt-1">
                  {rightSideLabel}
                </span>
              </div>

              <button
                type="button"
                onClick={() => onOpenWorkstream(targetOrderId, item.order, item.projectId)}
                className="px-4 py-2 bg-white hover:bg-emerald-50/50 text-slate-700 hover:text-emerald-600 border border-slate-200 hover:border-emerald-600 rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-2xs cursor-pointer whitespace-nowrap"
              >
                VIEW PROGRESS
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
