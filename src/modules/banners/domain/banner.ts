/**
 * Core domain entity for a promotional banner.
 *
 * Persistence-agnostic by design: no ODM/driver types (ObjectId, Document,
 * Row) appear here, so the same entity is produced by the MongoDB adapter,
 * the in-memory adapter, or any future adapter.
 */
export interface Banner {
  id: string;
  title: string;
  imageUrl: string;
  targetUrl: string;
  priority: number;
  isActive: boolean;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The business rule for "should this banner be shown right now": it must be
 * enabled and `now` must fall inside its scheduling window. A null start or
 * end date means that side of the window is unbounded.
 *
 * Persistence adapters are free to push this predicate down into the query
 * engine for efficiency (see MongoBannerRepository), but the rule is defined
 * here so it has exactly one authoritative expression.
 */
export function isBannerActiveAt(banner: Banner, now: Date): boolean {
  if (!banner.isActive) return false;
  if (banner.startDate && banner.startDate > now) return false;
  if (banner.endDate && banner.endDate < now) return false;
  return true;
}

/** Display ordering: highest priority first. */
export function byPriorityDescending(a: Banner, b: Banner): number {
  return b.priority - a.priority;
}
