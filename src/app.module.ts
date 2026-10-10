import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { OpenTcsModule } from './opentcs/opentcs.module';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { AccountModule } from './account/account.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { AdminRbacModule } from './admin-rbac/admin-rbac.module';
import { MapsModule } from './maps/maps.module';
import { AgvsModule } from './agvs/agvs.module';
import { CargoModule } from './cargo/cargo.module';
import { ZoneModule } from './zones/zone.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { OperatingModule } from './operating/operating.module';
import { ApiDocsModule } from './api-docs/api-docs.module';
import { LegacyFmsApiModule } from './legacy-fms-api/legacy-fms-api.module';
import { SimulatorModule } from './simulator/simulator.module';

const localEnvFile = resolve(__dirname, '../.env');
const hasLocalEnvFile = existsSync(localEnvFile);

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      ...(hasLocalEnvFile ? { envFilePath: localEnvFile } : {}),
    }),
    DatabaseModule,
    UsersModule,
    AuthModule,
    AccountModule,
    AdminUsersModule,
    AdminRbacModule,
    OpenTcsModule,
    MapsModule,
    AgvsModule,
    CargoModule,
    ZoneModule,
    DashboardModule,
    OperatingModule,
    LegacyFmsApiModule,
    SimulatorModule,
    ApiDocsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
