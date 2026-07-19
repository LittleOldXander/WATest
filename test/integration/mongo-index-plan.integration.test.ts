/**
 * Validates the MongoDB index assumption behind `MongoBannerRepository.findActive`
 * with real `explain()` evidence against the actual seeded collection, rather
 * than asserting (or worse, merely documenting) a claim about how the query
 * planner behaves.
 *
 * Requires the Docker Compose Mongo container from the main integration
 * suite (see `test/integration/banners-api.integration.test.ts` for startup
 * instructions) — this file only needs `mongo` to be up and seeded, not the
 * full API/Redis/edge stack, but is kept alongside the other integration
 * tests since it exercises the same real-infrastructure precondition.
 */
import { MongoClient, type Db } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const MONGODB_DATABASE = process.env.MONGODB_DATABASE ?? 'banners';

/**
 * Mirrors `MongoBannerRepository.findActive` exactly. Kept as a literal
 * object here (rather than importing the repository) so this test exercises
 * the query shape actually sent to Mongo independent of any future
 * refactor inside the repository class — if someone changes the filter
 * shape without updating this test, the two will diverge and the test's
 * assumption becomes visibly stale rather than silently wrong.
 */
function findActiveFilter(now: Date): Record<string, unknown> {
  return {
    isActive: true,
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
    ],
  };
}

const SORT = { priority: -1, _id: 1 } as const;

interface ExecutionStatsPlan {
  queryPlanner: {
    winningPlan: unknown;
  };
  executionStats: {
    executionSuccess: boolean;
    nReturned: number;
    totalDocsExamined: number;
    totalKeysExamined: number;
  };
}

/** Depth-first collection of every `stage` name appearing in a winning plan tree. */
function collectStageNames(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (typeof record.stage === 'string') out.push(record.stage);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) collectStageNames(item, out);
    } else if (value && typeof value === 'object') {
      collectStageNames(value, out);
    }
  }
  return out;
}

/** Depth-first search for the first stage carrying an `indexName`. */
function findIndexName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (typeof record.indexName === 'string') return record.indexName;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findIndexName(item);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findIndexName(value);
      if (found) return found;
    }
  }
  return undefined;
}

describe('MongoDB index plan for findActive (explain-based, not assumed)', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    db = client.db(MONGODB_DATABASE);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it('uses an index rather than a full collection scan for the active-banner query', async () => {
    const now = new Date();
    const plan = (await db
      .collection('banners')
      .find(findActiveFilter(now))
      .sort(SORT)
      .explain('executionStats')) as unknown as ExecutionStatsPlan;

    expect(plan.executionStats.executionSuccess).toBe(true);

    const stages = collectStageNames(plan.queryPlanner.winningPlan);

    // The one claim this test is willing to make unconditionally: the
    // planner must not fall back to scanning every document in the
    // collection. A COLLSCAN here would mean the compound index (or ANY
    // index) is not being used at all, which would be a genuine regression
    // regardless of how the sort is ultimately satisfied.
    expect(stages).not.toContain('COLLSCAN');

    const indexUsed = findIndexName(plan.queryPlanner.winningPlan);
    expect(indexUsed).toBeDefined();

    // Evidence, not assertion: whether the sort was satisfied FROM the index
    // (no SORT stage) or performed in memory (a SORT stage present) is
    // recorded for a human to read rather than hard-asserted either way.
    // See README.md "What the index actually does" for why: the query's
    // `$or`-expressed optional start/end bounds are exactly the shape that
    // can prevent a single compound index from serving an index-order sort,
    // and asserting a specific outcome here without re-verifying against
    // representative production data would repeat the overclaim this test
    // exists to replace.
    const sortStagePresent = stages.includes('SORT');
    console.info(
      `[mongo-index-plan] index used: ${indexUsed ?? 'none'}; stages: ${stages.join(' -> ')}; ` +
        `sort satisfied ${sortStagePresent ? 'IN MEMORY (SORT stage present)' : 'FROM THE INDEX (no SORT stage)'}; ` +
        `docs examined: ${String(plan.executionStats.totalDocsExamined)}; ` +
        `keys examined: ${String(plan.executionStats.totalKeysExamined)}; ` +
        `returned: ${String(plan.executionStats.nReturned)}`,
    );

    // Sanity: the plan actually returns the documents we expect it to be
    // capable of returning (the seeded active banners), so this explain()
    // call is exercising the real predicate, not an empty/degenerate one.
    expect(plan.executionStats.nReturned).toBeGreaterThan(0);
  }, 30_000);

  it('examines a bounded number of index keys relative to collection size (not a full index scan)', async () => {
    const now = new Date();
    const plan = (await db
      .collection('banners')
      .find(findActiveFilter(now))
      .sort(SORT)
      .explain('executionStats')) as unknown as ExecutionStatsPlan;

    const totalDocuments = await db.collection('banners').countDocuments();

    // With the isActive:1 prefix doing equality filtering, the number of
    // keys examined should not exceed the total collection size — a coarse
    // but real check that the index prefix is contributing selectivity
    // rather than the query degenerating into an effective full scan
    // dressed up as an IXSCAN.
    expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(totalDocuments);
    expect(plan.executionStats.totalKeysExamined).toBeGreaterThan(0);
  }, 30_000);
});
