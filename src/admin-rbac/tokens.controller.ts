import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import { TokensService } from './tokens.service';
import { AdoptTokenDto, IssueTokenDto } from './dto/rbac.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get('users/:id/tokens')
  @RequirePermissions('tokens.manage')
  list(@Param('id') id: string) {
    return this.tokens.list(id);
  }

  @Post('users/:id/tokens')
  @RequirePermissions('tokens.manage')
  issue(
    @Param('id') id: string,
    @Body() dto: IssueTokenDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tokens.issue(id, dto.label, actor.sub);
  }

  @Post('users/:id/tokens/adopt')
  @RequirePermissions('tokens.manage')
  adopt(
    @Param('id') id: string,
    @Body() dto: AdoptTokenDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tokens.adopt(id, dto.token, dto.label, actor.sub);
  }

  @Post('tokens/:id/revoke')
  @RequirePermissions('tokens.manage')
  @HttpCode(200)
  revoke(@Param('id') id: string) {
    return this.tokens.revoke(id);
  }
}
