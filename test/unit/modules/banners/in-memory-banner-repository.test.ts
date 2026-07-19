import { InMemoryBannerRepository } from '../../../../src/modules/banners/infrastructure/persistence/in-memory-banner-repository.js';
import { isBannerActiveAt } from '../../../../src/modules/banners/domain/banner.js';
import { makeBanner } from '../../helpers/fakes.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

describe('isBannerActiveAt (domain rule)', () => {
  it('excludes disabled banners', () => {
    expect(isBannerActiveAt(makeBanner({ isActive: false }), NOW)).toBe(false);
  });

  it('treats null start/end dates as unbounded', () => {
    expect(isBannerActiveAt(makeBanner({ startDate: null, endDate: null }), NOW)).toBe(true);
  });

  it('excludes banners scheduled to start in the future', () => {
    const banner = makeBanner({ startDate: new Date('2026-07-01T00:00:00.000Z') });
    expect(isBannerActiveAt(banner, NOW)).toBe(false);
  });

  it('excludes banners whose window has already closed', () => {
    const banner = makeBanner({ endDate: new Date('2026-05-01T00:00:00.000Z') });
    expect(isBannerActiveAt(banner, NOW)).toBe(false);
  });

  it('includes banners inside their window', () => {
    const banner = makeBanner({
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      endDate: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(isBannerActiveAt(banner, NOW)).toBe(true);
  });
});

describe('InMemoryBannerRepository', () => {
  it('returns only active, in-window banners ordered by descending priority', async () => {
    const repository = new InMemoryBannerRepository([
      makeBanner({ id: 'low', priority: 1 }),
      makeBanner({ id: 'high', priority: 100 }),
      makeBanner({ id: 'disabled', priority: 999, isActive: false }),
      makeBanner({
        id: 'not-started',
        priority: 500,
        startDate: new Date('2026-07-01T00:00:00.000Z'),
      }),
      makeBanner({ id: 'expired', priority: 500, endDate: new Date('2026-05-01T00:00:00.000Z') }),
      makeBanner({ id: 'mid', priority: 50 }),
    ]);

    const result = await repository.findActive(NOW);

    expect(result.map((banner) => banner.id)).toEqual(['high', 'mid', 'low']);
  });

  it('returns an empty list when nothing is active', async () => {
    const repository = new InMemoryBannerRepository([makeBanner({ isActive: false })]);
    await expect(repository.findActive(NOW)).resolves.toEqual([]);
  });
});
