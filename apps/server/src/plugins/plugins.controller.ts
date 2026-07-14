import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PluginsService } from './plugins.service';

function positiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

@Controller('plugins')
export class PluginsController {
  constructor(private readonly service: PluginsService) {}

  @Get('registry/mcp')
  async listRegistryMcp(
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ) {
    return this.service.listRegistryServers({
      limit: positiveInteger(limit),
      ...(typeof cursor === 'string' && cursor.length > 0 ? { cursor } : {}),
    });
  }

  @Get('registry/mcp/:name')
  async getRegistryMcp(
    @Param('name') name: string,
    @Query('version') version: unknown,
  ) {
    return this.service.getRegistryServer(
      name,
      typeof version === 'string' && version.length > 0 ? version : undefined,
    );
  }

  @Get('registry/skills')
  listRegistrySkills() {
    return this.service.listSkillRegistry();
  }

  @Get('registry/lsp')
  listRegistryLsp() {
    return this.service.listLspRegistry();
  }

  @Get('installed')
  listInstalled() {
    return { plugins: this.service.listInstalled() };
  }

  @Post('install')
  install(@Body() body: Record<string, unknown>) {
    return this.service.install(body);
  }

  @Patch('installed/:id')
  async updateInstalled(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return await this.service.update(id, body);
  }

  @Delete('installed/:id')
  @HttpCode(204)
  async deleteInstalled(@Param('id') id: string): Promise<void> {
    await this.service.delete(id);
  }
}
