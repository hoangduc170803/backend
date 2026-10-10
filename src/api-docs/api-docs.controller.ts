import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import {
  API_LAYER_PERMISSION,
  ApiDocsRegistry,
  type ApiLayerSlug,
  type ApiLayerSummary,
} from './api-docs.registry';

@ApiTags('ApiDocs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('screen.api_docs')
@Controller('api-docs')
export class ApiDocsController {
  constructor(private readonly registry: ApiDocsRegistry) {}

  @Get('layers')
  layers(@CurrentUser() user: AuthUser): ApiLayerSummary[] {
    return this.registry.layersFor(new Set(user.perms));
  }

  @Get('layers/:slug')
  spec(
    @Param('slug') slug: string,
    @CurrentUser() user: AuthUser,
  ): OpenAPIObject {
    const spec = this.registry.spec(slug);
    const required = API_LAYER_PERMISSION[slug as ApiLayerSlug];
    if (!user.perms.includes(required)) {
      throw new ForbiddenException(`Thiếu quyền: ${required}`);
    }
    return spec;
  }
}
