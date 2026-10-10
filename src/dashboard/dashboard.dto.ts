import { MapScopeQueryDto } from '../maps/domain/map-scope';
import { IsIn, IsOptional } from 'class-validator';
import { KPI_WINDOWS } from './domain/kpi';
import type { BucketUnit, KpiWindow } from './domain/kpi';

export class KpiQueryDto extends MapScopeQueryDto {
  @IsOptional()
  @IsIn(KPI_WINDOWS)
  window?: KpiWindow;
}

export interface ThroughputPoint {
  bucket: string;
  completed: number;
}

export interface FleetSnapshot {
  registered: number;
  online: number;
  executing: number;
  charging: number;
  idle: number;
  error: number;
  kernelConnected: boolean;
}

export interface QueueSnapshot {
  created: number;
  readyToAssign: number;
  blocked: number;
  pickingUp: number;
  delivering: number;
  inFlight: number;
}

export interface KpiResponse {
  window: KpiWindow;
  from: string;
  to: string;
  generatedAt: string;
  bucketUnit: BucketUnit;
  completed: number;
  failed: number;
  cancelled: number;
  failureRate: number | null;
  successRate: number | null;
  avgTransportSeconds: number | null;
  avgAssignmentWaitSeconds: number | null;
  throughput: ThroughputPoint[];
  fleet: FleetSnapshot;
  queue: QueueSnapshot;
}
