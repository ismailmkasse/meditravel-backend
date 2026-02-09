import express from 'express';
import { prisma } from '../prisma.js';
import { computePriceConfidence } from '../services/confidence.js';
import { convertAmount } from '../services/fx.js';

const router = express.Router();

// Pricing endpoint for a procedure:
// - returns USD price range
// - optionally converts to another currency using stored FX rates
// - returns confidence score
router.get('/procedure/:procedureId', async (req, res) => {
  const procedure = await prisma.procedure.findUnique({ where: { id: req.params.procedureId } });
  if (!procedure) return res.status(404).json({ error: 'not_found' });

  const currency = (req.query.currency ? String(req.query.currency) : 'USD').toUpperCase();

  const source = 'PROVIDER'; // provider-entered range
  const lastUpdatedDays = 0; // we don't track per-procedure updatedAt in schema; treat as fresh
  const conf = computePriceConfidence({ source, lastUpdatedDays, sampleSize: 10 });

  const usd = { min: procedure.priceMinUSD, max: procedure.priceMaxUSD, currency: 'USD' };
  if (currency === 'USD') {
    return res.json({ procedureId: procedure.id, range: usd, confidence: conf, source, disclaimer: 'Health pricing is indicative. Final price after medical review/quotation.' });
  }

  try {
    const minConv = await convertAmount({ amount: procedure.priceMinUSD, from: 'USD', to: currency });
    const maxConv = await convertAmount({ amount: procedure.priceMaxUSD, from: 'USD', to: currency });
    return res.json({
      procedureId: procedure.id,
      range: { min: minConv.amount, max: maxConv.amount, currency },
      fx: { rateMin: minConv.rate, rateMax: maxConv.rate, asOf: minConv.asOf || maxConv.asOf },
      confidence: conf,
      source,
      disclaimer: 'Health pricing is indicative. Final price after medical review/quotation.'
    });
  } catch (e) {
    // If FX missing, fall back to USD but with lower confidence.
    const conf2 = computePriceConfidence({ source: 'ESTIMATE', lastUpdatedDays: 999, sampleSize: 0 });
    return res.json({
      procedureId: procedure.id,
      range: usd,
      confidence: conf2,
      source: 'ESTIMATE',
      warning: `FX rate missing for USD->${currency}. Showing USD.`
    });
  }
});

export default router;
