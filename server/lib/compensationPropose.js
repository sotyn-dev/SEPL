// Pure propose/check for Pay & Compensation fields.
// Captions / future Apply read this; nothing here writes employee rows.
// Keep in sync with client/src/utils/compensationPropose.js

const { ESI_GROSS_CEILING } = require('./employeeValidation');

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function differs(a, b) {
  if (!(b > 0) || !(a > 0)) return false;
  return Math.abs(a - b) > Math.max(1, b * 0.01);
}

function isPositiveSet(v) {
  return v !== '' && v !== null && v !== undefined && Number(v) > 0;
}

/**
 * @param {object} row — employee form / flat row with salary + compensation cols
 * @returns {object} numbers/nulls/bools only (no currency formatting)
 */
function proposeCompensation(row = {}) {
  const salary = n(row.salary);
  const ctc = n(row.ctc_annual);
  const gross = n(row.fixed_monthly_gross);
  const basic = n(row.basic_pay);
  const hra = n(row.hra);
  const special = n(row.special_allowance);

  const ctcMonthly = ctc > 0 ? ctc / 12 : null;
  let proposedMonthly = null;
  let proposedMonthlySource = null;
  if (gross > 0) {
    proposedMonthly = gross;
    proposedMonthlySource = 'gross';
  } else if (ctcMonthly != null) {
    proposedMonthly = ctcMonthly;
    proposedMonthlySource = 'ctc';
  }

  const splitSum = basic + hra + special;
  const splitPartsSet = isPositiveSet(row.basic_pay) || isPositiveSet(row.hra) || isPositiveSet(row.special_allowance);

  const structureEmpty = !(ctc > 0) && !(gross > 0);
  const payrollSeedMonthly = structureEmpty && salary > 0 ? salary : null;
  const ctcSeedAnnual = !(ctc > 0) && salary > 0 ? salary * 12 : null;

  const esiNotEligible = gross > ESI_GROSS_CEILING;
  const esiSuggested = gross > 0 && !esiNotEligible ? gross * 0.0075 : null;

  return {
    proposedMonthly,
    proposedMonthlySource,
    ctcMonthly,
    splitSum,
    splitPartsSet,
    salaryDiffers: proposedMonthly != null && salary > 0 && differs(salary, proposedMonthly),
    splitDiffers: gross > 0 && splitPartsSet && differs(splitSum, gross),
    pfSuggested: basic > 0 ? basic * 0.12 : null,
    esiSuggested,
    esiNotEligible: gross > 0 && esiNotEligible,
    payrollSeedMonthly,
    ctcSeedAnnual,
    salary,
    gross,
    ctc,
  };
}

module.exports = { proposeCompensation, ESI_GROSS_CEILING };
