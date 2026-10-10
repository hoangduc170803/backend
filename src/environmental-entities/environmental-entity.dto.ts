import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MapScopeQueryDto } from '../maps/domain/map-scope';
import type {
  EntityDesiredState,
  EntitySyncErrorKind,
  EntitySyncStatus,
} from './entities/cargo-environmental-entity.entity';
import type {
  CargoFootprint,
  EntityEnvelope,
  EntityPose,
} from './domain/cargo-geometry';

export interface EntitySyncView {
  entityName: string;
  generation: number;
  desiredState: EntityDesiredState;
  status: EntitySyncStatus;
  errorKind: EntitySyncErrorKind | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  ackedAt: string | null;
  lastError: string | null;
}

export interface EnvironmentalEntityOverlayDto extends EntitySyncView {
  cargoId: string;
  itemCode: string;
  destinationLocationName: string | null;
  pose: EntityPose | null;
  envelope: EntityEnvelope | null;
}

export interface EnvironmentalEntityOverlayListDto {
  footprint: CargoFootprint;
  entities: EnvironmentalEntityOverlayDto[];
}

/** What openTCS holds for a row's current entity name, as seen right now. */
export type KernelEntityState =
  | 'ACTIVE'
  | 'RETIRED'
  | 'MISSING'
  /** The row's map is not the one loaded in openTCS — nothing to compare against. */
  | 'NOT_LOADED'
  /** openTCS could not be reached. */
  | 'UNKNOWN';

export interface EnvironmentalEntityAdminRowDto extends EntitySyncView {
  cargoId: string;
  itemCode: string;
  destinationLocationName: string | null;
  mapRecordId: string | null;
  mapName: string | null;
  onLoadedMap: boolean;
  cargoStatus: string | null;
  cargoDeleted: boolean;
  /** Why the cargo may not be an obstacle (reactivation is refused) — `null` when it qualifies. */
  ineligibleReason: string | null;
  kernelState: KernelEntityState;
  pose: EntityPose | null;
  envelope: EntityEnvelope | null;
  createdAt: string;
  updatedAt: string;
}

/** An entity on openTCS that no WES row accounts for — created by hand, by another system, or orphaned. */
export interface KernelOnlyEntityDto {
  name: string;
  retired: boolean;
  type: string | null;
  integrationLevel: string | null;
  /** Named and tagged like a WES obstacle, but WES has no live row for it. */
  wesOwned: boolean;
  cargoId: string | null;
  properties: Record<string, string>;
}

export interface EnvironmentalEntityAdminListDto {
  loadedMapId: string | null;
  kernelReachable: boolean;
  rows: EnvironmentalEntityAdminRowDto[];
  /** How many rows the scope, filters and search match — not how many this page carries. */
  total: number;
  page: number;
  limit: number;
  /** Only for the loaded map (the kernel holds nothing else) and only when it is in scope. */
  kernelOnly: KernelOnlyEntityDto[];
}

export interface EnvironmentalEntityLogDto {
  event: string;
  entityName: string | null;
  detail: string | null;
  createdAt: string;
}

export const OBSTACLE_ADMIN_MAX_PAGE_SIZE = 100;

/** Scope (`scope` / `mapRecordId`) plus the paging, filters and search of the admin table. */
export class ObstacleAdminQueryDto extends MapScopeQueryDto {
  @ApiPropertyOptional({ description: 'Trang, bắt đầu từ 1.', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Số dòng mỗi trang.',
    default: 20,
    maximum: OBSTACLE_ADMIN_MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(OBSTACLE_ADMIN_MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Bộ lọc, phân tách bằng dấu phẩy (khớp một trong số đó): present, retired, problem.',
    example: 'present,problem',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  filters?: string;

  @ApiPropertyOptional({
    description: 'Thu hẹp theo các bản đồ (uuid, phân tách bằng dấu phẩy).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  mapRecordIds?: string;

  @ApiPropertyOptional({
    description: 'Tìm theo mã hàng, tên vật cản hoặc vị trí đích.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;
}

export interface ObstacleSummaryDto {
  present: number;
  synced: number;
  problem: number;
}
