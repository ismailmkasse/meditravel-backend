import { prisma } from '../prisma.js';
import { config } from '../config.js';
import { stripe } from '../stripe.js';
import { auditLog } from './audit.js';

/**
 * Payout scheduling model:
 * - When a payment is RELEASED, we create a Payout scheduledAt = now + N days
 * - A periodic job (or admin-triggered endpoint) runs and pays eligible payouts
 *
 * NOTE: True marketplace payouts require Stripe Connect (or equivalent) and
 * proper KYC/onboarding of providers. This implementation is production-structured
 * but intentionally safe-by-default.
 */

export async function schedulePayoutForPayment(paymentId) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { quotation: { include: { provider: true } } }
  });
  if (!payment) {
    const e = new Error('payment_not_found');
    e.code = 'payment_not_found';
    throw e;
  }
  if (payment.status !== 'RELEASED') {
    const e = new Error('payment_not_released');
    e.code = 'payment_not_released';
    throw e;
  }
  if (!payment.quotation?.provider) {
    const e = new Error('payment_missing_provider');
    e.code = 'payment_missing_provider';
    throw e;
  }
  const existing = await prisma.payout.findUnique({ where: { paymentId: payment.id } });
  if (existing) return existing;

  const providerId = payment.quotation.provider.id;
  const scheduledAt = new Date(Date.now() + config.payoutIntervalDays * 24 * 60 * 60 * 1000);

  const payout = await prisma.payout.create({
    data: {
      providerId,
      paymentId: payment.id,
      amountCents: payment.amountCents,
      currency: payment.currency,
      status: 'PENDING',
      scheduledAt
    }
  });
  await auditLog({
    actorId: null,
    entityType: 'Payout',
    entityId: payout.id,
    action: 'payout.scheduled',
    metadata: { paymentId: payment.id, providerId, scheduledAt }
  });
  return payout;
}

export async function runDuePayouts({ limit = 25 } = {}) {
  const due = await prisma.payout.findMany({
    where: { status: 'PENDING', scheduledAt: { lte: new Date() } },
    include: { provider: true, payment: true },
    orderBy: { scheduledAt: 'asc' },
    take: limit
  });

  const results = [];
  for (const p of due) {
    try {
      // If Stripe Connect enabled and provider has a connected account, create a Transfer.
      if (config.stripeConnectEnabled && stripe && p.provider.stripeAccountId) {
        const transfer = await stripe.transfers.create({
          amount: p.amountCents,
          currency: p.currency.toLowerCase(),
          destination: p.provider.stripeAccountId,
          metadata: { payoutId: p.id, paymentId: p.paymentId, providerId: p.providerId }
        });

        const updated = await prisma.payout.update({
          where: { id: p.id },
          data: { status: 'PAID', paidAt: new Date(), externalRef: transfer.id, error: null }
        });
        await auditLog({
          actorId: null,
          entityType: 'Payout',
          entityId: p.id,
          action: 'payout.paid',
          metadata: { transferId: transfer.id }
        });
        results.push({ payoutId: p.id, status: 'PAID', externalRef: transfer.id });
      } else {
        // Safe default: mark as FAILED with clear error so operators can act.
        const updated = await prisma.payout.update({
          where: { id: p.id },
          data: {
            status: 'FAILED',
            error: config.stripeConnectEnabled
              ? 'missing_stripe_connect_account'
              : 'stripe_connect_disabled'
          }
        });
        await auditLog({
          actorId: null,
          entityType: 'Payout',
          entityId: p.id,
          action: 'payout.failed',
          metadata: { reason: updated.error }
        });
        results.push({ payoutId: p.id, status: 'FAILED', error: updated.error });
      }
    } catch (err) {
      await prisma.payout.update({ where: { id: p.id }, data: { status: 'FAILED', error: err.message } });
      await auditLog({
        actorId: null,
        entityType: 'Payout',
        entityId: p.id,
        action: 'payout.failed',
        metadata: { error: err.message }
      });
      results.push({ payoutId: p.id, status: 'FAILED', error: err.message });
    }
  }
  return results;
}
