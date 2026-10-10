import type { CargoResponseDto } from '../cargo/cargo.dto';
import { CargoStatus } from '../cargo/entities/cargo.entity';
import { TaskStatus } from '../cargo/entities/transport-task.entity';
import { pointNameOf } from '../zones/domain/location-naming';
import { LegacyFmsError, LegacyFmsException } from './legacy-fms.errors';

export interface LegacyCargoRequest {
  name: string;
  position: string;
  destination: string;
}

export type LegacyCargoState =
  | 'NONE'
  | 'ORDER_ASSIGNED'
  | 'WAITING_FOR_VEHICLE'
  | 'BEING_PROCESSED'
  | 'FINISHED'
  | 'FAILED';

export interface LegacyCargoDto {
  id: string;
  name: string;
  initialPosition: string | null;
  position: string | null;
  pointTarget: string | null;
  destination: string;
  type: string | null;
  vehicleId: number | null;
  transportOrder: null;
  state: LegacyCargoState;
  properties: Record<string, string>;
  createAt: string;
  updateAt: string;
  deleteAt: string | null;
}

const REQUIRED_FIELDS = ['name', 'position', 'destination'] as const;

export function parseLegacyCargoRequest(body: unknown): LegacyCargoRequest {
  const json = isPlainObject(body) ? body : {};
  const hasAllFields = REQUIRED_FIELDS.every((field) => field in json);
  if (!hasAllFields)
    throw new LegacyFmsException(LegacyFmsError.REQUIRED_FIELDS);

  const request = {
    name: asText(json.name),
    position: asText(json.position),
    destination: asText(json.destination),
  };
  const hasBlankField = Object.values(request).some(
    (value) => value.trim() === '',
  );
  if (hasBlankField)
    throw new LegacyFmsException(LegacyFmsError.REQUIRED_FIELDS);
  return request;
}

export function toLegacyCargo(
  cargo: CargoResponseDto,
  destinationZoneName: string,
): LegacyCargoDto {
  return {
    id: cargo.id,
    name: cargo.itemCode,
    initialPosition: cargo.sourcePointName,
    position: cargo.visual.pointName ?? cargo.sourcePointName,
    pointTarget: cargo.reservedLocationName
      ? pointNameOf(cargo.reservedLocationName)
      : null,
    destination: destinationZoneName,
    type: null,
    vehicleId: null,
    transportOrder: null,
    state: toLegacyState(cargo.status, cargo.taskStatus),
    properties: {},
    createAt: cargo.createdAt.toISOString(),
    updateAt: cargo.updatedAt.toISOString(),
    deleteAt: cargo.deletedAt ? cargo.deletedAt.toISOString() : null,
  };
}

export function toLegacyState(
  cargoStatus: CargoStatus,
  taskStatus: TaskStatus | null,
): LegacyCargoState {
  if (cargoStatus === CargoStatus.DELIVERED) return 'FINISHED';
  if (
    cargoStatus === CargoStatus.FAILED ||
    cargoStatus === CargoStatus.CANCELLED
  ) {
    return 'FAILED';
  }
  switch (taskStatus) {
    case TaskStatus.PICKING_UP:
    case TaskStatus.DELIVERING:
    case TaskStatus.EXECUTING:
      return 'BEING_PROCESSED';
    case TaskStatus.READY_TO_ASSIGN:
    case TaskStatus.BLOCKED:
      return 'WAITING_FOR_VEHICLE';
    case TaskStatus.DELIVERY_COMPLETED:
    case TaskStatus.COMPLETED:
      return 'FINISHED';
    case TaskStatus.CANCELLED:
    case TaskStatus.FAILED:
      return 'FAILED';
    default:
      return 'NONE';
  }
}

function asText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
