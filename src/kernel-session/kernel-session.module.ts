import { Module } from '@nestjs/common';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { MapRecordCoreModule } from '../maps/map-record-core.module';
import {
  KernelSessionLock,
  KernelSessionService,
  PgKernelSessionLock,
} from './kernel-session.service';
import { KernelSessionController } from './kernel-session.controller';

@Module({
  imports: [OpenTcsModule, MapRecordCoreModule],
  providers: [
    KernelSessionService,
    { provide: KernelSessionLock, useClass: PgKernelSessionLock },
  ],
  controllers: [KernelSessionController],
  exports: [KernelSessionService],
})
export class KernelSessionModule {}
