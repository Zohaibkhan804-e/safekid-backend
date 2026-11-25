    import app from './app.js';
import { pool } from './common/db.js';

const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    await pool.query('SELECT 1');
    console.log('Database connected');
    app.listen(PORT, () => console.log(`SafeKid API running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err.message);
    process.exit(1);
  }
};

start();