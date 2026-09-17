export type CohortPosition = { latitude: number; longitude: number };
export type CohortRecord = { id: string; position: CohortPosition };
export type CohortQuery = { latitude: number; longitude: number };

export function cohortDistanceScore(record: CohortRecord, query: CohortQuery) {
  const latScale = Math.cos(query.latitude * Math.PI / 180);
  const dLat = record.position.latitude - query.latitude;
  const dLon = (record.position.longitude - query.longitude) * Math.max(0.2, latScale);
  return dLat * dLat + dLon * dLon;
}

export function selectNearestCohort<T extends CohortRecord>(
  records: Iterable<T>,
  query: CohortQuery,
  budget: number,
  pinnedId?: string | null,
): T[] {
  const safeBudget = Math.max(0, Math.floor(budget));
  if (!safeBudget) return [];
  const all = Array.from(records);
  const cohort = all
    .slice()
    .sort((a, b) => cohortDistanceScore(a, query) - cohortDistanceScore(b, query))
    .slice(0, safeBudget);
  if (!pinnedId || cohort.some((record) => record.id === pinnedId)) return cohort;
  const pinned = all.find((record) => record.id === pinnedId);
  if (!pinned) return cohort;
  if (cohort.length >= safeBudget) cohort[cohort.length - 1] = pinned;
  else cohort.push(pinned);
  return cohort;
}
