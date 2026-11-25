import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from '../../common/db.js';
import { AppError, asyncHandler } from '../../common/errors.js';

const router = Router();

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const signToken = (id) =>
  jwt.sign({ sub: id, role: 'parent' }, process.env.JWT_SECRET, { expiresIn: '7d' });

router.post('/register', asyncHandler(async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION', 'Valid email and 8+ char password required');

  const { email, password } = parsed.data;
  const hash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await query(
      'INSERT INTO parents (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email.toLowerCase(), hash]
    );
    res.status(201).json({ token: signToken(rows[0].id) });
  } catch (err) {
    if (err.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered');
    throw err;
  }
}));

router.post('/login', asyncHandler(async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'VALIDATION', 'Invalid input');

  const { email, password } = parsed.data;
  const { rows } = await query('SELECT id, password_hash FROM parents WHERE email = $1', [email.toLowerCase()]);

  const ok = rows[0] && (await bcrypt.compare(password, rows[0].password_hash));
  if (!ok) throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong email or password');

  res.json({ token: signToken(rows[0].id) });
}));

export default router;