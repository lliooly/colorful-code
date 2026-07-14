import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseClock } from '../../src/persistence/database-clock';
import { createTestDatabaseProvider } from '../../src/persistence/database-provider.testing';
import {
  SessionStore,
  type SessionStoreFaultHooks,
} from '../../src/persistence/session-store';

class OwnedTestSessionStore extends SessionStore {
  readonly #directory: string;
  readonly #closeProvider: () => Promise<void>;
  #destroyPromise?: Promise<void>;

  constructor(options: {
    clock?: DatabaseClock;
    faultHooks?: SessionStoreFaultHooks;
  }) {
    const directory = mkdtempSync(join(tmpdir(), 'colorful-code-test-store-'));
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      options.clock === undefined ? {} : { clock: options.clock },
    );
    super(provider, options.faultHooks);
    this.#directory = directory;
    this.#closeProvider = () => provider.close();
  }

  destroyForTest(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.close();
    this.#destroyPromise = this.#closeProvider().finally(() => {
      rmSync(this.#directory, { recursive: true, force: true });
    });
    return this.#destroyPromise;
  }
}

const ownedStores = new Set<OwnedTestSessionStore>();

export function createTestSessionStore(
  options: {
    clock?: DatabaseClock;
    faultHooks?: SessionStoreFaultHooks;
  } = {},
): SessionStore {
  const store = new OwnedTestSessionStore(options);
  ownedStores.add(store);
  return store;
}

export async function closeTestSessionStores(): Promise<void> {
  const stores = [...ownedStores];
  ownedStores.clear();
  await Promise.all(stores.map((store) => store.destroyForTest()));
}
