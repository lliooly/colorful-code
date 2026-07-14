import { PluginStore } from '../../src/plugins/plugin-store';
import {
  createTestDatabase,
  type TestDatabase,
  type TestDatabaseClock,
} from './test-database-factory';

class OwnedTestPluginStore extends PluginStore {
  readonly #database: TestDatabase;
  #destroyPromise?: Promise<void>;

  constructor(database: TestDatabase) {
    super(database.provider);
    this.#database = database;
  }

  destroyForTest(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#destroyPromise = this.#database.close();
    return this.#destroyPromise;
  }
}

const ownedStores = new Set<OwnedTestPluginStore>();
const pendingStores = new Set<Promise<OwnedTestPluginStore>>();

export function createTestPluginStore(
  clock?: TestDatabaseClock,
): Promise<PluginStore> {
  const creation = createTestDatabase({ kind: 'migrated', clock }).then(
    (database) => {
      const store = new OwnedTestPluginStore(database);
      ownedStores.add(store);
      return store;
    },
  );
  pendingStores.add(creation);
  void creation.then(
    () => pendingStores.delete(creation),
    () => pendingStores.delete(creation),
  );
  return creation;
}

export async function closeTestPluginStores(): Promise<void> {
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
    throw new AggregateError(errors, 'Test PluginStore cleanup failed');
  }
}
