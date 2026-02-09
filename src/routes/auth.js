import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { signJwt } from '../auth.js';

const router = express.Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2),
  role: z.enum(['USER','PROVIDER']).optional()
});

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const { email, password, fullName, role } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'email_exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      email,
      fullName,
      passwordHash,
      role: role === 'PROVIDER' ? 'PROVIDER' : 'USER'
    }
  });

  // auto-create provider profile skeleton if provider
  if (user.role === 'PROVIDER') {
    await prisma.providerProfile.create({
      data: {
        userId: user.id,
        type: 'CLINIC',
        displayName: `${user.fullName} (Provider)`,
        countryCode: 'TR',
        city: 'Istanbul',
        verified: false,
        verificationNote: 'Pending verification'
      }
    });
  }

  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  return res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  return res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } });
});

export default router;
