import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccountService } from './account.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import {
  ChangePasswordDto,
  UpdatePreferencesDto,
  UpdateProfileDto,
} from './dto/account.dto';

@UseGuards(JwtAuthGuard)
@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.account.getMe(user.sub);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.account.updateMe(user.sub, dto);
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.account.changePassword(user.sub, dto);
    return { ok: true };
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@CurrentUser() user: AuthUser) {
    await this.account.revokeOtherSessions(user.sub, user.sid ?? null);
    return { ok: true };
  }

  @Get('preferences')
  preferences(@CurrentUser() user: AuthUser) {
    return this.account.getPreferences(user.sub);
  }

  @Patch('preferences')
  updatePreferences(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.account.updatePreferences(user.sub, dto);
  }
}
