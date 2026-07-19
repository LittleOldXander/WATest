import type { Collection, Db, Filter, Sort } from 'mongodb';
import type { Banner } from '../../domain/banner.js';
import type { BannerRepository } from '../../domain/banner-repository.js';
import { RepositoryError } from '../../../../shared/errors/application-error.js';

export const BANNERS_COLLECTION = 'banners';

/**
 * Persisted shape of a banner document.
 *
 * The banner's UUID is stored as `_id` (MongoDB accepts string `_id`s), which
 * gives us the primary-key uniqueness index for free and avoids carrying a
 * duplicate identifier field.
 *
 * Dates are stored as native BSON dates, not strings, so range queries on
 * `startDate`/`endDate` can use indexes.
 */
export interface BannerDocument {
  _id: string;
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
 * MongoDB adapter for {@link BannerRepository}, built on the official
 * `mongodb` Node.js driver.
 *
 * The active-banner predicate is pushed down into the query so the database
 * returns only what is needed, served by the compound index created in
 * `docker/mongo-init/001-init-banners.js`:
 *
 *     { isActive: 1, startDate: 1, endDate: 1, priority: -1 }
 *
 * Any driver/connection failure is translated into {@link RepositoryError},
 * which the HTTP layer maps to a controlled `503` — MongoDB being down must
 * never surface a raw driver stack trace to a caller.
 */
export class MongoBannerRepository implements BannerRepository {
  private readonly collection: Collection<BannerDocument>;

  public constructor(db: Db, collectionName: string = BANNERS_COLLECTION) {
    this.collection = db.collection<BannerDocument>(collectionName);
  }

  public async findActive(now: Date): Promise<Banner[]> {
    const filter: Filter<BannerDocument> = {
      isActive: true,
      $and: [
        { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
        { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
      ],
    };

    // Highest priority first; `_id` breaks ties deterministically so repeated
    // requests (and cached payloads) are byte-stable.
    const sort: Sort = { priority: -1, _id: 1 };

    try {
      const documents = await this.collection.find(filter).sort(sort).toArray();
      return documents.map(toDomain);
    } catch (error) {
      throw new RepositoryError('Failed to load active banners from MongoDB', error);
    }
  }
}

/** Maps a persisted document to the persistence-agnostic domain entity. */
export function toDomain(document: BannerDocument): Banner {
  return {
    id: document._id,
    title: document.title,
    imageUrl: document.imageUrl,
    targetUrl: document.targetUrl,
    priority: document.priority,
    isActive: document.isActive,
    startDate: document.startDate ?? null,
    endDate: document.endDate ?? null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}
