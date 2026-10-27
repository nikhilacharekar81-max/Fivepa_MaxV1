import { store, type Dispute } from '../store.js';
import { emitSystemEvent } from './messagingService.js';

export async function closeActiveDispute(orderId: string, status: Dispute['status'], notes: string): Promise<void> {
  try {
    const dispute = await store.getDisputeByOrderId(orderId);
    if (dispute && (dispute.status === 'open' || dispute.status === 'under_investigation')) {
      dispute.status = status;
      dispute.resolutionNotes = notes;
      await store.saveDispute(dispute);
      await emitSystemEvent(orderId, 'dispute_resolved', `✅ Dispute resolved: ${status.replace('_', ' ')}. Note: ${notes}`);
    }
  } catch (err) {
    console.error(`[disputeService] Error closing dispute for order ${orderId}:`, err);
    throw err;
  }
}
