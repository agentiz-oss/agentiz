import { AgentApprovalRequest } from '../../app-agentiz/models/AgentApprovalRequest';
import { ApprovalError, ApprovalService } from '../../app-agentiz/services/ApprovalService';
import { PROJECT_TOKENS } from '../../app-agentiz/lib/access/tokens';
import { MobileAuthError } from './MobileAuthService';
import { requireProjectAccess, visibleProjectIds } from '../lib/mobileScope';

/**
 * The human gate from the phone: read what is waiting, accept it, or send it back with a reason.
 *
 * The scope rules of this layer apply unchanged. A request in a project the caller cannot decide
 * in is a **404** and never a 403 — the API must not confirm that somebody else's approval exists
 * — and the token asked for is the request's own `assigneeToken`, not a fixed one: a graph may
 * address a decision to a narrower capability than «приёмка», and the phone must not widen it.
 *
 * Everything that decides anything goes through `ApprovalService`, which stays the single place
 * that enforces "pending only", "a rejection needs a reason", and the order — decide the row,
 * then hand the outcome to the workflow.
 */
export class MobileApprovalService {
  /** Every decision waiting on this person, oldest first: it is a queue, not a feed. */
  static async list(userId: number | string): Promise<Array<Record<string, unknown>>> {
    // Scoped by the default approval token, which is what all but a deliberately narrowed graph
    // uses. A request addressed to some other token is still fetchable by id, and the per-request
    // check below is what actually decides.
    const projectIds = await visibleProjectIds(userId, PROJECT_TOKENS.approvalDecide);
    const rows = await ApprovalService.listPending(projectIds);
    return Promise.all(rows.map((row) => ApprovalService.describe(row)));
  }

  static async byId(approvalId: string, userId: number | string): Promise<Record<string, unknown>> {
    return ApprovalService.describe(await this.load(approvalId, userId));
  }

  static async decide(
    approvalId: string,
    userId: number | string,
    decision: 'approved' | 'rejected',
    comment?: string | null,
  ): Promise<Record<string, unknown>> {
    const approval = await this.load(approvalId, userId);
    try {
      const decided = await ApprovalService.decide({ approvalId: approval.id, actor: userId, decision, comment });
      return ApprovalService.describe(decided);
    } catch (error) {
      // The service's own statuses are already the right ones for a client (409 for a decision
      // that has been made, 400 for a rejection with no reason); only the shape differs.
      if (error instanceof ApprovalError) throw new MobileAuthError(error.status, error.message);
      throw error;
    }
  }

  /** Load + scope in one place, so no endpoint can accidentally answer 403 instead of 404. */
  private static async load(approvalId: string, userId: number | string): Promise<AgentApprovalRequest> {
    const approval = await AgentApprovalRequest.findByPk(approvalId);
    if (!approval) throw new MobileAuthError(404, 'Заявка не найдена');
    await requireProjectAccess(approval.projectId, userId, 'Заявка не найдена', approval.assigneeToken);
    return approval;
  }
}
