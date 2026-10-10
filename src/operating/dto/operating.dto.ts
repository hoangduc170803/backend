/**
 * Response shapes for the operating screen (`wes-new-client-v2`). These mirror the DTOs the
 * v2 client already consumes (ported 1:1 from the retired `wes-new` backend) so the client
 * needs no type changes — only its API base URL moves to `/api/operating/*`.
 *
 * Request bodies (below the response shapes) are `class`es with `class-validator` decorators —
 * unlike the response interfaces, these are actually run through the global `ValidationPipe`,
 * and being real classes is also what lets the OpenAPI/Swagger plugin document them.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  TaskKind,
  TaskStatus,
} from '../../cargo/entities/transport-task.entity';
import type { EntitySyncView } from '../../environmental-entities/environmental-entity.dto';

export interface PlantModelPointDto {
  name: string;
  x: number;
  y: number;
  linked: boolean;
  /** true when the point is linked to a Location whose LocationType allows the charge operation. */
  charge: boolean;
  /** openTCS Point.Type — HALT_POSITION / PARK_POSITION / REPORT_POSITION. */
  type: string;
  labelOffsetX: number;
  labelOffsetY: number;
  /** Fixed vehicle orientation at this point in degrees, or null ("NaN" in the model). */
  orientationAngle: number | null;
}

export interface PlantModelPathDto {
  name: string;
  source: string;
  target: string;
  locked: boolean;
  maxVelocity: number;
  maxReverseVelocity: number;
  /** Path length in mm from the kernel model (0 when unknown). */
  length: number;
  /** true when the path may only be driven source -> target (maxReverseVelocity === 0). */
  oneWay: boolean;
}

export interface PlantModelLocationTypeDto {
  name: string;
  allowedOperations: string[];
}

/** A kernel Location and the point(s) it's linked to — the real source for "what can I do at
 *  this point", independent of WES's own Zone/Store abstraction. */
export interface PlantModelLocationDto {
  name: string;
  type: string;
  pointNames: string[];
}

export interface PlantModelPointsDto {
  modelName: string;
  points: PlantModelPointDto[];
}

export interface VehicleRealtimeDto {
  name: string;
  /** VDA5050 serialNumber (`vda5050:serialNumber`) — the name the vehicle goes by on MQTT. */
  serialNumber: string | null;
  x: number | null;
  y: number | null;
  orientationAngle: number | null;
  currentPosition: string | null;
  state: string;
  procState: string;
  integrationLevel: string;
  energyLevel: number;
  batteryVoltage: number | null;
  transportOrder: string | null;
  paused: boolean;
  /** Pause state reported by the AGV via VDA5050, independent of the kernel pause command. */
  reportedPaused: boolean | null;
  /** Carrying cargo — true while executing a drop-off order (`DROPOFF-*`, WES naming). */
  loaded: boolean;
  /** VDA5050 `errors[].errorType` at FATAL level (plus `eStop`), from `vda5050:errors.fatal`. */
  fatalErrorCodes: string[];
  /** VDA5050 `errors[].errorType` at WARNING level, from `vda5050:errors.warning`. */
  warningErrorCodes: string[];
  /** The vehicle's own VDA5050 `errors[].errorDescription` by errorType, from `fms:errorDescriptions`. */
  errorDescriptions: Record<string, string>;
  /** Point names still ahead of the vehicle on its current order — for the route highlight. */
  routePoints: string[];
  /** % of the current order's route steps already driven (0 with no active order). */
  routeProgressPercent: number;
  /** Every route step in order, each flagged driven/not — for the full-route popover. */
  routeSteps: { point: string; driven: boolean }[];
  /** Resource (point/path) names currently claimed by the vehicle in the kernel scheduler. */
  allocatedResources: string[];
}

export interface TransportOrderDto {
  name: string;
  type: string;
  state: string;
  processingVehicle: string | null;
  intendedVehicle: string | null;
  wrappingSequence: string | null;
  destinations: { locationName: string; operation: string }[];
  creationTime: string | null;
  /** Only set once the kernel actually reaches a successful FINISHED state — null otherwise. */
  finishedTime: string | null;
  taskId: string | null;
}

export interface OperatingHealthDto {
  kernel: string;
  kernelSse: {
    connected: boolean;
    eventCount: number;
    lastEventAt: string | null;
  };
  db: string;
  mqtt: string;
  /** Size of the realtime read model behind `/operating/stream/v2` — every figure is bounded. */
  realtime: {
    epoch: string;
    seq: number;
    sessions: number;
    vehicles: number;
    orders: number;
    replayEntries: number;
    replayBytes: number;
  };
}

// --- Area (a wes Zone projected into the shape the operating client expects) ---------------

export type AreaKind = 'ZONE' | 'STORE';
export type AreaMemberState = 'FREE' | 'RESERVED' | 'OCCUPIED';

