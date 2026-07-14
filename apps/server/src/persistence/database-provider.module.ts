import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseProvider } from './database-provider';

export const DATABASE_PROVIDER = Symbol('DATABASE_PROVIDER');

@Global()
@Module({})
export class DatabaseProviderModule {
  static forRoot(provider: DatabaseProvider): DynamicModule {
    return {
      module: DatabaseProviderModule,
      providers: [{ provide: DATABASE_PROVIDER, useValue: provider }],
      exports: [DATABASE_PROVIDER],
    };
  }
}
