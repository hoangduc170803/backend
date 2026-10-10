import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, ForgotPasswordDto, ResetPasswordDto } from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser } from './jwt-payload';

const REFRESH_COOKIE = 'wes_refresh';
const REFRESH_MAX_AGE = 7 * 86400_000;

// Access token as a session cookie so EventSource (SSE) — which cannot send an Authorization
// header — authenticates. JwtStrategy reads it after the bearer header. The JWT's own `exp` is
// the real expiry; a stale cookie just yields 401 and the client refreshes.
const ACCESS_COOKIE = 'wes_access';

@Controller('auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService,
  ) {
    // Defaults to the deployment's TLS state (production ⇒ secure); COOKIE_SECURE overrides it
    // explicitly for setups that terminate TLS in front of a proxy that still reports 'production'.
    const override = config.get<string>('COOKIE_SECURE');
    this.secureCookies =
      override !== undefined
        ? override === 'true'
        : config.get<string>('NODE_ENV') === 'production';
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookies,
      path: '/api/auth',
      maxAge: REFRESH_MAX_AGE,
    });
  }

  private setAccessCookie(res: Response, token: string): void {
    res.cookie(ACCESS_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookies,
      path: '/api',
    });
  }

  // UC-81 — 5 attempts/min/IP; failed logins re-check the password every time regardless, so
  // without this a flood of guesses would still cost a bcrypt.compare + DB round trip each.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? null;
    const ua = req.headers['user-agent'] ?? null;
    const result = await this.auth.login(dto.username, dto.password, ip, ua);
    this.setRefreshCookie(res, result.refreshToken);
    this.setAccessCookie(res, result.token);
    return { token: result.token, user: result.user };
  }

  // UC-82
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookies = req.cookies as Record<string, string> | undefined;
    await this.auth.logout(
      user.sub,
      user.sid ?? null,
      cookies?.[REFRESH_COOKIE],
    );
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.clearCookie(ACCESS_COOKIE, { path: '/api' });
    return { ok: true };
  }

  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookies = req.cookies as Record<string, string> | undefined;
    const result = await this.auth.refresh(cookies?.[REFRESH_COOKIE]);
    this.setRefreshCookie(res, result.refreshToken);
    this.setAccessCookie(res, result.token);
    return { token: result.token, user: result.user };
  }

  // UC-86 — same rate limit; this endpoint also sends real email, so it's worth throttling too.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  async forgot(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
    return { ok: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  async reset(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return { ok: true };
  }
}
