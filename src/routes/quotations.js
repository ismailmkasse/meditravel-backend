import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { prisma } from '../prisma.js';
import { authRequired, requireRole } from '../auth.js';
import { config } from '../config.js';

const router = express.Router();

fs.mkdirSync(config.uploadDir, { recursive: true });
const upload = multer({ dest: config.uploadDir });

const createSchema = z.object({
  providerId: z.string().min(1),
  procedureId: z.string().min(1),
  notes: z.string().optional(),
  slaHours: z.number().int().min(1).max(168).optional()
});

router.post('/', authRequired, requireRole('USER'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const slaHours = parsed.data.slaHours ?? 24;
  const slaDueAt = new Date(Date.now() + slaHours * 60 * 60 * 1000);

  const q = await prisma.quotationRequest.create({
    data: {
      userId: req.user.sub,
      providerId: parsed.data.providerId,
      procedureId: parsed.data.procedureId,
      notes: parsed.data.notes || null,
      slaHours,
      slaDueAt
    }
  });

  // notify provider
  const provider = await prisma.providerProfile.findUnique({ where: { id: parsed.data.providerId } });
  if (provider) {
    await prisma.notification.create({
      data: {
        userId: provider.userId,
        type: 'quotation.new',
        title: 'New quotation request',
        body: `You received a new quotation request. SLA: ${slaHours}h`
      }
    });
  }

  return res.json(q);
});

// list quotations for user/provider/admin
router.get('/me', authRequired, async (req, res) => {
  const role = req.user.role;
  if (role === 'USER') {
    const list = await prisma.quotationRequest.findMany({
      where: { userId: req.user.sub },
      include: { procedure: true, provider: true }
    });
    return res.json(list);
  }
  if (role === 'PROVIDER') {
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
    if (!profile) return res.status(404).json({ error: 'profile_missing' });
    const list = await prisma.quotationRequest.findMany({
      where: { providerId: profile.id },
      include: { procedure: true, user: { select: { fullName: true, email: true } } }
    });
    return res.json(list);
  }
  // admin
  const list = await prisma.quotationRequest.findMany({
    include: { procedure: true, provider: true, user: { select: { fullName: true, email: true } } }
  });
  return res.json(list);
});

const statusSchema = z.object({
  status: z.enum(['OPEN','IN_REVIEW','RESPONDED','ACCEPTED','DECLINED','EXPIRED','CANCELLED'])
});

router.post('/:id/status', authRequired, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const q = await prisma.quotationRequest.findUnique({ where: { id: req.params.id }, include: { provider: true } });
  if (!q) return res.status(404).json({ error: 'not_found' });

  // authorization: user owns OR provider owns OR admin
  const role = req.user.role;
  if (role === 'USER' && q.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });
  if (role === 'PROVIDER') {
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
    if (!profile || profile.id !== q.providerId) return res.status(403).json({ error: 'forbidden' });
  }

  const updated = await prisma.quotationRequest.update({
    where: { id: q.id },
    data: { status: parsed.data.status }
  });

  // notifications
  if (parsed.data.status === 'RESPONDED') {
    await prisma.notification.create({
      data: {
        userId: updated.userId,
        type: 'quotation.responded',
        title: 'Quotation responded',
        body: 'Your quotation request has been responded to. Open the chat for details.'
      }
    });
  }

  return res.json(updated);
});

// attachments upload
router.post('/:id/attachments', authRequired, upload.array('files', 5), async (req, res) => {
  const q = await prisma.quotationRequest.findUnique({ where: { id: req.params.id } });
  if (!q) return res.status(404).json({ error: 'not_found' });
  if (req.user.role === 'USER' && q.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });

  const files = req.files || [];
  const created = [];
  for (const f of files) {
    const fileName = f.originalname || path.basename(f.path);
    const record = await prisma.quotationAttachment.create({
      data: {
        quotationId: q.id,
        fileName,
        mimeType: f.mimetype || 'application/octet-stream',
        sizeBytes: f.size,
        storagePath: f.path
      }
    });
    created.push(record);
  }
  return res.json({ uploaded: created.length, attachments: created });
});

// chat messages
const msgSchema = z.object({ body: z.string().min(1).max(2000) });

router.get('/:id/messages', authRequired, async (req, res) => {
  const q = await prisma.quotationRequest.findUnique({ where: { id: req.params.id } });
  if (!q) return res.status(404).json({ error: 'not_found' });

  // check access
  if (req.user.role === 'USER' && q.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'PROVIDER') {
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
    if (!profile || profile.id !== q.providerId) return res.status(403).json({ error: 'forbidden' });
  }

  const msgs = await prisma.quotationMessage.findMany({
    where: { quotationId: q.id },
    orderBy: { createdAt: 'asc' },
    include: { sender: { select: { fullName: true, role: true } } }
  });
  return res.json(msgs);
});

router.post('/:id/messages', authRequired, async (req, res) => {
  const parsed = msgSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const q = await prisma.quotationRequest.findUnique({ where: { id: req.params.id }, include: { provider: true } });
  if (!q) return res.status(404).json({ error: 'not_found' });

  // check access
  if (req.user.role === 'USER' && q.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'PROVIDER') {
    const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
    if (!profile || profile.id !== q.providerId) return res.status(403).json({ error: 'forbidden' });
  }

  const msg = await prisma.quotationMessage.create({
    data: { quotationId: q.id, senderId: req.user.sub, body: parsed.data.body }
  });

  // notify the other party
  const receiverUserId =
    req.user.role === 'USER' ? q.provider.userId : q.userId;

  await prisma.notification.create({
    data: {
      userId: receiverUserId,
      type: 'chat.new',
      title: 'New message',
      body: parsed.data.body.length > 120 ? parsed.data.body.slice(0, 120) + '…' : parsed.data.body
    }
  });

  return res.json(msg);
});

export default router;
