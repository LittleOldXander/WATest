/*
 * MongoDB initialization script.
 *
 * The official `mongo` image executes every .js file in
 * /docker-entrypoint-initdb.d with mongosh, exactly once, the first time the
 * data volume is empty. Because the seed lives on a named volume, re-running
 * `docker compose up` will NOT re-seed; use `docker compose down -v` to reset.
 *
 * Responsibilities:
 *   1. Create the indexes backing the active-banner lookup.
 *   2. Insert realistic seed data covering every filtering branch.
 */

const database = db.getSiblingDB('banners');
const banners = database.getCollection('banners');

/* ----------------------------- Indexes ------------------------------------ */

/*
 * Primary index for `findActive`. Field order matters:
 *   - isActive first: an equality predicate, the most selective prefix.
 *   - startDate/endDate next: the scheduling-window range predicates.
 *   - priority last (descending): the query's sort key.
 *
 * NOTE: this index avoids a full collection scan, but whether it also
 * avoids an in-memory SORT stage depends on how the query planner treats
 * the `$or`-expressed optional start/end bounds in `findActive`'s filter —
 * that is NOT assumed here. See README.md "What the index actually does"
 * and test/integration/mongo-index-plan.integration.test.ts, which runs
 * `explain('executionStats')` against the real seeded collection and
 * records the actual plan rather than asserting one.
 */
banners.createIndex(
  { isActive: 1, startDate: 1, endDate: 1, priority: -1 },
  { name: 'idx_active_window_priority' },
);

/*
 * Supporting single-field indexes. The compound index above serves the main
 * query; these help ad-hoc CMS queries (e.g. "all banners by priority",
 * "everything expiring this week") without relying on the compound prefix.
 */
banners.createIndex({ isActive: 1 }, { name: 'idx_is_active' });
banners.createIndex({ startDate: 1 }, { name: 'idx_start_date' });
banners.createIndex({ endDate: 1 }, { name: 'idx_end_date' });
banners.createIndex({ priority: -1 }, { name: 'idx_priority_desc' });

/* ------------------------------ Seed data --------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysFromNow = (days) => new Date(now + days * DAY_MS);

/*
 * The seed deliberately covers each branch of the active-banner rule so the
 * filtering logic is observable immediately:
 *   - 3 currently active (2 unbounded, 1 inside its window)
 *   - 1 scheduled for the future  -> excluded
 *   - 1 already expired           -> excluded
 *   - 1 explicitly disabled       -> excluded
 * GET /api/banners should therefore return 3 banners, priority-ordered.
 */
const seedBanners = [
  {
    _id: '0f5f717e-524c-4d3c-8ab7-3cacd2c1b8db',
    title: 'Summer Welcome Offer',
    imageUrl: 'https://cdn.example.com/banners/welcome-summer.png',
    targetUrl: 'https://example.com/promo/welcome-summer',
    priority: 100,
    isActive: true,
    startDate: null,
    endDate: null,
    createdAt: daysFromNow(-30),
    updatedAt: daysFromNow(-2),
  },
  {
    _id: '3d3f2b9a-6f0e-4b3f-9c9a-1c9a6b6f7e21',
    title: 'High Roller Weekend',
    imageUrl: 'https://cdn.example.com/banners/high-roller.png',
    targetUrl: 'https://example.com/promo/high-roller-weekend',
    priority: 90,
    isActive: true,
    startDate: daysFromNow(-1),
    endDate: daysFromNow(3),
    createdAt: daysFromNow(-5),
    updatedAt: daysFromNow(-1),
  },
  {
    _id: '8a2b6e1d-4c3a-4f2e-8b1a-2e9d7c5f4a10',
    title: 'New Player Free Spins',
    imageUrl: 'https://cdn.example.com/banners/free-spins.png',
    targetUrl: 'https://example.com/promo/free-spins',
    priority: 80,
    isActive: true,
    startDate: null,
    endDate: null,
    createdAt: daysFromNow(-60),
    updatedAt: daysFromNow(-10),
  },
  {
    _id: 'c4e9a7b2-1f6d-4a8c-9e3b-7d2c4f8a6b91',
    title: 'Holiday Jackpot Countdown (upcoming)',
    imageUrl: 'https://cdn.example.com/banners/holiday-jackpot.png',
    targetUrl: 'https://example.com/promo/holiday-jackpot',
    priority: 95,
    isActive: true,
    startDate: daysFromNow(10),
    endDate: daysFromNow(40),
    createdAt: daysFromNow(-3),
    updatedAt: daysFromNow(-3),
  },
  {
    _id: 'e1b8f4d6-9a2c-4e7f-8d3b-5a6c9e2f1b73',
    title: 'Spring Bonus (expired)',
    imageUrl: 'https://cdn.example.com/banners/spring-bonus.png',
    targetUrl: 'https://example.com/promo/spring-bonus',
    priority: 70,
    isActive: true,
    startDate: daysFromNow(-90),
    endDate: daysFromNow(-30),
    createdAt: daysFromNow(-95),
    updatedAt: daysFromNow(-30),
  },
  {
    _id: 'a6f2d8b4-3e7c-4b1a-9d5f-8c2a4e6b9d10',
    title: 'Retired Loyalty Promo (disabled)',
    imageUrl: 'https://cdn.example.com/banners/loyalty-old.png',
    targetUrl: 'https://example.com/promo/loyalty-old',
    priority: 60,
    isActive: false,
    startDate: null,
    endDate: null,
    createdAt: daysFromNow(-120),
    updatedAt: daysFromNow(-45),
  },
];

// Idempotent: safe if this script is ever re-run against a populated volume.
for (const banner of seedBanners) {
  banners.updateOne({ _id: banner._id }, { $setOnInsert: banner }, { upsert: true });
}

print(`[mongo-init] banners collection ready: ${banners.countDocuments()} documents`);
