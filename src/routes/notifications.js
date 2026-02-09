import express from 'express';
import { prisma } from '../prisma.js';
import { authRequired } from '../auth.js';

const router = express.Router();

router.get('/me', authRequired, async (req, res) => {
  const list = await prisma.notification.findMany({
    where: { userId: req.user.sub },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  return res.json(list);
});

router.post('/:id/read', authRequired, async (req, res) => {
  const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!n) return res.status(404).json({ error: 'not_found' });
  if (n.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });

  const updated = await prisma.notification.update({
    where: { id: n.id },
    data: { readAt: new Date() }
  });
  return res.json(updated);
});

export default router;
