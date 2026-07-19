import type { Banner } from './banner.js';

/**
 * Outbound port for durable banner storage.
 *
 * This is the ONLY persistence contract the application layer knows about.
 * Concrete adapters (MongoDB for runtime, in-memory for focused unit tests)
 * live in `infrastructure/persistence` and implement this interface.
 *
 * Implementations must throw `RepositoryError` when the underlying store is
 * unreachable or errors, so the HTTP layer can return a controlled 503.
 */
export interface BannerRepository {
  /**
   * Return every banner that is active at `now`, ordered by descending
   * priority.
   */
  findActive(now: Date): Promise<Banner[]>;
}
