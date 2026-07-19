import { byPriorityDescending, isBannerActiveAt, type Banner } from '../../domain/banner.js';
import type { BannerRepository } from '../../domain/banner-repository.js';

/**
 * In-memory {@link BannerRepository}, retained for focused unit tests only.
 *
 * The runtime (and every Docker environment) uses
 * {@link import('./mongo-banner-repository.js').MongoBannerRepository}; this
 * adapter exists so service-level tests can exercise cache, collapsing, and
 * fail-open behavior without standing up a database.
 *
 * It applies the same domain rules as the Mongo adapter — the shared
 * predicate in `domain/banner.ts` — so the two stay behaviorally aligned.
 */
export class InMemoryBannerRepository implements BannerRepository {
  public constructor(private banners: Banner[] = []) {}

  public async findActive(now: Date): Promise<Banner[]> {
    return this.banners
      .filter((banner) => isBannerActiveAt(banner, now))
      .sort(byPriorityDescending);
  }

  /** Test helper: swap the backing data between assertions. */
  public setBanners(banners: Banner[]): void {
    this.banners = banners;
  }
}
