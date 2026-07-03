import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { statSync } from 'node:fs';
import { SessionStore, type ProjectRecord } from '../persistence/session-store';
import { SessionsService } from './sessions.service';

type ImportProjectBody = {
  path?: unknown;
};

function validateProjectPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException('`path` must be a non-empty string.');
  }
  try {
    if (!statSync(value).isDirectory()) {
      throw new BadRequestException('`path` must be a directory.');
    }
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new BadRequestException('`path` must be an existing directory.');
  }
  return value;
}

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly store: SessionStore,
    private readonly sessions: SessionsService,
  ) {}

  @Get()
  list(): { projects: ProjectRecord[] } {
    return { projects: this.store.listProjects() };
  }

  @Post()
  importProject(@Body() body: ImportProjectBody = {}): ProjectRecord {
    return this.store.upsertProject(validateProjectPath(body.path));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    if (!(await this.sessions.deleteProject(id))) {
      throw new NotFoundException(`Unknown project: ${id}`);
    }
  }
}
