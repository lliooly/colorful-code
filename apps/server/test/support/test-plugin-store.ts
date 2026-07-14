import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseClock } from '../../src/persistence/database-clock';
import { createTestDatabaseProvider } from '../../src/persistence/database-provider.testing';
import { PluginStore } from '../../src/plugins/plugin-store';

class OwnedTestPluginStore extends PluginStore {
  readonly #directory: string;
  readonly #closeProvider: () => Promise<void>;
  #destroyPromise?: Promise<void>;

  constructor(clock?: DatabaseClock) {
    const directory = mkdtempSync(
      join(tmpdir(), 'colorful-code-test-plugins-'),
    );
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      clock === undefined ? {} : { clock },
    );
    super(provider);
    this.#directory = directory;
    this.#closeProvider = () => provider.close();
  }

  destroyForTest(): Promise<void> {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#destroyPromise = this.#closeProvider().finally(() => {
      rmSync(this.#directory, { recursive: true, force: true });
    });
    return this.#destroyPromise;
  }
}

const ownedStores = new Set<OwnedTestPluginStore>();

export function createTestPluginStore(clock?: DatabaseClock): PluginStore {
  const store = new OwnedTestPluginStore(clock);
  ownedStores.add(store);
  return store;
}

export async function closeTestPluginStores(): Promise<void> {
  const stores = [...ownedStores];
  ownedStores.clear();
  await Promise.all(stores.map((store) => store.destroyForTest()));
}