export interface AreaMemberDto {
  wesId: string;
  areaId: string;
  opentcsLocationName: string;
  opentcsPointName: string;
  priority: number;
  state: AreaMemberState;
  cargoId: string | null;
}

export interface AreaDto extends Partial<MapTagDto> {
  wesId: string;
  name: string;
  kind: AreaKind;
  /** Implicit in wes (liftUp / liftDown by kind) — reported for display only. */
  operation: string;
  maxVehicles: number | null;
  color: string | null;
  plantModelName: string | null;
  status: 'ACTIVE' | 'STALE';
  members: AreaMemberDto[];
}

export class AreaMemberInput {
  @IsString()
  pointName!: string;

  @IsOptional()
  @IsNumber()
  priority?: number;
}

export class CreateAreaBody {
  @IsOptional()
  @IsString()
  wesId?: string;

  @IsString()
  name!: string;

  @IsIn(['ZONE', 'STORE'])
  kind!: AreaKind;

  @IsOptional()
  @IsString()
  operation?: string;

  @IsOptional()
  @IsNumber()
  maxVehicles?: number;

  @IsOptional()
  @IsString()
  color?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AreaMemberInput)
  members!: AreaMemberInput[];
}

export class ReplaceAreaMembersBody {
  @IsOptional()
  @IsString()
  name?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AreaMemberInput)
  members!: AreaMemberInput[];
}

export class UpdateAreaBody {
  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  operation?: string;

  /** `null` explicitly clears a previously-set cap; `undefined` leaves it unchanged. */
  @ValidateIf((o: UpdateAreaBody) => o.maxVehicles != null)
  @IsNumber()
  maxVehicles?: number | null;
}

/** Copy the Zones/Stores of another map record onto the currently-loaded map. */
export class CopyAreasFromMapBody {
  @IsUUID()
  sourceMapRecordId!: string;

  /** Restrict the copy to these areas of the source map; omitted = every area. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  areaIds?: string[];
}

export interface CopyAreasFromMapResult {
  plantModelName: string;
  copied: { sourceId: string; wesId: string; name: string }[];
  skipped: { sourceId: string; name: string; reason: string }[];
  kernelWriteFailed: boolean;
}

// --- Cargo (a wes CargoResponseDto mapped to the operating client's shape) -----------------

export type OperatingCargoStatus =
  | 'QUEUED'
  | 'BLOCKED'
  | 'PICK_PENDING'
  | 'PICKING'
  | 'CARRYING'
  | 'SHIPPING'
  | 'DONE'
  | 'FAILED';

/** Which library map a list row belongs to — printed by the all-maps lists. */
export interface MapTagDto {
  mapRecordId: string | null;
  mapName: string | null;
  /** The row belongs to the map loaded in openTCS — the only one it can be acted on. */
  onLoadedMap: boolean;
}

export interface CargoDto extends MapTagDto {
  cargoId: string;
  itemCode: string;
  status: OperatingCargoStatus;
  processingVehicle: string | null;
  pickupAreaWesId: string | null;
  pickupPointName: string | null;
  pickupLocationName: string | null;
  targetStoreAreaWesId: string | null;
  dropPointName: string | null;
  dropLocationName: string | null;
  reservedLocationName: string | null;
  destinationLocationName: string | null;
  slotDecisionSeq: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  entitySync: EntitySyncView | null;
}

export interface CargoListDto {
  cargos: CargoDto[];
  total: number;
  truncated: boolean;
}

export type TaskLegKind =
  | 'PICKUP'
  | 'APPROACH'
  | 'DROPOFF'
  | 'MANUAL'
  | 'PARK'
  | 'CHARGE';

export interface TaskOrderHistoryDto {
  leg: string;
  orderName: string;
  state: string;
  vehicleName: string | null;
  replacedBy: string | null;
  endReason: string | null;
  kernelState: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface TaskLegDto {
  kind: TaskLegKind;
  orderName: string;
  /** How WES recorded the leg's order ending (`TaskOrderState`) — absent for a task that
   *  predates the order ledger. Lets a client show leg progress without the order list. */
  state?: string;
}

export interface TaskDto extends Partial<MapTagDto> {
  taskId: string;
  requestCode: string;
  kind: TaskKind;
  status: TaskStatus;
  cargoId: string | null;
  itemCode: string | null;
  vehicle: string | null;
  pickupPointName: string | null;
  pickupLocationName: string | null;
  destinationZoneId: string | null;
  destinationZoneName: string | null;
  dropLocationName: string | null;
  currentLeg: TaskLegKind | null;
  legs: TaskLegDto[];
  blockedReason: string | null;
  failureReason: string | null;
  createdAt: string;
  assignedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}

export interface TaskListDto {
  tasks: TaskDto[];
  total: number;
  truncated: boolean;
}

export interface TaskRegistryItemDto extends TaskDto {
  mapRecordId: string | null;
  mapName: string | null;
  onLoadedMap: boolean;
}

export interface TaskRegistryListDto {
  tasks: TaskRegistryItemDto[];
  total: number;
  page: number;
  limit: number;
}

export interface TaskTransitionDto {
  fromStatus: string | null;
  toStatus: string;
  trigger: string | null;
  vehicleName: string | null;
  reason: string | null;
  occurredAt: string;
}

export interface TaskRegistryDetailDto extends TaskRegistryItemDto {
  startedAt: string | null;
  dropPointName: string | null;
  cargoStatus: string | null;
  transitions: TaskTransitionDto[];
  orders: TaskOrderHistoryDto[];
}

function splitCsv(value: unknown): unknown {
  return typeof value === 'string'
    ? value.split(',').filter((part) => part.length > 0)
    : value;
}

export class ListTasksQueryDto {
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

