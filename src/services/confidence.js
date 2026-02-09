/**
 * Price confidence scoring (0-100)
 * - Exact from API/provider (fresh) = high
 * - Derived from recent historical quotes/bookings = medium
 * - Market estimate / sparse data = low
 */

export function computePriceConfidence({
  source = 'ESTIMATE',
  lastUpdatedDays = 999,
  sampleSize = 0
} = {}) {
  let base = 30;

  if (source === 'PROVIDER' || source === 'API') base = 90;
  else if (source === 'HISTORICAL') base = 65;
  else if (source === 'ESTIMATE') base = 40;

  // recency penalty
  const recencyPenalty = Math.min(40, Math.max(0, lastUpdatedDays - 2) * 2);

  // sample bonus (quotes/bookings count)
  const sampleBonus = Math.min(20, Math.floor(Math.log10(Math.max(1, sampleSize)) * 10));

  const score = Math.round(Math.max(0, Math.min(100, base - recencyPenalty + sampleBonus)));
  const label = score >= 80 ? 'HIGH' : score >= 55 ? 'MEDIUM' : 'LOW';
  return { score, label };
}
