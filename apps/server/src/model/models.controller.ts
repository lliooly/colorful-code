import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import { validateModelSelection } from '../sessions/sessions.controller';
import { ModelSelectionError } from '../sessions/model-factory';
import {
  ModelsService,
  type ModelConnectionResult,
  type PublicModelPreset,
} from './models-service';

type ModelRequestBody = {
  model?: unknown;
};

@Controller('models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get('presets')
  presets(): { presets: PublicModelPreset[] } {
    return this.models.presets();
  }

  @Post('test')
  async test(
    @Body() body: ModelRequestBody = {},
  ): Promise<ModelConnectionResult> {
    try {
      return await this.models.test(validateModelSelection(body.model) ?? {});
    } catch (error) {
      throw modelBadRequest(error);
    }
  }

  @Post('list')
  async list(
    @Body() body: ModelRequestBody = {},
  ): Promise<{ models: string[] }> {
    try {
      return await this.models.list(validateModelSelection(body.model) ?? {});
    } catch (error) {
      throw modelBadRequest(error);
    }
  }
}

function modelBadRequest(error: unknown): BadRequestException {
  if (error instanceof BadRequestException) {
    return error;
  }
  if (error instanceof ModelSelectionError || error instanceof Error) {
    return new BadRequestException(error.message);
  }
  return new BadRequestException(String(error));
}