  @IsOptional()
  @IsUUID()
  mapRecordId?: string;

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray()
  @IsUUID('4', { each: true })
  mapRecordIds?: string[];

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray()
  @IsEnum(TaskStatus, { each: true })
  status?: TaskStatus[];

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray()
  @IsEnum(TaskKind, { each: true })
  kind?: TaskKind[];

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn([
    'code',
    'kind',
    'cargo',
    'map',
    'status',
    'vehicle',
    'pickup',
    'destination',
    'leg',
    'created',
    'finished',
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

// --- Manual transport orders (OperatingCommandsController) -------------------------------

export class OrderDestinationInput {
  @IsString()
  name!: string;

  @IsString()
  operation!: string;
}

export class CreateManualOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderDestinationInput)
  destinations!: OrderDestinationInput[];

  @IsOptional()
  @IsString()
  intendedVehicle?: string;

  @IsOptional()
  @IsString()
  type?: string;
}

export class CreateCargoBody {
  @IsOptional()
  @IsString()
  cargoId?: string;

  @IsOptional()
  @IsString()
  pickupAreaWesId?: string;

  @IsString()
  pickupPointName!: string;

  @IsString()
  targetStoreAreaWesId!: string;
}

export const MAX_CARGO_DELETE_BATCH = 200;

export class AreaCargoPurgeFailure {
  @ApiProperty({ description: 'Mã định danh hàng không xoá được' })
  cargoId!: string;

  @ApiProperty({ description: 'Lý do không xoá được' })
  reason!: string;
}

export class AreaCargoPurgeResult {
  @ApiProperty({ description: 'Số hàng đã xoá' })
  deleted!: number;

  @ApiProperty({ type: [AreaCargoPurgeFailure] })
  failed!: AreaCargoPurgeFailure[];
}

export class DeleteCargosBody {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_CARGO_DELETE_BATCH)
  @IsString({ each: true })
  ids!: string[];
}

export type CargoDeleteOutcome = 'deleted' | 'failed';

export interface CargoDeleteResultDto {
  cargoId: string;
  outcome: CargoDeleteOutcome;
  reason: string | null;
}

export interface CargoDeleteResponse {
  results: CargoDeleteResultDto[];
}

// --- Transport-order registry (every order WES ever created, across every map) ---------

export const TASK_ORDER_STATES = [
  'ACTIVE',
  'FINISHED',
  'FAILED',
  'WITHDRAWN',
  'REPLACED',
  'PREEMPTED',
] as const;

export const TASK_ORDER_LEGS = [
  'PICKUP',
  'APPROACH',
  'DROPOFF',
  'MANUAL',
  'PARK',
  'CHARGE',
] as const;

export class ListTransportOrdersQueryDto {
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

  @IsOptional()
  @IsUUID()
  mapRecordId?: string;

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray()
  @IsUUID('4', { each: true })
  mapRecordIds?: string[];

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray()
  @IsIn(TASK_ORDER_STATES, { each: true })
  state?: (typeof TASK_ORDER_STATES)[number][];

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray()
  @IsIn(TASK_ORDER_LEGS, { each: true })
  leg?: (typeof TASK_ORDER_LEGS)[number][];

  /** Order name, vehicle, task request code or cargo item code. */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn([
    'order',
    'leg',
    'state',
    'vehicle',
    'destinations',
    'task',
    'cargo',
    'map',
    'created',
    'ended',
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

export interface TransportOrderRegistryItemDto {
  orderName: string;
  leg: string;
  seq: number;
  state: string;
  kernelState: string;
  vehicleName: string | null;
  agvId: string | null;
  destinations: { locationName: string; operation: string }[];
  replacedBy: string | null;
  replacementOrderId: string | null;
  endReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  taskId: string;
  requestCode: string | null;
  taskKind: string | null;
  taskStatus: string | null;
  itemCode: string | null;
  mapRecordId: string | null;
  mapName: string | null;
  onLoadedMap: boolean;
}

export interface TransportOrderRegistryListDto {
  orders: TransportOrderRegistryItemDto[];
  total: number;
  page: number;
  limit: number;
}
