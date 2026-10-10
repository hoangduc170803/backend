import { Injectable, OnModuleInit } from '@nestjs/common';
import { KernelSessionService } from '../kernel-session/kernel-session.service';
import type {
  KernelRestoreContext,
  KernelRestoreStep,
} from '../kernel-session/domain/kernel-session';
import { EnvironmentalEntitySyncService } from './environmental-entity-sync.service';

@Injectable()
export class EnvironmentalEntityRestoreStep
  implements OnModuleInit, KernelRestoreStep
{
  readonly name = 'Đồng bộ vật cản';
  readonly order = 30;

  constructor(
    private readonly session: KernelSessionService,
    private readonly sync: EnvironmentalEntitySyncService,
  ) {}

  onModuleInit(): void {
    this.session.registerStep(this);
  }

  run(context: KernelRestoreContext): Promise<void> {
    return this.sync.fullResync(context.reason);
  }
}
