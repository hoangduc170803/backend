import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { KernelSessionService } from './kernel-session.service';
import type { KernelSessionSnapshot } from './domain/kernel-session';

@ApiTags('operating')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('operating/kernel-session')
export class KernelSessionController {
  constructor(private readonly session: KernelSessionService) {}

  @Get()
  snapshot(): KernelSessionSnapshot {
    return this.session.snapshot();
  }
}
