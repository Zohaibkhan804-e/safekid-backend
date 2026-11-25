import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool, query } from '../../common/db.js';
import { AppError, asyncHandler } from '../../common/errors.js';
import { requireAuth } from '../../common/auth.js';

const router = Router();

const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

// Limit guessing attempts on the public pairing endpoint
const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many attempts, try later' } },
});

// 1) PARENT: generate a pairing code
router.post('/pairing-codes', requireAuth('parent'), asyncHandler(async (req, res) => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  for (let i = 0; i < 5; i++) {
    const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
    const codeHash = hashCode(code);

    // avoid two active codes having the same value
    const clash = await query(
      'SELECT 1 FROM pairing_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()',
      [codeHash]
    );
    if (clash.rowCount) continue;

    await query(
      'INSERT INTO pairing_codes (parent_id, code_hash, expires_at) VALUES ($1, $2, $3)',
      [req.user.id, codeHash, expiresAt]
    );
    return res.status(201).json({ code, expiresAt });
  }
  throw new AppError(500, 'CODE_GEN', 'Could not generate code, try again');
}));

// 2) CHILD: redeem the code and become a paired device
const pairSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  deviceName: z.string().min(1).max(100),
  model: z.string().max(100).optional(),
  fcmToken: z.string().max(500).optional(),
});

router.post('/pair', pairLimiter, asyncHandler(async (req, res) => {
  const parsed = pairSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION', 'code (6 digits) and deviceName required');
  const { code, deviceName, model, fcmToken } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // atomic: marks the code used only if it is still valid
    const used = await client.query(
      `UPDATE pairing_codes SET used_at = now()
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING parent_id`,
      [hashCode(code)]
    );
    if (!used.rowCount) throw new AppError(400, 'INVALID_CODE', 'Code is invalid, expired or already used');

    const { rows } = await client.query(
      `INSERT INTO devices (parent_id, name, model, fcm_token)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [used.rows[0].parent_id, deviceName, model ?? null, fcmToken ?? null]
    );
    await client.query('COMMIT');

    const deviceId = rows[0].id;
    const token = jwt.sign({ sub: deviceId, role: 'device' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ deviceId, token });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// 3) PARENT: list my devices
router.get('/', requireAuth('parent'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, model, status, paired_at AS "pairedAt", last_seen_at AS "lastSeenAt"
     FROM devices WHERE parent_id = $1 AND status = 'active' ORDER BY paired_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}));

export default router;