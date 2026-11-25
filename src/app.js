import pairingRoutes from './modules/pairing/pairing.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Mount auth routes
app.use('/api/v1/auth', authRoutes);

// Mount pairing routes
app.use('/api/v1/devices', pairingRoutes);


// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
});

// Central error handler (must be last, with 4 parameters)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'INTERNAL',
      message: err.status ? err.message : 'Internal server error',
    },
  });
});

export default app;