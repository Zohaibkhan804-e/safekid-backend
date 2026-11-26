import { Router } from 'express';
import { z } from 'zod';
import { pool, query } from '../../common/db.js';
import { AppError, asyncHandler } from '../../common/errors.js';
import { requireAuth } from '../../common/auth.js';

const uuid = z.string().uuid();

// ---------- Policy shape (the contract with Maisam) ----------
const ruleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('app_block'),
    package: z.string().min(3).max(200),
    mode: z.literal('block'),
  }),
  z.object({
    type: z.literal('domain_block'),
    domains: z.array(z.string().min(3).max(253)).min(1).max(100),
  }),
]);

const policySchema = z.object({
  schemaVersion: z.literal(1),
  rules: z.array(ruleSchema).max(100),
});

const ackSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(['applied', 'unsupported', 'failed']),
  detail: z.string().max(500).optional(),
});

// Makes sure the device belongs to the logged-in parent
const getOwnedDevice = async (deviceId, parentId) => {
  if (!uuid.safeParse(deviceId).success) throw new AppError(400, 'VALIDATION', 'Invalid device id');
  const { rows } = await query(
    `SELECT id FROM devices WHERE id = $1 AND parent_id = $2 AND status = 'active'`,
    [deviceId, parentId]
  );
  if (!rows[0]) throw new AppError(404, 'DEVICE_NOT_FOUND', 'Device not found');
  return rows[0];
};

// =====================================================
// PARENT routes  (mounted at /api/v1/devices)
// =====================================================
export const parentPolicyRouter = Router();

// Create a new policy version
parentPolicyRouter.put('/:id/policy', requireAuth('parent'), asyncHandler(async (req, res) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION', 'Invalid policy format');

  await getOwnedDevice(req.params.id, req.user.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // lock the device row so two saves cannot create the same version
    await client.query('SELECT id FROM devices WHERE id = $1 FOR UPDATE', [req.params.id]);
    const { rows } = await client.query(
      `INSERT INTO policies (device_id, version, rules)
       SELECT $1, COALESCE(MAX(version), 0) + 1, $2 FROM policies WHERE device_id = $1
       RETURNING version`,
      [req.params.id, JSON.stringify(parsed.data)]
    );
    await client.query('COMMIT');
    res.status(201).json({ version: rows[0].version });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Latest policy for the dashboard
parentPolicyRouter.get('/:id/policy', requireAuth('parent'), asyncHandler(async (req, res) => {
  await getOwnedDevice(req.params.id, req.user.id);
  const { rows } = await query(
    `SELECT version, rules, created_at AS "createdAt" FROM policies
     WHERE device_id = $1 ORDER BY version DESC LIMIT 1`,
    [req.params.id]
  );
  if (!rows[0]) return res.json({ version: 0, rules: null });
  res.json(rows[0]);
}));

// Pending / applied / unsupported / failed
parentPolicyRouter.get('/:id/policy-status', requireAuth('parent'), asyncHandler(async (req, res) => {
  await getOwnedDevice(req.params.id, req.user.id);

  const latest = await query(
    `SELECT version, created_at AS "createdAt" FROM policies
     WHERE device_id = $1 ORDER BY version DESC LIMIT 1`,
    [req.params.id]
  );
  if (!latest.rows[0]) return res.json({ latestVersion: 0, status: 'no_policy', lastAck: null });

  const ack = await query(
    `SELECT version, status, detail, acked_at AS "ackedAt" FROM policy_acks
     WHERE device_id = $1 AND version = $2 ORDER BY acked_at DESC LIMIT 1`,
    [req.params.id, latest.rows[0].version]
  );

  res.json({
    latestVersion: latest.rows[0].version,
    status: ack.rows[0] ? ack.rows[0].status : 'pending',
    lastAck: ack.rows[0] ?? null,
  });
}));

// =====================================================
// DEVICE (child phone) routes  (mounted at /api/v1/device)
// =====================================================
export const deviceRouter = Router();
deviceRouter.use(requireAuth('device'));

// Every device call also refreshes "last seen" and blocks revoked devices
deviceRouter.use(asyncHandler(async (req, res, next) => {
  const { rows } = await query(
    `UPDATE devices SET last_seen_at = now() WHERE id = $1 AND status = 'active' RETURNING id`,
    [req.user.id]
  );
  if (!rows[0]) throw new AppError(401, 'DEVICE_REVOKED', 'Device is no longer active');
  next();
}));

// Child asks: "is there a newer policy than the one I have?"
deviceRouter.get('/policy', asyncHandler(async (req, res) => {
  const current = Number.parseInt(req.query.currentVersion ?? '0', 10) || 0;
  const { rows } = await query(
    `SELECT version, rules, created_at AS "createdAt" FROM policies
     WHERE device_id = $1 ORDER BY version DESC LIMIT 1`,
    [req.user.id]
  );
  const latest = rows[0];
  if (!latest || latest.version <= current) {
    return res.json({ upToDate: true, version: latest?.version ?? 0 });
  }
  res.json({ upToDate: false, version: latest.version, rules: latest.rules.rules, schemaVersion: latest.rules.schemaVersion });
}));

// Child reports: "I applied version N" (or unsupported / failed)
deviceRouter.post('/policy/ack', asyncHandler(async (req, res) => {
  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION', 'version, status (applied|unsupported|failed) required');
  const { version, status, detail } = parsed.data;

  const latest = await query(
    'SELECT MAX(version) AS v FROM policies WHERE device_id = $1',
    [req.user.id]
  );
  const latestVersion = latest.rows[0].v;
  if (!latestVersion) throw new AppError(400, 'NO_POLICY', 'No policy exists for this device');
  if (version !== latestVersion) {
    throw new AppError(409, 'STALE_VERSION', `Latest version is ${latestVersion}`);
  }

  await query(
    'INSERT INTO policy_acks (device_id, version, status, detail) VALUES ($1, $2, $3, $4)',
    [req.user.id, version, status, detail ?? null]
  );
  res.json({ ok: true });
}));