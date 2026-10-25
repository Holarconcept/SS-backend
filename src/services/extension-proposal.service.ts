import { DataSource } from "typeorm";
import { TtlCache } from "../lib/ttl-cache";

export interface ExtensionProposal {
  id: string;
  invoiceId: string;
  proposedBy: string;
  newDeadline: number;
  status: string;
  votesFor: number;
  votesAgainst: number;
  quorumBps: number;
  eta: number;
  createdAt: number;
}

export interface ExtensionVote {
  wallet: string;
  vote: "for" | "against";
  weight: string;
  votedAt: number;
}

interface ExtensionProposalRow {
  id: string;
  invoice_id: string;
  proposed_by: string;
  new_deadline: number;
  status: string;
  votes_for: number;
  votes_against: number;
  quorum_bps: number;
  eta: number;
  created_at: number;
}

interface ExtensionVoteRow {
  wallet: string;
  vote: "for" | "against";
  weight: string;
  voted_at: number;
}

/**
 * #681 — Invoice extension proposal indexer and vote tracking REST API.
 * Indexes ExtensionProposed, ExtensionVoteCast, and ExtensionExecuted events.
 */
export class ExtensionProposalService {
  private cache: TtlCache;

  constructor(private readonly dataSource: DataSource) {
    this.cache = new TtlCache({ ttlSeconds: 30, namespace: "extension-proposal" });
  }

  async getActiveProposal(invoiceId: string): Promise<ExtensionProposal | null> {
    const cacheKey = `active:${invoiceId}`;
    const cached = await this.cache.get<ExtensionProposal>(cacheKey);
    if (cached) return cached;

    const rows = (await this.dataSource.query(
      `SELECT id, invoice_id, proposed_by, new_deadline, status,
              votes_for, votes_against, quorum_bps, eta, created_at
       FROM extension_proposals
       WHERE invoice_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [invoiceId],
    )) as ExtensionProposalRow[];

    if (!rows.length) return null;

    const proposal = this.mapProposal(rows[0]);
    await this.cache.set(cacheKey, proposal);
    return proposal;
  }

  async getWalletVote(invoiceId: string, wallet: string): Promise<ExtensionVote | null> {
    const cacheKey = `vote:${invoiceId}:${wallet}`;
    const cached = await this.cache.get<ExtensionVote>(cacheKey);
    if (cached) return cached;

    const rows = (await this.dataSource.query(
      `SELECT wallet, vote, weight, voted_at
       FROM extension_votes WHERE invoice_id = $1 AND wallet = $2`,
      [invoiceId, wallet],
    )) as ExtensionVoteRow[];

    if (!rows.length) return null;

    const vote = {
      wallet: rows[0].wallet,
      vote: rows[0].vote as "for" | "against",
      weight: rows[0].weight,
      votedAt: rows[0].voted_at,
    };

    await this.cache.set(cacheKey, vote);
    return vote;
  }

  async getProposalHistory(invoiceId: string): Promise<ExtensionProposal[]> {
    const cacheKey = `history:${invoiceId}`;
    const cached = await this.cache.get<ExtensionProposal[]>(cacheKey);
    if (cached) return cached;

    const rows = (await this.dataSource.query(
      `SELECT id, invoice_id, proposed_by, new_deadline, status,
              votes_for, votes_against, quorum_bps, eta, created_at
       FROM extension_proposals
       WHERE invoice_id = $1 AND status IN ('completed', 'rejected')
       ORDER BY created_at DESC`,
      [invoiceId],
    )) as ExtensionProposalRow[];

    const proposals = rows.map((row) => this.mapProposal(row));
    await this.cache.set(cacheKey, proposals);
    return proposals;
  }

  private mapProposal(row: ExtensionProposalRow): ExtensionProposal {
    return {
      id: row.id,
      invoiceId: row.invoice_id,
      proposedBy: row.proposed_by,
      newDeadline: row.new_deadline,
      status: row.status,
      votesFor: row.votes_for,
      votesAgainst: row.votes_against,
      quorumBps: row.quorum_bps,
      eta: row.eta,
      createdAt: row.created_at,
    };
  }

  /** Invalidate cache for an invoice when an extension event occurs. */
  async invalidate(invoiceId: string): Promise<void> {
    await Promise.all([
      this.cache.delete(`active:${invoiceId}`),
      this.cache.delete(`history:${invoiceId}`),
    ]);
    this.cache.invalidatePrefix(`vote:${invoiceId}:`);
  }
}
