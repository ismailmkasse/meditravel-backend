import express from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { authRequired, requireRole } from '../auth.js';
import { stripe, ensureStripeConfigured } from '../stripe.js';
import { config } from '../config.js';
import { auditLog } from '../services/audit.js';
import { schedulePayoutForPayment, runDuePayouts } from '../services/payouts.js';

const router = express.Router();

/**
 * Payments & escrow-style accounting (LEGAL, production-structured)
 *
 * Modes:
 * - MOCK (default): immediate HELD record in DB (no PSP)
 * - STRIPE: PaymentIntents + webhooks. We do NOT claim to provide escrow; we
 *   use an escrow-like ledger in our DB (HELD -> RELEASED -> payout scheduling).
 *
 * For marketplaces, real provider payouts should use Stripe Connect.
 */

const createDepositSchema = z.object({
  quotationId: z.string().optional(),
  amountCents: z.number().int().min(50),
  currency: z.string().min(3).max(3).optional(),
  holdDays: z.number().int().min(1).max(30).optional()
});

router.post('/deposit', authRequired, async (req, res) => {
  const parsed = createDepositSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  if (parsed.data.quotationId) {
    const q = await prisma.quotationRequest.findUnique({ where: { id: parsed.data.quotationId }, include: { provider: true } });
    if (!q) return res.status(404).json({ error: 'quotation_not_found' });
    if (q.userId !== req.user.sub && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
  }

  const holdDays = parsed.data.holdDays ?? 7;
  const escrowHoldUntil = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000);

  if (config.paymentsMode === 'STRIPE') {
    try {
      ensureStripeConfigured();

      // Create a local payment record first
      const payment = await prisma.payment.create({
        data: {
          userId: req.user.sub,
          quotationId: parsed.data.quotationId || null,
          amountCents: parsed.data.amountCents,
          currency: (parsed.data.currency || 'USD').toUpperCase(),
          status: 'INITIATED',
          escrowHoldUntil,
          providerReleaseEligibleAt: escrowHoldUntil
        }
      });

      // PaymentIntent: manual capture lets us authorize now and capture later (up to Stripe limits).
      const pi = await stripe.paymentIntents.create({
        amount: parsed.data.amountCents,
        currency: (parsed.data.currency || 'USD').toLowerCase(),
        capture_method: 'manual',
        metadata: { paymentId: payment.id, quotationId: payment.quotationId || '' }
      });

      await prisma.payment.update({
        where: { id: payment.id },
        data: { stripePaymentIntentId: pi.id }
      });

      await auditLog({
        actorId: req.user.sub,
        entityType: 'Payment',
        entityId: payment.id,
        action: 'stripe.payment_intent.created',
        metadata: { paymentIntentId: pi.id }
      });

      return res.json({
        payment,
        stripe: {
          paymentIntentId: pi.id,
          clientSecret: pi.client_secret
        },
        note: 'Client must confirm the PaymentIntent using Stripe.js or mobile SDK. Funds are authorized (manual capture).'
      });
    } catch (e) {
      return res.status(400).json({ error: e.code || 'stripe_error', message: e.message });
    }
  }

  // MOCK mode (default)
  const payment = await prisma.payment.create({
    data: {
      userId: req.user.sub,
      quotationId: parsed.data.quotationId || null,
      amountCents: parsed.data.amountCents,
      currency: (parsed.data.currency || 'USD').toUpperCase(),
      status: 'HELD',
      escrowHoldUntil,
      providerReleaseEligibleAt: escrowHoldUntil
    }
  });

  return res.json({
    ...payment,
    note: 'MOCK mode: ledger hold created. Switch PAYMENTS_MODE=STRIPE for real PaymentIntents + webhooks.'
  });
});

// STRIPE: create a PaymentIntent for a deposit.
// Client uses client_secret to confirm the payment.
const createStripeDepositSchema = z.object({
  quotationId: z.string().optional(),
  amountCents: z.number().int().min(50),
  currency: z.string().min(3).max(3).optional(),
  holdDays: z.number().int().min(1).max(30).optional()
});

