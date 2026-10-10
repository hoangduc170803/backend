import type { CargoFootprint } from '../../environmental-entities/domain/cargo-geometry';
import type { EnvironmentalEntityOverlayDto } from '../../environmental-entities/environmental-entity.dto';
import type {
  AreaDto,
  CargoDto,
  TaskDto,
  TransportOrderDto,
  VehicleRealtimeDto,
} from '../dto/operating.dto';

export type ProjectionTopic = 'task' | 'cargo' | 'area' | 'obstacle';

export type ListPayload =
  | TaskDto
  | CargoDto
  | AreaDto
  | EnvironmentalEntityOverlayDto;

export const PROJECTION_TOPICS: readonly ProjectionTopic[] = [
  'task',
  'cargo',
  'area',
  'obstacle',
];

export interface OperatingSummaryDto {
  mapRecordId: string | null;
  orders: { active: number; processing: number; recentTerminal: number };
  tasks: { byStatus: Record<string, number>; total: number };
  cargos: { byStatus: Record<string, number>; total: number };
  obstacles: { present: number; synced: number; problem: number };
}

export type ProjectionChange =
  | {
      kind: 'vehicle';
      op: 'upsert';
      id: string;
      rev: number;
      payload: VehicleRealtimeDto;
    }
  | {
      kind: 'vehicle';
      op: 'patch';
      id: string;
      rev: number;
      payload: Partial<VehicleRealtimeDto>;
    }
  | {
      kind: 'order';
      op: 'upsert';
      id: string;
      rev: number;
      payload: TransportOrderDto;
    }
  | {
      kind: ProjectionTopic;
      op: 'upsert';
      id: string;
      rev: number;
      payload: ListPayload;
    }
  | {
      kind: 'vehicle' | 'order' | ProjectionTopic;
      op: 'remove';
      id: string;
      rev: number;
    }
  | { kind: 'summary'; op: 'upsert'; rev: number; payload: OperatingSummaryDto }
  | { kind: 'map'; op: 'reset' };

export type ProjectionEvent = ProjectionChange & { epoch: string; seq: number };

export interface SnapshotItem<T> {
  id: string;
  rev: number;
  payload: T;
}

export type SessionFrame =
  | { kind: 'session'; op: 'snapshot-begin'; epoch: string; seq: number }
  | { kind: 'session'; op: 'snapshot-end'; epoch: string; seq: number }
  | { kind: 'session'; op: 'resume'; epoch: string; seq: number }
  | {
      kind: 'vehicle';
      op: 'snapshot';
      items: SnapshotItem<VehicleRealtimeDto>[];
    }
  | { kind: 'order'; op: 'snapshot'; items: SnapshotItem<TransportOrderDto>[] }
  | {
      kind: ProjectionTopic;
      op: 'snapshot';
      items: SnapshotItem<ListPayload>[];
    }
  | { kind: 'footprint'; op: 'snapshot'; payload: CargoFootprint }
  | {
      kind: 'summary';
      op: 'snapshot';
      rev: number;
      payload: OperatingSummaryDto;
    };

export const SNAPSHOT_CHUNK_SIZE = 200;

export function cursorOf(epoch: string, seq: number): string {
  return `${epoch}:${seq}`;
}

export function parseCursor(
  cursor: string | undefined | null,
): { epoch: string; seq: number } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf(':');
  if (separator <= 0) return null;
  const digits = cursor.slice(separator + 1);
  if (!/^\d{1,15}$/.test(digits)) return null;
  return { epoch: cursor.slice(0, separator), seq: Number(digits) };
}
