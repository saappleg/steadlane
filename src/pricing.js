export const DEFAULT_RATES = Object.freeze({ baseFare: 3, perMile: 1.8, perMinute: 0.3, minimumFare: 8, bookingFee: 1 });

export function calculateFare({ distanceMiles, durationMinutes }, rates = DEFAULT_RATES) {
  const numbers = [distanceMiles, durationMinutes, rates.baseFare, rates.perMile, rates.perMinute, rates.minimumFare, rates.bookingFee];
  if (!numbers.every(Number.isFinite) || numbers.some(n => n < 0)) throw new Error("Fare inputs must be finite, nonnegative numbers");
  const subtotal = Math.max(rates.minimumFare, rates.baseFare + distanceMiles * rates.perMile + durationMinutes * rates.perMinute);
  return Math.round((subtotal + rates.bookingFee) * 100) / 100;
}
