import jwt from 'jsonwebtoken';
import { AppError } from './errors.js';

// Usage: requireAuth('parent') or requireAuth('device')
export const requireAuth = (role) => (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'NO_TOKEN', 'Missing Bearer token'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== role) {
      return next(new AppError(403, 'WRONG_ROLE', 'This token cannot access this route'));
    }
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new AppError(401, 'BAD_TOKEN', 'Invalid or expired token'));
  }
};