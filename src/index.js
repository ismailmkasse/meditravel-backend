import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config.js';
import { prisma } from './prisma.js';

import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import providersRoutes from './routes/providers.js';
import proceduresRoutes from './routes/procedures.js';
import quotationsRoutes from './routes/quotations.js';
import notificationsRoutes from './routes/notifications.js';
import paymentsRoutes from './routes/payments.js';
import fxRoutes from './routes/fx.js';
import pricingRoutes from './routes/pricing.js';
import { stripeWebhookHandler } from './routes/stripeWebhook.js';

import cron from 'node-cron';
import { runDuePayouts } from './services/payouts.js';

const app = express();

/* =========================
   CORS (Vercel prod + preview)
   ========================= */
const allowExact = new Set([
  'https://meditravel-86cc.vercel.app'
]);

const isVercel = (origin) =>
  typeof origin === 'string' && origin.endsWith('.vercel.app');

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server / health
      if (allowExact.has(origin) || isVercel(origin)) return cb(null, true);
      return cb(new Error('CORS blocked: ' + origin), false);
    },
    credentials: true
  })
);

app.options('*', cors());

/* ========================= */

app.use(morgan('dev'));

// Stripe webhook MUST use raw body
app.post(
  '/payments/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

app.use(express.json({ limit: '2mb' }));

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, db: true });
  } catch {
    return res.json({ ok: true, db: false });
  }
});

app.use('/auth', authRoutes);
app.use('/', meRoutes);
app.use('/providers', providersRoutes);
app.use('/procedures', proceduresRoutes);
app.use('/quotations', quotationsRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/payments', paymentsRoutes);
app.use('/fx', fxRoutes);
app.use('/pricing', pricingRoutes);

// Background jobs (cron)
if (config.cronEnabled) {
  cron.schedule(config.cronPayoutSpec, async () => {
    try {
      const results = await runDuePayouts({ limit: 50 });
      if (results?.length) {
        console.log('[cron] payouts processed', results.length);
      }
    } catch (e) {
      console.error('[cron] payout job failed', e);
    }
  });
  console.log('[cron] enabled with spec:', config.cronPayoutSpec);
}

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(config.port, () => {
  console.log(`MediTravel API listening on port ${config.port}`);
});
