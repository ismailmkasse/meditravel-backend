import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'fs';
import { prisma } from '../prisma.js';
import { authRequired, requireRole } from '../auth.js';
import { config } from '../config.js';
import { auditLog } from '../services/audit.js';

const router = express.Router();

// Verification docs upload directory
const verificationDir = `${config.uploadDir}/provider-verification`;
fs.mkdirSync(verificationDir, { recursive: true });
const upload = multer({ dest: verificationDir, limits: { fileSize: 10 * 1024 * 1024 } });

// public list of verified providers
router.get('/', async (req, res) => {
  const { countryCode } = req.query;
  const providers = await prisma.providerProfile.findMany({
    where: { verified: true, ...(countryCode ? { countryCode: String(countryCode) } : {}) },
    include: { user: { select: { fullName: true, email: true } } }
  });
  return res.json(providers);
});

// provider self profile update
const updateSchema = z.object({
  displayName: z.string().min(2).optional(),
  type: z.enum(['HOTEL','CLINIC','TOUR','TRANSPORT']).optional(),
  countryCode: z.string().min(2).max(2).optional(),
  city: z.string().min(1).optional()
});

router.put('/me', authRequired, requireRole('PROVIDER'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const userId = req.user.sub;
  const profile = await prisma.providerProfile.findUnique({ where: { userId } });
  if (!profile) return res.status(404).json({ error: 'profile_missing' });

  const updated = await prisma.providerProfile.update({
    where: { id: profile.id },
    data: parsed.data
  });

  await auditLog({
    actorId: req.user.sub,
    entityType: 'ProviderProfile',
    entityId: updated.id,
    action: 'provider.profile.update',
    metadata: parsed.data
  });
  return res.json(updated);
});

// Provider: upload verification document
const docSchema = z.object({
  docType: z.string().min(2).max(64)
});

router.post('/verification-docs', authRequired, requireRole('PROVIDER'), upload.single('file'), async (req, res) => {
  const parsed = docSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });
  if (!req.file) return res.status(400).json({ error: 'file_required' });

  const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
  if (!profile) return res.status(404).json({ error: 'profile_missing' });

  const doc = await prisma.providerVerificationDoc.create({
    data: {
      providerId: profile.id,
      docType: parsed.data.docType,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      storagePath: req.file.path,
      status: 'PENDING'
    }
  });

  await auditLog({
    actorId: req.user.sub,
    entityType: 'ProviderVerificationDoc',
    entityId: doc.id,
    action: 'provider.doc.upload',
    metadata: { docType: doc.docType, fileName: doc.fileName }
  });

  // Notify admins (simple broadcast: all admin users)
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  for (const a of admins) {
    await prisma.notification.create({
      data: {
        userId: a.id,
        type: 'provider.doc.pending',
        title: 'Provider document pending review',
        body: `${profile.displayName} uploaded a verification document (${doc.docType}).`
      }
    });
  }

  return res.json(doc);
});

// Provider: list own docs
router.get('/verification-docs/me', authRequired, requireRole('PROVIDER'), async (req, res) => {
  const profile = await prisma.providerProfile.findUnique({ where: { userId: req.user.sub } });
  if (!profile) return res.status(404).json({ error: 'profile_missing' });
  const docs = await prisma.providerVerificationDoc.findMany({
    where: { providerId: profile.id },
    orderBy: { createdAt: 'desc' }
  });
  return res.json(docs);
});

// Admin: verification queue
router.get('/admin/pending', authRequired, requireRole('ADMIN'), async (req, res) => {
  const pending = await prisma.providerProfile.findMany({
    where: { verified: false },
    include: { user: { select: { fullName: true, email: true } } }
  });
  return res.json(pending);
});

// Admin: list verification docs queue
router.get('/admin/verification-docs', authRequired, requireRole('ADMIN'), async (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : 'PENDING';
  const docs = await prisma.providerVerificationDoc.findMany({
    where: { status },
    include: { provider: { include: { user: { select: { fullName: true, email: true } } } } },
    orderBy: { createdAt: 'desc' }
  });
  return res.json(docs);
});

