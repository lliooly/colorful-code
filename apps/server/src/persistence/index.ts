// SQLite + drizzle persistence for the session engine. Persists each
// `SessionSnapshot` as one upserted JSON row and the permission audit as its own
// append-only table (queryable per session). No secrets are stored.
export * from './schema';
export * from './database';
export * from './session-store';
export * from './persistence.module';
export {
  createMigrationBackup,
  MigrationBackupRecoveryError,
  quarantineDatabase,
  restoreMigrationBackup,
  verifyDatabase,
  type MigrationBackup,
  type MigrationBackupManifest,
  type MigrationBackupRecoveryErrorCode,
  type QuarantinedDatabase,
  type RestoreMigrationBackupOptions,
} from './migration-backup-recovery';
export * from './migration-bootstrap';