router.post('/stripe/create-payment-intent', authRequired, async (req, res) => {
  const parsed = createStripeDepositSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  if (config.paymentsMode !== 'STRIPE') {
    return res.status(400).json({ error: 'payments_mode_not_stripe', message: 'Set PAYMENTS_MODE=STRIPE' });
  }

  try {
    ensureStripeConfigured();
  } catch (e) {
    return res.status(500).json({ error: e.code || 'stripe_config', message: e.message });
  }

  const holdDays = parsed.data.holdDays ?? 7;
  const escrowHoldUntil = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000);

  // Create internal payment record first.
  const payment = await prisma.payment.create({
    data: {
      userId: req.user.sub,
      quotationId: parsed.data.quotationId || null,
      amountCents: parsed.data.amountCents,
      currency: (parsed.data.currency || 'USD').toUpperCase(),
      status: 'INITIATED',
      escrowHoldUntil,
      providerReleaseEligibleAt: escrowHoldUntil
    }
  });

  const intent = await stripe.paymentIntents.create({
    amount: payment.amountCents,
    currency: payment.currency.toLowerCase(),
    // Manual capture allows an authorization hold (typically up to 7 days).
    // This helps implement an escrow-like flow legally (as a ledger + delayed capture),
    // but you still must comply with Stripe rules and your local regulations.
    capture_method: 'manual',
    metadata: {
      paymentId: payment.id,
      userId: req.user.sub,
      quotationId: payment.quotationId || ''
    }
  });

  await prisma.payment.update({
    where: { id: payment.id },
    data: { stripePaymentIntentId: intent.id }
  });

  await auditLog({
    actorId: req.user.sub,
    entityType: 'Payment',
    entityId: payment.id,
    action: 'stripe.payment_intent.created',
    metadata: { stripePaymentIntentId: intent.id }
  });

  return res.json({
    payment,
    stripe: {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret
    }
  });
});

// STRIPE: capture authorized payment (admin only) when releasing funds.
const captureSchema = z.object({ paymentId: z.string().min(1) });

router.post('/stripe/capture', authRequired, requireRole('ADMIN'), async (req, res) => {
  const parsed = captureSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });
  if (config.paymentsMode !== 'STRIPE') return res.status(400).json({ error: 'payments_mode_not_stripe' });

  try {
    ensureStripeConfigured();
  } catch (e) {
    return res.status(500).json({ error: e.code || 'stripe_config', message: e.message });
  }

  const payment = await prisma.payment.findUnique({ where: { id: parsed.data.paymentId } });
  if (!payment) return res.status(404).json({ error: 'not_found' });
  if (!payment.stripePaymentIntentId) return res.status(400).json({ error: 'missing_stripe_pi' });

  const pi = await stripe.paymentIntents.capture(payment.stripePaymentIntentId);
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'HELD', capturedAt: new Date() }
  });

  await auditLog({
    actorId: req.user.sub,
    entityType: 'Payment',
    entityId: payment.id,
    action: 'stripe.payment_intent.captured',
    metadata: { stripePaymentIntentId: pi.id }
  });

  return res.json(updated);
});

const releaseSchema = z.object({ paymentId: z.string().min(1) });

router.post('/release', authRequired, requireRole('ADMIN'), async (req, res) => {
  const parsed = releaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const payment = await prisma.payment.findUnique({ where: { id: parsed.data.paymentId }, include: { quotation: { include: { provider: true } } } });
  if (!payment) return res.status(404).json({ error: 'not_found' });
  if (payment.status !== 'HELD') return res.status(400).json({ error: 'bad_status' });

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'RELEASED', providerReleasedAt: new Date() }
  });

  // Schedule provider payout based on configured interval.
  await schedulePayoutForPayment(payment.id);

  if (payment.quotation?.provider?.userId) {
    await prisma.notification.create({
      data: {
        userId: payment.quotation.provider.userId,
        type: 'payment.released',
        title: 'Escrow released',
        body: `Payment ${payment.id} has been released (admin approval).`
      }
    });
  }

  return res.json(updated);
});

const refundSchema = z.object({ paymentId: z.string().min(1), reason: z.string().optional() });

router.post('/refund', authRequired, requireRole('ADMIN'), async (req, res) => {
  const parsed = refundSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const payment = await prisma.payment.findUnique({ where: { id: parsed.data.paymentId } });
  if (!payment) return res.status(404).json({ error: 'not_found' });
  if (!['HELD','RELEASED'].includes(payment.status)) return res.status(400).json({ error: 'bad_status' });

  // If Stripe mode and we have a PaymentIntent/Charge, issue a real refund.
  if (config.paymentsMode === 'STRIPE' && payment.stripePaymentIntentId && stripe) {
    try {
      // Refund by PaymentIntent (Stripe will pick the underlying charge)
      await stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId, reason: 'requested_by_customer' });
    } catch (e) {
      return res.status(400).json({ error: 'stripe_refund_failed', message: e.message });
    }
  }

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'REFUNDED' }
  });

  await auditLog({
    actorId: req.user.sub,
    entityType: 'Payment',
    entityId: payment.id,
    action: 'payment.refunded',
    metadata: { reason: parsed.data.reason || null, mode: config.paymentsMode }
  });

  await prisma.notification.create({
    data: {
      userId: payment.userId,
      type: 'payment.refunded',
      title: 'Refund processed',
      body: parsed.data.reason || `Refund processed for payment ${payment.id}.`
    }
  });

  return res.json(updated);
});

