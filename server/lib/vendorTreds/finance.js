// Financial terms are estimates. An actual bank receipt is never inferred from them.
const missing = value => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

function validatePaise(value, field = 'amount', { positive = false } = {}) {
  if (missing(value)) return null;
  if (!['number','string'].includes(typeof value)) throw new Error(`${field} must be an integer amount in paise`);
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || (positive && amount === 0)) {
    throw new Error(`${field} must be ${positive ? 'a positive' : 'a non-negative'} safe integer in paise`);
  }
  return amount;
}
function roundedDiscount(principal, rate, basis, term, dayBasis) {
  // Keep integer currency exact even near Number.MAX_SAFE_INTEGER.
  const [mantissa, exponentText] = String(rate).toLowerCase().split('e');
  const exponent = Number(exponentText || 0);
  const decimals = (mantissa.split('.')[1] || '').length;
  let numerator = BigInt(mantissa.replace('.',''));
  let denominator = 100n;
  const scale = decimals - exponent;
  if (scale >= 0) denominator *= 10n ** BigInt(scale); else numerator *= 10n ** BigInt(-scale);
  numerator *= BigInt(principal);
  if (basis === 'annualized') { numerator *= BigInt(term); denominator *= BigInt(dayBasis); }
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Calculated discount is outside the supported monetary range');
  return Number(rounded);
}

function calculateFundingTerms(input = {}) {
  const principal = validatePaise(input.principal_paise, 'principal_paise', { positive: true });
  const explicitDiscount = validatePaise(input.discount_paise, 'discount_paise');
  const fees = validatePaise(input.fees_paise, 'fees_paise');
  const taxes = validatePaise(input.taxes_paise, 'taxes_paise');
  const actual = validatePaise(input.actual_received_paise, 'actual_received_paise');
  const basis = missing(input.basis) ? null : String(input.basis);
  if (basis !== null && !['flat', 'annualized'].includes(basis)) throw new Error('basis must be flat or annualized');
  if (!missing(input.discount_rate) && !['number','string'].includes(typeof input.discount_rate)) throw new Error('discount_rate must be numeric');
  const rate = missing(input.discount_rate) ? null : Number(input.discount_rate);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) throw new Error('discount_rate must be between 0 and 100');
  const term = missing(input.term_days) ? null : Number(input.term_days);
  if (term !== null && (!Number.isSafeInteger(term) || term < 0)) throw new Error('term_days must be a non-negative integer');
  const dayBasis = missing(input.day_basis) ? null : Number(input.day_basis);
  if (dayBasis !== null && ![360, 365].includes(dayBasis)) throw new Error('day_basis must be 360 or 365');

  let discount = explicitDiscount;
  const complete = principal !== null && rate !== null && basis !== null
    && (basis === 'flat' || (term !== null && dayBasis !== null));
  if (complete) {
    const calculated = roundedDiscount(principal, rate, basis, term, dayBasis);
    if (explicitDiscount !== null && Math.abs(explicitDiscount - calculated) > 1) {
      throw new Error('discount_paise does not match the supplied financial terms');
    }
    discount = explicitDiscount === null ? calculated : explicitDiscount;
  }
  if (principal !== null && discount !== null && discount > principal) throw new Error('Discount cannot exceed the financed principal');
  let expected = null;
  if (principal !== null && discount !== null && fees !== null && taxes !== null) {
    expected = principal - discount - fees - taxes;
    if (expected < 0) throw new Error('Discount and charges cannot exceed the financed principal');
  }
  return {
    principal_paise: principal, discount_rate: rate, basis, term_days: term,
    day_basis: dayBasis, discount_paise: discount, fees_paise: fees,
    taxes_paise: taxes, expected_net_paise: expected,
    ...(Object.hasOwn(input, 'actual_received_paise') ? { actual_received_paise: actual } : {}),
  };
}

module.exports = { validatePaise, calculateFundingTerms, calculateFunding: calculateFundingTerms, normalizeFunding: calculateFundingTerms };
