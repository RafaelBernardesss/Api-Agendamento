function normalizeName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function adminNameMatches(name) {
  const expected = normalizeName(process.env.ADMIN_NAME);
  if (!expected) return false;
  return normalizeName(name) === expected;
}

module.exports = { normalizeName, adminNameMatches };
