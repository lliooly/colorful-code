import { Module } from '@nestjs/common';
import { SessionStore } from './session-store';

// Provides the `SessionStore` (SQLite + drizzle persistence). The store opens
// the configured DB file on construction (via the global `SERVER_ENV` provider)
// and closes it on shutdown. Imported by `SessionsModule`, which persists session
// snapshots + the permission audit as runs reach a terminal state.
@Module({
  providers: [SessionStore],
  exports: [SessionStore]
})
export class PersistenceModule {}
