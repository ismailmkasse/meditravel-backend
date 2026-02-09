import express from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { authRequired, requireRole } from '../auth.js';

const router = express.Router();

// public: procedures for a provider
router.get('/', async (req, res) => {
  const { providerId } = req.query;
  const where = { active: true };
  if (providerId) where.providerId = String(providerId);
  const list = await prisma.procedure.findMany({ where });
  return res.json(list);
});

// provider: manage own procedures
const upsertSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2),
  category: z.string().min(1),
  priceMinUSD: z.number().int().min(0),
  priceMaxUSD: z.number().int().min(0),
  description: z.string().optional(),
  active: z.boolean().optional()
});

router.post('/me', authRequired, requireRole('PROVIDER'), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
  if (!profile) return res.status(404).json({ error: 'profile_missing' });

  const data = { ...parsed.data };
  delete data.id;

  let procedure;
  if (parsed.data.id) {
    procedure = await prisma.procedure.update({
      where: { id: parsed.data.id },
      data,
    });
  } else {
    procedure = await prisma.procedure.create({
      data: { ...data, providerId: profile.id }
    });
  }
  return res.json(procedure);
});

router.get('/me', authRequired, requireRole('PROVIDER'), async (req, res) => {
  const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
  if (!profile) return res.status(404).json({ error: 'profile_missing' });
  const list = await prisma.procedure.findMany({ where: { providerId: profile.id } });
  return res.json(list);
});

export default router;
