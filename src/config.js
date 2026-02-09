import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  paymentsMode: process.env.PAYMENTS_MODE || 'MOCK',

  // Stripe core
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripeWebhookToleranceSec: parseInt(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || '300', 10),

  // Stripe Connect (recommended for marketplaces)
  stripeConnectEnabled: process.env.STRIPE_CONNECT_ENABLED === 'true',
  stripeConnectReturnUrl: process.env.STRIPE_CONNECT_RETURN_URL || 'http://localhost:5173/provider',
  stripeConnectRefreshUrl: process.env.STRIPE_CONNECT_REFRESH_URL || 'http://localhost:5173/provider',
  stripeConnectDefaultCountry: process.env.STRIPE_CONNECT_DEFAULT_COUNTRY || 'US',

  // Payout scheduling
  payoutIntervalDays: parseInt(process.env.PAYOUT_INTERVAL_DAYS || '7', 10),

  // Background jobs
  cronEnabled: process.env.CRON_ENABLED === 'true',
  cronPayoutSpec: process.env.CRON_PAYOUT_SPEC || '*/15 * * * *'
};