// Admin: view payouts
router.get('/admin/payouts', authRequired, requireRole('ADMIN'), async (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
  const list = await prisma.payout.findMany({
    where: status ? { status } : {},
    include: { provider: true, payment: true },
    orderBy: { scheduledAt: 'desc' },
    take: 200
  });
  return res.json(list);
});

// Admin: run due payouts now (in production, run via a cron/scheduler)
router.post('/admin/payouts/run', authRequired, requireRole('ADMIN'), async (req, res) => {
  const results = await runDuePayouts({ limit: 50 });
  return res.json({ results });
});



// ===================== STRIPE CONNECT ONBOARDING (Providers) =====================
// Creates/returns a Stripe Connect account for the provider and returns an onboarding link.
// This is the recommended way to do marketplace payouts in Stripe.

router.post('/stripe/connect/account', authRequired, requireRole('PROVIDER'), async (req, res) => {
  if (!config.stripeConnectEnabled) return res.status(400).json({ error: 'stripe_connect_disabled' });
  if (config.paymentsMode !== 'STRIPE') return res.status(400).json({ error: 'payments_mode_not_stripe' });

  try { ensureStripeConfigured(); } catch (e) {
    return res.status(500).json({ error: e.code || 'stripe_config', message: e.message });
  }

  const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
  if (!profile) return res.status(404).json({ error: 'profile_missing' });
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });

  let stripeAccountId = profile.stripeAccountId;
  if (!stripeAccountId) {
    const acct = await stripe.accounts.create({
      type: 'express',
      country: (profile.countryCode || config.stripeConnectDefaultCountry || 'US').toUpperCase(),
      email: user?.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_profile: {
        name: profile.displayName
      },
      metadata: { providerId: profile.id, userId: req.user.sub }
    });

    stripeAccountId = acct.id;
    await prisma.providerProfile.update({
      where: { id: profile.id },
      data: {
        stripeAccountId,
        stripeChargesEnabled: !!acct.charges_enabled,
        stripePayoutsEnabled: !!acct.payouts_enabled,
        stripeDetailsSubmitted: !!acct.details_submitted
      }
    });

    await auditLog({
      actorId: req.user.sub,
      entityType: 'ProviderProfile',
      entityId: profile.id,
      action: 'stripe.connect.account.created',
      metadata: { stripeAccountId }
    });
  }

  return res.json({ stripeAccountId });
});

router.post('/stripe/connect/account-link', authRequired, requireRole('PROVIDER'), async (req, res) => {
  if (!config.stripeConnectEnabled) return res.status(400).json({ error: 'stripe_connect_disabled' });
  if (config.paymentsMode !== 'STRIPE') return res.status(400).json({ error: 'payments_mode_not_stripe' });

  try { ensureStripeConfigured(); } catch (e) {
    return res.status(500).json({ error: e.code || 'stripe_config', message: e.message });
  }

  const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
  if (!profile || !profile.stripeAccountId) return res.status(400).json({ error: 'missing_stripe_account' });

  const link = await stripe.accountLinks.create({
    account: profile.stripeAccountId,
    refresh_url: config.stripeConnectRefreshUrl,
    return_url: config.stripeConnectReturnUrl,
    type: 'account_onboarding'
  });

  await auditLog({
    actorId: req.user.sub,
    entityType: 'ProviderProfile',
    entityId: profile.id,
    action: 'stripe.connect.onboarding_link.created',
    metadata: { stripeAccountId: profile.stripeAccountId }
  });

  return res.json({ url: link.url, expiresAt: link.expires_at });
});

router.get('/stripe/connect/status', authRequired, requireRole('PROVIDER'), async (req, res) => {
  const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
  if (!profile) return res.status(404).json({ error: 'profile_missing' });

  return res.json({
    stripeConnectEnabled: config.stripeConnectEnabled,
    stripeAccountId: profile.stripeAccountId,
    stripeChargesEnabled: profile.stripeChargesEnabled,
    stripePayoutsEnabled: profile.stripePayoutsEnabled,
    stripeDetailsSubmitted: profile.stripeDetailsSubmitted,
    stripeOnboardedAt: profile.stripeOnboardedAt
  });
});

// Provider: view own payouts
router.get('/provider/payouts', authRequired, requireRole('PROVIDER'), async (req, res) => {
  const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
  if (!profile) return res.status(404).json({ error: 'profile_missing' });

  const list = await prisma.payout.findMany({
    where: { providerId: profile.id },
    include: { payment: true },
    orderBy: { scheduledAt: 'desc' },
    take: 200
  });
  return res.json(list);
});

router.get('/me', authRequired, async (req, res) => {
  const list = await prisma.payment.findMany({
    where: { userId: req.user.sub },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  return res.json(list);
});

export default router;
