import type { Db, Filter } from 'mongodb';
import {
  MongoBannerRepository,
  toDomain,
  type BannerDocument,
} from '../../../../src/modules/banners/infrastructure/persistence/mongo-banner-repository.js';
import { RepositoryError } from '../../../../src/shared/errors/application-error.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function makeDocument(overrides: Partial<BannerDocument> = {}): BannerDocument {
  return {
    _id: 'doc-1',
    title: 'Doc Banner',
    imageUrl: 'https://cdn.example.com/doc.png',
    targetUrl: 'https://example.com/doc',
    priority: 10,
    isActive: true,
    startDate: null,
    endDate: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Minimal stand-in for the driver's fluent `find().sort().toArray()` chain,
 * capturing what the repository asked for so we can assert the query is
 * pushed down rather than filtered in application code.
 */
function makeFakeDb(options: { documents?: BannerDocument[]; failWith?: Error }) {
  const captured: { filter?: Filter<BannerDocument>; sort?: unknown } = {};

  const db = {
    collection: () => ({
      find: (filter: Filter<BannerDocument>) => {
        captured.filter = filter;
        return {
          sort: (sort: unknown) => {
            captured.sort = sort;
            return {
              toArray: async (): Promise<BannerDocument[]> => {
                if (options.failWith) throw options.failWith;
                return options.documents ?? [];
              },
            };
          },
        };
      },
    }),
  } as unknown as Db;

  return { db, captured };
}

describe('toDomain', () => {
  it('maps _id to the domain id and preserves dates', () => {
    const banner = toDomain(
      makeDocument({
        _id: 'abc-123',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
      }),
    );

    expect(banner.id).toBe('abc-123');
    expect(banner).not.toHaveProperty('_id');
    expect(banner.startDate).toEqual(new Date('2026-05-01T00:00:00.000Z'));
    expect(banner.createdAt).toBeInstanceOf(Date);
  });

  it('normalizes missing schedule bounds to null', () => {
    const banner = toDomain(makeDocument({ startDate: null, endDate: null }));
    expect(banner.startDate).toBeNull();
    expect(banner.endDate).toBeNull();
  });
});

describe('MongoBannerRepository', () => {
  it('pushes the active-banner predicate down into the query', async () => {
    const { db, captured } = makeFakeDb({ documents: [] });
    await new MongoBannerRepository(db).findActive(NOW);

    expect(captured.filter).toEqual({
      isActive: true,
      $and: [
        { $or: [{ startDate: null }, { startDate: { $lte: NOW } }] },
        { $or: [{ endDate: null }, { endDate: { $gte: NOW } }] },
      ],
    });
  });

  it('sorts by descending priority so the database serves the ordering', async () => {
    const { db, captured } = makeFakeDb({ documents: [] });
    await new MongoBannerRepository(db).findActive(NOW);

    expect(captured.sort).toEqual({ priority: -1, _id: 1 });
  });

  it('maps returned documents to domain entities', async () => {
    const { db } = makeFakeDb({
      documents: [makeDocument({ _id: 'a', priority: 5 }), makeDocument({ _id: 'b', priority: 1 })],
    });

    const banners = await new MongoBannerRepository(db).findActive(NOW);

    expect(banners.map((banner) => banner.id)).toEqual(['a', 'b']);
    expect(banners[0]).not.toHaveProperty('_id');
  });

  it('wraps driver failures in RepositoryError so the API can return a controlled 503', async () => {
    const { db } = makeFakeDb({ failWith: new Error('connection refused') });

    await expect(new MongoBannerRepository(db).findActive(NOW)).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });

  it('preserves the underlying driver error as the cause', async () => {
    const underlying = new Error('server selection timed out');
    const { db } = makeFakeDb({ failWith: underlying });

    await expect(new MongoBannerRepository(db).findActive(NOW)).rejects.toMatchObject({
      cause: underlying,
    });
  });
});
