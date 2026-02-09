import Stripe from 'stripe';
import { config } from './config.js';

// Stripe client is only constructed if a secret key is present.
export const stripe = config.stripeSecretKey
  ? new Stripe(config.stripeSecretKey, { apiVersion: '2024-06-20' })
  : null;

export function ensureStripeConfigured() {
  if (!stripe) {
    const err = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
    err.code = 'stripe_not_configured';
    throw err;
  }
  if (!config.stripeWebhookSecret) {
    // Webhook secret is required for signature verification.
    const err = new Error('Stripe webhook is not configured. Set STRIPE_WEBHOOK_SECRET.');
    err.code = 'stripe_webhook_not_configured';
    throw err;
  }
}
