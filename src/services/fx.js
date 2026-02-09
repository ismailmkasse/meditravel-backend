import { prisma } from '../prisma.js';

/**
 * Simple FX service.
 *
 * IMPORTANT: This project intentionally does NOT fetch rates from the web.
 * Rates must be seeded or updated via Admin API (licensed provider, manual entry, etc.).
 */

export async function getLatestRates(base) {
  const b = base.toUpperCase();

  // For each quote, pick latest 'asOf'.
  const rows = await prisma.exchangeRate.findMany({
    where: { base: b },
    orderBy: { asOf: 'desc' },
    take: 500
  });

  const latestByQuote = new Map();
  for (const r of rows) {
    if (!latestByQuote.has(r.quote)) latestByQuote.set(r.quote, r);
  }

  const rates = {};
  let asOf = null;
  for (const [quote, r] of latestByQuote.entries()) {
    rates[quote] = r.rate;
    if (!asOf || r.asOf > asOf) asOf = r.asOf;
  }

  // always include base=1
  rates[b] = 1;
  return { base: b, asOf, rates };
}

export async function convertAmount({ amount, from, to }) {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return { amount, rate: 1, from: f, to: t };

  // We store rates by base. Prefer direct base->quote; else try invert.
  const direct = await prisma.exchangeRate.findFirst({
    where: { base: f, quote: t },
    orderBy: { asOf: 'desc' }
  });
  if (direct) return { amount: amount * direct.rate, rate: direct.rate, from: f, to: t, asOf: direct.asOf };

  const inverse = await prisma.exchangeRate.findFirst({
    where: { base: t, quote: f },
    orderBy: { asOf: 'desc' }
  });
  if (inverse) {
    const rate = 1 / inverse.rate;
    return { amount: amount * rate, rate, from: f, to: t, asOf: inverse.asOf };
  }

  const err = new Error(`No FX rate available for ${f}->${t}.`);
  err.code = 'fx_rate_missing';
  throw err;
}
