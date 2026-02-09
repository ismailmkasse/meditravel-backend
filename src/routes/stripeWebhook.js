import { prisma } from '../prisma.js';
import { config } from '../config.js';
import { stripe } from '../stripe.js';
import { auditLog } from '../services/audit.js';
import crypto from 'crypto';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Express handler for Stripe webhooks. Must be mounted with express.raw({ type: 'application/json' }).
export async function stripeWebhookHandler(req, res) {
  if (!stripe || !config.stripeWebhookSecret) {
    return res.status(500).send('Stripe not configured');
  }

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    // Replay protection: Stripe signature includes a timestamp. We enforce a tolerance window.
    event = stripe.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret, config.stripeWebhookToleranceSec);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: store Stripe event id; ignore duplicates.
  const payloadHash = sha256Hex(req.body);
  try {
    await prisma.webhookEvent.create({
      data: {
        provider: 'STRIPE',
        stripeEventId: event.id,
        type: event.type,
        livemode: !!event.livemode,
        payloadHash
      }
    });
  } catch (e) {
    // Prisma unique violation: already processed.
    if (e?.code == 'P2002') {
      return res.json({ received: true, duplicate: true });
    }
    return res.status(500).send(`Webhook storage error: ${e.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const paymentId = pi.metadata?.paymentId;
        if (paymentId) {
          const statusMap = {
            succeeded: 'HELD',
            requires_capture: 'AUTHORIZED',
            processing: 'INITIATED'
          };

          let newStatus = statusMap[pi.status] || 'INITIATED';
          if (event.type === 'payment_intent.payment_failed') newStatus = 'FAILED';

          await prisma.payment.update({
            where: { id: paymentId },
            data: {
              stripePaymentIntentId: pi.id,
              status: newStatus
            }
          });

          await auditLog({
            actorId: null,
            entityType: 'Payment',
            entityId: paymentId,
            action: `stripe.webhook.${event.type}`,
            metadata: { stripePaymentIntentId: pi.id, stripeStatus: pi.status }
          });
        }
        break;
      }
      case 'charge.succeeded': {
        const charge = event.data.object;
        const paymentId = charge.metadata?.paymentId;
        if (paymentId) {
          await prisma.payment.update({
            where: { id: paymentId },
            data: {
              stripeChargeId: charge.id
            }
          });
        }
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object;
        const paymentId = charge.metadata?.paymentId;
        if (paymentId) {
          await prisma.payment.update({ where: { id: paymentId }, data: { status: 'REFUNDED' } });
          await auditLog({
            actorId: null,
            entityType: 'Payment',
            entityId: paymentId,
            action: 'stripe.webhook.charge.refunded',
            metadata: { stripeChargeId: charge.id }
          });
        }
        break;
      }
      case 'account.updated': {
        // Stripe Connect onboarding status updates.
        const acc = event.data.object;
        const provider = await prisma.providerProfile.findFirst({ where: { stripeAccountId: acc.id } });
        if (provider) {
          await prisma.providerProfile.update({
            where: { id: provider.id },
            data: {
              stripeOnboardingStatus: acc.details_submitted ? 'SUBMITTED' : 'PENDING',
              stripeChargesEnabled: !!acc.charges_enabled,
              stripePayoutsEnabled: !!acc.payouts_enabled,
              stripeOnboardedAt: acc.details_submitted ? new Date() : null
            }
          });

          await auditLog({
            actorId: null,
            entityType: 'ProviderProfile',
            entityId: provider.id,
            action: 'stripe.connect.account.updated',
            metadata: { charges_enabled: acc.charges_enabled, payouts_enabled: acc.payouts_enabled, details_submitted: acc.details_submitted }
          });
        }
        break;
      }
      default:
        // Ignore unhandled events
        break;
    }

    await prisma.webhookEvent.update({
      where: { stripeEventId: event.id },
      data: { processedAt: new Date() }
    });
  } catch (err) {
    return res.status(500).send(`Handler Error: ${err.message}`);
  }

  res.json({ received: true });
}
