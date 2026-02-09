import { PrismaClient, Role, ProviderType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminPass = await bcrypt.hash('admin1234', 10);
  const providerPass = await bcrypt.hash('provider1234', 10);
  const userPass = await bcrypt.hash('user1234', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@meditravel.local' },
    update: {},
    create: {
      email: 'admin@meditravel.local',
      fullName: 'Admin',
      passwordHash: adminPass,
      role: Role.ADMIN
    }
  });

  const providerUser = await prisma.user.upsert({
    where: { email: 'provider@meditravel.local' },
    update: {},
    create: {
      email: 'provider@meditravel.local',
      fullName: 'Demo Provider',
      passwordHash: providerPass,
      role: Role.PROVIDER
    }
  });

  const providerProfile = await prisma.providerProfile.upsert({
    where: { userId: providerUser.id },
    update: {},
    create: {
      userId: providerUser.id,
      type: ProviderType.CLINIC,
      displayName: 'Istanbul Aesthetic Center',
      countryCode: 'TR',
      city: 'Istanbul',
      verified: true
    }
  });

  const user = await prisma.user.upsert({
    where: { email: 'user@meditravel.local' },
    update: {},
    create: {
      email: 'user@meditravel.local',
      fullName: 'Demo User',
      passwordHash: userPass,
      role: Role.USER
    }
  });

  await prisma.procedure.createMany({
    data: [
      {
        providerId: providerProfile.id,
        name: 'Hair Transplant (FUE)',
        category: 'Hair',
        priceMinUSD: 1500,
        priceMaxUSD: 2500,
        description: 'FUE hair transplant package estimate. Final price after review.'
      },
      {
        providerId: providerProfile.id,
        name: 'Rhinoplasty',
        category: 'Cosmetic Surgery',
        priceMinUSD: 2200,
        priceMaxUSD: 3800,
        description: 'Nose reshaping. Final price depends on complexity.'
      }
    ],
    skipDuplicates: true
  });

  // Seed a minimal FX table (for demo only). In production, update rates from a licensed provider.
  const asOf = new Date();
  await prisma.exchangeRate.createMany({
    data: [
      { base: 'USD', quote: 'EUR', rate: 0.92, asOf },
      { base: 'USD', quote: 'GBP', rate: 0.79, asOf },
      { base: 'USD', quote: 'TRY', rate: 31.5, asOf },
      { base: 'USD', quote: 'TND', rate: 3.1, asOf }
    ],
    skipDuplicates: true
  });

  const proc = await prisma.procedure.findFirst({ where: { providerId: providerProfile.id } });
  if (proc) {
    const existing = await prisma.quotationRequest.findFirst({ where: { userId: user.id, procedureId: proc.id } });
    if (!existing) {
      const slaDueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const q = await prisma.quotationRequest.create({
        data: {
          userId: user.id,
          providerId: providerProfile.id,
          procedureId: proc.id,
          notes: 'I want to schedule within the next month. Budget under 3000 USD.',
          slaHours: 24,
          slaDueAt
        }
      });

      await prisma.quotationMessage.create({
        data: {
          quotationId: q.id,
          senderId: user.id,
          body: 'Hello, can you confirm what is included in the package?'
        }
      });

      await prisma.notification.create({
        data: {
          userId: providerUser.id,
          type: 'quotation.new',
          title: 'New quotation request',
          body: `New quotation request for ${proc.name}`
        }
      });
    }
  }

  console.log('Seed complete.');
  console.log('Demo accounts:');
  console.log('Admin: admin@meditravel.local / admin1234');
  console.log('Provider: provider@meditravel.local / provider1234');
  console.log('User: user@meditravel.local / user1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
