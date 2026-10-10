import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CargoStatus } from './entities/cargo.entity';
import { TaskStatus } from './entities/transport-task.entity';
import type { DispatchMatcher } from './domain/dispatch.policy';
import type { EntitySyncView } from '../environmental-entities/environmental-entity.dto';

export class CreateCargoDto {
  @IsOptional()
  @IsString()
  itemCode?: string;

  @IsString()
  @IsNotEmpty()
  sourcePointName!: string;

  @IsString()
  @IsNotEmpty()
  destinationZoneId!: string;
}

export class ListCargosQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  taskStatus?: TaskStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** Scope to cargo whose destination zone belongs to the currently loaded plant model, so an
   *  old map's history can't crowd a still-active cargo out of the page size on a new one. */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  activeMapOnly?: boolean;

  @IsOptional()
  @IsUUID()
  mapRecordId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  statuses?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  mapRecordIds?: string;

  @IsOptional()
  @IsIn([
    'code',
    'map',
    'status',
    'task',
    'source',
    'destination',
    'vehicle',
    'created',
    'updated',
  ])
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  columnFilters?: string;
}

export interface CargoRegistryRow {
  id: string;
  itemCode: string;
  status: CargoStatus;
  taskStatus: TaskStatus | null;
  mapRecordId: string | null;
  sourcePointName: string | null;
  destinationLocationName: string | null;
  assignedVehicleName: string | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
  deletedAt: Date | null;
}

export interface CargoRegistrySummary {
  delivered: number;
  failed: number;
  active: number;
  running: number;
}

export interface CargoRegistryResponse extends Omit<
  CargoListResponse,
  'cargos'
> {
  cargos: CargoRegistryRow[];
  summary: CargoRegistrySummary;
}

export type CargoVisualState = 'AT_SOURCE' | 'ON_AGV' | 'AT_DESTINATION';

export interface CargoVisualDto {
  state: CargoVisualState;
  pointName: string | null;
  vehicleName: string | null;
}

export interface CargoResponseDto {
  id: string;
  itemCode: string;
  sourcePointName: string | null;
  sourcePickupLocationName: string | null;
  sourceZoneId: string | null;
  destinationZoneId: string | null;
  destinationLocationName: string | null;
  reservedLocationName: string | null;
  slotDecisionSeq: number;
  mapRecordId: string | null;
  status: CargoStatus;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  taskStatus: TaskStatus | null;
  assignedVehicleName: string | null;
  blockedReason: string | null;
  visual: CargoVisualDto;
  entitySync: EntitySyncView | null;
}

export interface CargoListResponse {
  cargos: CargoResponseDto[];
  total: number;
  page: number;
  limit: number;
  /** True when `total` exceeds what this page actually returned — the caller cut off cargo
   *  that's still there, not gone. */
  truncated: boolean;
}

export interface CargoAssignmentAlternativeDto {
  matcher: DispatchMatcher;
  vehicleName: string | null;
  distanceToSource: number | null;
}

export interface CargoAssignmentDecisionDto {
  cargoId: string;
  taskId: string;
  decidedAt: Date;
  vehicleName: string | null;
  matcher: DispatchMatcher | null;
  matchedRequestCount: number | null;
  distanceToSource: number | null;
  approachDistance: number | null;
  alternative: CargoAssignmentAlternativeDto | null;
}

export const MAX_TASK_CANCEL_BATCH = 200;

export class CancelTasksDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_TASK_CANCEL_BATCH)
  @IsUUID('4', { each: true })
  ids!: string[];
}

export type TaskCancelOutcome = 'cancelled' | 'unchanged' | 'failed';

export interface TaskCancelResultDto {
  taskId: string;
  outcome: TaskCancelOutcome;
  reason: string | null;
  replacementTaskId: string | null;
}

export interface TaskCancelResponse {
  results: TaskCancelResultDto[];
}
