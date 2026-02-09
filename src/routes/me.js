import express from 'express';
import { prisma } from '../prisma.js';
import { authRequired } from '../auth.js';

const router = express.Router();

router.get('/me', authRequired, async (req, res) => {
  const userId = req.user.sub;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { providerProfile: true }
  });
  if (!user) return res.status(404).json({ error: 'not_found' });
  return res.json({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    providerProfile: user.providerProfile
  });
});

export default router;
