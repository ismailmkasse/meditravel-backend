import { prisma } from '../prisma.js';

export async function auditLog({ actorId = null, entityType, entityId, action, metadata = null }) {
  return prisma.auditLog.create({
    data: {
      actorId,
      entityType,
      entityId,
      action,
      metadata
    }
  });
}
