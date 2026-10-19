import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { pool } from '../db';
import { getReferralContract } from '../services/referral-contract';

export const getReferralStats = async (req: Request, res: Response) => {
  const wallet = req.params.wallet;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: 'invalid wallet address' });
  }

  const address = ethers.getAddress(wallet);

  const countResult = await pool.query(
    `SELECT COUNT(DISTINCT referred_wallet)::int AS count
       FROM referral_earnings
      WHERE referrer_wallet = $1`,
    [address],
  );

  const totalResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::text AS current_earned
       FROM referral_earnings
      WHERE referrer_wallet = $1`,
    [address],
  );

  const contract = getReferralContract();
  const unclaimed: bigint = await contract.unclaimedBalance(address);

  return res.json({
    wallet: address,
    referred_count: Number(countResult.rows[0].count),
    total_earned: totalResult.rows[0].current_earned,
    unclaimed_balance: unclaimed.toString(),
  });
};

export const getReferralEarnings = async (req: Request, res: Response) => {
  const wallet = req.params.wallet;
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: 'invalid wallet address' });
  }

  const address = ethers.getAddress(wallet);
  const limitRaw = Number.parseInt(String(req.query.limit ?? '20'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;

  if (from && isNaN(from.getTime())) {
    return res.status(400).json({ error: 'invalid from date' });
  }
  if (to && isNaN(to.getTime())) {
    return res.status(400).json({ error: 'invalid to date' });
  }

  const conditions: string[] = ['referrer_wallet = $1'];
  const params: any[] = [address];

  if (from) {
    params.push(from.toISOString());
    conditions.push(`block_timestamp >= $${params.length}`);
  }
  if (to) {
    params.push(to.toISOString());
    conditions.push(`block_timestamp <= $${params.length}`);
  }

  if (cursor) {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const [sepId, sepTime] = decoded.split('|');
    const id = Number(sepId);
    const time = new Date(sepTime);
    if (!Number.isFinite(id) || isNaN(time.getTime())) {
      return res.status(400).json({ error: 'invalid cursor' });
    }
    params.push(time.toISOString());
    params.push(id);
    conditions.push(
      `(block_timestamp, id) < ($${params.length - 1}, $${params.length})`,
    );
  }

  params.push(limit + 1);
  const query = `
    SELECT id, referred_wallet, amount, block_timestamp, tx_hash
    FROM referral_earnings
    WHERE ${conditions.join(' AND ')}
    ORDER BY block_timestamp DESC, id DESC
    LIMIT $${params.length}
  `;

  const result = await pool.query(query, params);
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

  const items = rows.map((row) => ({
    id: row.id,
    referred_wallet: row.referred_wallet,
    amount: row.amount,
    date: new Date(row.block_timestamp).toISOString(),
    tx_hash: row.tx_hash,
  }));

  let nextCursor: string | null = null;
  if (hasMore && rows.length > 0) {
    const last = rows[rows.length - 1];
    const payload = `${last.id}|${new Date(last.block_timestamp).toISOString()}`;
    nextCursor = Buffer.from(payload, 'utf-8').toString('base64');
  }

  return res.json({
    wallet: address,
    items,
    next_cursor: nextCursor,
  });
};
