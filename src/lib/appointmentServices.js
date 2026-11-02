const WITH_SERVICES = {
  service: true,
  services: { include: { service: true }, orderBy: { id: 'asc' } },
};

function serviceList(appt) {
  if (appt && Array.isArray(appt.services) && appt.services.length > 0) {
    return appt.services.map((s) => s.service && s.service.name).filter(Boolean);
  }
  return appt && appt.service && appt.service.name ? [appt.service.name] : [];
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

function serviceNames(appt) {
  return joinNames(serviceList(appt));
}

async function resolveServices(db, ids, HttpError) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new HttpError(400, 'Escolha ao menos um serviço.');
  const found = await db.service.findMany({ where: { id: { in: unique }, active: true } });
  const byId = new Map(found.map((s) => [s.id, s]));
  if (unique.some((id) => !byId.has(id))) throw new HttpError(400, 'Algum serviço escolhido não está mais disponível.');
  return unique.map((id) => byId.get(id));
}

function totalDuration(services) {
  return services.reduce((sum, s) => sum + (Number(s.durationMinutes) || 0), 0);
}

module.exports = { WITH_SERVICES, serviceList, joinNames, serviceNames, resolveServices, totalDuration };
