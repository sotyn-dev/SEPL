// Only map a known website option. Never infer the trade from free-text notes.
const CONSULTANCY_SERVICE = 'MEP design / BOQ / tender support';

function websiteCategory(service) {
  const value = String(service || '').trim();
  return value === CONSULTANCY_SERVICE ? 'MEP' : value || null;
}

function explicitLocation(body, ...keys) {
  for (const key of keys) {
    if (typeof body?.[key] === 'string' && body[key].trim()) {
      return body[key].replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    }
  }
  return null;
}

// Conservative historical repair: fill blank location fields from the saved
// payload; normalise only the exact known service label, never a manual category.
function proposedWebsiteCorrections(row, payload) {
  const changes = {};
  for (const field of ['state', 'district']) {
    const value = explicitLocation(payload, `project_${field}`, field);
    if (!String(row[field] || '').trim() && value) changes[field] = value;
  }
  if (row.category === CONSULTANCY_SERVICE) changes.category = 'MEP';
  return changes;
}

module.exports = { websiteCategory, explicitLocation, proposedWebsiteCorrections, CONSULTANCY_SERVICE };
