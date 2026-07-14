import { SessionStore } from '../../src/persistence/session-store';
import {
  createTestDatabase,
  type TestDatabase,
  type TestDatabaseClock,
} from './test-database-factory';

class OwnedTestSessionStore extends SessionStore {
  readonly #database: TestDatabase;
  #destroyPromise?: Promise<void>;

  constructor(database: TestDatabase) {
    super(database.provider);
    this.#database = database;
  }

  destroyForTest(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.close();
    this.#destroyPromise = this.#database.close();
    return this.#destroyPromise;
  }
}

const ownedStores = new Set<OwnedTestSessionStore>();
const pendingStores = new Set<Promise<OwnedTestSessionStore>>();

export function createTestSessionStore(
  options: {
    clock?: TestDatabaseClock;
  } = {},
): Promise<SessionStore> {
  const creation = createTestDatabase({
    kind: 'migrated',
    clock: options.clock,
  }).then((database) => {
    const store = new OwnedTestSessionStore(database);
    ownedStores.add(store);
    return store;
  });
  pendingStores.add(creation);
  void creation.then(
    () => pendingStores.delete(creation),
    () => pendingStores.delete(creation),
  );
  return creation;
}

export async function closeTestSessionStores(): Promise<void> {
  const pendingResults = await Promise.allSettled([...pendingStores]);
  const stores = [...ownedStores];
  stores.forEach((store) => ownedStores.delete(store));
  const cleanupResults = await Promise.allSettled(
    stores.map((store) => store.destroyForTest()),
  );
  const errors = [...pendingResults, ...cleanupResults]
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Test SessionStore cleanup failed');
  }
}
