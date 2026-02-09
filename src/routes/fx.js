import express from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { authRequired, requireRole } from '../auth.js';
import { getLatestRates, convertAmount } from '../services/fx.js';

const router = express.Router();

// Public: get latest rates for a base
router.get('/rates', async (req, res) => {
  const base = (req.query.base ? String(req.query.base) : 'USD').toUpperCase();
  const data = await getLatestRates(base);
  return res.json(data);
});

// Public: convert an amount using stored latest rates
router.get('/convert', async (req, res) => {
  const amount = Number(req.query.amount || 0);
  const from = String(req.query.from || 'USD');
  const to = String(req.query.to || 'USD');
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'validation' });
  try {
    const out = await convertAmount({ amount, from, to });
    return res.json(out);
  } catch (e) {
    return res.status(404).json({ error: e.code || 'fx_error', message: e.message });
  }
});

// Admin: upsert rate (manual / licensed provider ingestion)
const upsertSchema = z.object({
  base: z.string().min(3).max(3),
  quote: z.string().min(3).max(3),
  rate: z.number().positive(),
  asOf: z.string().datetime().optional()
});

router.post('/admin/rates', authRequired, requireRole('ADMIN'), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const asOf = parsed.data.asOf ? new Date(parsed.data.asOf) : new Date();
  const row = await prisma.exchangeRate.create({
    data: {
      base: parsed.data.base.toUpperCase(),
      quote: parsed.data.quote.toUpperCase(),
      rate: parsed.data.rate,
      asOf
    }
  });

  return res.json(row);
});

export default router;
