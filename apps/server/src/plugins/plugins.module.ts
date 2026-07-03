import { Module } from '@nestjs/common';
import {
  PLUGIN_REGISTRY_CLIENT,
  PublicMcpRegistryClient,
} from './plugin-registry';
import { PluginStore } from './plugin-store';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

@Module({
  controllers: [PluginsController],
  providers: [
    PluginStore,
    PluginsService,
    {
      provide: PLUGIN_REGISTRY_CLIENT,
      useFactory: () => new PublicMcpRegistryClient(),
    },
  ],
  exports: [PluginStore, PluginsService],
})
export class PluginsModule {}