// Admin: download a verification doc file (for review)
router.get('/admin/verification-docs/:docId/file', authRequired, requireRole('ADMIN'), async (req, res) => {
  const doc = await prisma.providerVerificationDoc.findUnique({ where: { id: req.params.docId } });
  if (!doc) return res.status(404).json({ error: 'not_found' });
  return res.sendFile(doc.storagePath, { root: process.cwd() });
});

const docReviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().optional()
});

router.post('/admin/verification-docs/:docId/review', authRequired, requireRole('ADMIN'), async (req, res) => {
  const parsed = docReviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const doc = await prisma.providerVerificationDoc.findUnique({ where: { id: req.params.docId }, include: { provider: true } });
  if (!doc) return res.status(404).json({ error: 'not_found' });

  const newStatus = parsed.data.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const updatedDoc = await prisma.providerVerificationDoc.update({
    where: { id: doc.id },
    data: {
      status: newStatus,
      reviewedById: req.user.sub,
      reviewedAt: new Date(),
      reviewNote: parsed.data.note || null
    }
  });

  await auditLog({
    actorId: req.user.sub,
    entityType: 'ProviderVerificationDoc',
    entityId: doc.id,
    action: `provider.doc.${newStatus.toLowerCase()}`,
    metadata: { note: parsed.data.note || null }
  });

  // Optional: auto-verify provider if at least 1 doc approved
  if (newStatus === 'APPROVED') {
    const approvedCount = await prisma.providerVerificationDoc.count({ where: { providerId: doc.providerId, status: 'APPROVED' } });
    if (approvedCount >= 1 && !doc.provider.verified) {
      await prisma.providerProfile.update({ where: { id: doc.providerId }, data: { verified: true } });
      await auditLog({
        actorId: req.user.sub,
        entityType: 'ProviderProfile',
        entityId: doc.providerId,
        action: 'provider.auto_verified',
        metadata: { reason: 'approved_doc', approvedCount }
      });
      await prisma.notification.create({
        data: {
          userId: doc.provider.userId,
          type: 'provider.verification',
          title: 'Provider verified',
          body: 'Your provider account is now verified (document approved).'
        }
      });
    }
  }

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: doc.provider.userId,
      type: 'provider.doc.reviewed',
      title: `Verification document ${newStatus.toLowerCase()}`,
      body: parsed.data.note || `Your document was ${newStatus.toLowerCase()}.`
    }
  });

  return res.json(updatedDoc);
});

// Admin: audit log viewer
router.get('/admin/audit-logs', authRequired, requireRole('ADMIN'), async (req, res) => {
  const take = Math.min(200, Math.max(1, Number(req.query.take || 50)));
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: { actor: { select: { email: true, fullName: true, role: true } } }
  });
  return res.json(logs);
});

const verifySchema = z.object({
  verified: z.boolean(),
  note: z.string().optional()
});

router.post('/admin/:providerId/verify', authRequired, requireRole('ADMIN'), async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation', details: parsed.error.flatten() });

  const providerId = req.params.providerId;
  const updated = await prisma.providerProfile.update({
    where: { id: providerId },
    data: { verified: parsed.data.verified, verificationNote: parsed.data.note || null }
  });

  await auditLog({
    actorId: req.user.sub,
    entityType: 'ProviderProfile',
    entityId: updated.id,
    action: updated.verified ? 'provider.manual_verified' : 'provider.manual_rejected',
    metadata: { note: parsed.data.note || null }
  });

  // notify provider user
  await prisma.notification.create({
    data: {
      userId: updated.userId,
      type: 'provider.verification',
      title: updated.verified ? 'Provider verified' : 'Provider verification rejected',
      body: updated.verified ? 'Your provider account is now verified.' : (parsed.data.note || 'Verification rejected.')
    }
  });

  return res.json(updated);
});

export default router;
