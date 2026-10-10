import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { MapRecordEntity } from '../maps/infrastructure/entities/map-record.entity';
import { PermissionEntity } from '../users/entities/permission.entity';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

@Module({
  imports: [
    UsersModule,
    AuthModule,
    TypeOrmModule.forFeature([MapRecordEntity, PermissionEntity]),
  ],
  controllers: [RbacController, TokensController],
  providers: [RbacService, TokensService],
})
export class AdminRbacModule {}
