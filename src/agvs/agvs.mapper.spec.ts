import { AgvEntity } from './entities/agv.entity';
import { VehicleErrorEventEntity } from './entities/vehicle-error-event.entity';
import { VehicleStateTransitionEntity } from '../opentcs/entities/vehicle-state-transition.entity';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import {
  acceptanceStatusOf,
  resolveKernelStatus,
  toAgvDto,
  toAgvErrorEventDto,
  toAgvStateChangeDto,
} from './agvs.mapper';

const entity = (o: Partial<AgvEntity> = {}): AgvEntity => ({
  id: 'a1',
  code: 'AGV-01',
  name: 'V1',
  model: null,
  manufacturer: null,
  serialNumber: null,
  initialPosition: null,
  isDispatchEnabled: true,
  isIgnored: false,
  criticalBatteryThreshold: 20,
  sufficientBatteryThreshold: 60,
  config: {},
  plantModelName: null,
  mapRecordId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-02-02T00:00:00Z'),
  createdById: 'u1',
  ...o,
});

const vehicle = (integrationLevel: string): KernelVehicleState =>
  ({ integrationLevel }) as unknown as KernelVehicleState;

describe('agvs.mapper', () => {
  describe('acceptanceStatusOf', () => {
    it('returns IGNORED regardless of dispatch flag', () => {
      expect(acceptanceStatusOf(entity({ isIgnored: true }))).toBe('IGNORED');
      expect(
        acceptanceStatusOf(
          entity({ isIgnored: true, isDispatchEnabled: true }),
        ),
      ).toBe('IGNORED');
    });

    it('returns ENABLED / DISABLED by the dispatch flag when not ignored', () => {
      expect(acceptanceStatusOf(entity({ isDispatchEnabled: true }))).toBe(
        'ENABLED',
      );
      expect(acceptanceStatusOf(entity({ isDispatchEnabled: false }))).toBe(
        'DISABLED',
      );
    });
  });

  describe('resolveKernelStatus', () => {
    it('is unknown when the kernel is unreachable', () => {
      expect(resolveKernelStatus(false, undefined)).toBe('unknown');
      expect(resolveKernelStatus(false, vehicle('TO_BE_UTILIZED'))).toBe(
        'unknown',
      );
    });

    it('is unreachable when reachable but the vehicle is absent', () => {
      expect(resolveKernelStatus(true, undefined)).toBe('unreachable');
    });

    it('is connected when the vehicle is TO_BE_UTILIZED', () => {
      expect(resolveKernelStatus(true, vehicle('TO_BE_UTILIZED'))).toBe(
        'connected',
      );
    });

    it('is reachable for any other integration level', () => {
      expect(resolveKernelStatus(true, vehicle('TO_BE_IGNORED'))).toBe(
        'reachable',
      );
    });

    it('never borrows the loaded map’s same-named vehicle for an AGV of another map', () => {
      expect(resolveKernelStatus(true, vehicle('TO_BE_UTILIZED'), false)).toBe(
        'other_map',
      );
    });
  });

  describe('toAgvDto', () => {
    it('maps the entity fields and the supplied kernel status', () => {
      const dto = toAgvDto(
        entity({ name: 'V9', criticalBatteryThreshold: 25 }),
        'connected',
      );
      expect(dto).toMatchObject({
        name: 'V9',
        criticalBatteryThreshold: 25,
        sufficientBatteryThreshold: 60,
        acceptanceStatus: 'ENABLED',
        kernelStatus: 'connected',
      });
    });

    it('does not leak entity-only fields such as updatedAt', () => {
      const dto = toAgvDto(entity(), 'unknown');
      expect('updatedAt' in dto).toBe(false);
    });

    it('carries no live telemetry — the registry path stays config-only', () => {
      const dto = toAgvDto(entity(), 'connected');
      expect('errors' in dto).toBe(false);
      expect('vehicleState' in dto).toBe(false);
    });
  });

  describe('toAgvStateChangeDto', () => {
    const transition = (
      o: Partial<VehicleStateTransitionEntity> = {},
    ): VehicleStateTransitionEntity => ({
      id: '7',
      sessionId: '2',
      vehicleName: 'V1',
      pointName: 'P-02',
      procState: 'IDLE',
      vehicleState: 'IDLE',
      orderName: null,
      occurredAt: new Date('2026-08-01T00:00:00Z'),
      observedAt: new Date('2026-08-01T00:00:01Z'),
      ...o,
    });

    it('maps every observable column of the transition row', () => {
      expect(toAgvStateChangeDto(transition())).toEqual({
        id: '7',
        vehicleName: 'V1',
        pointName: 'P-02',
        procState: 'IDLE',
        vehicleState: 'IDLE',
        orderName: null,
        occurredAt: new Date('2026-08-01T00:00:00Z'),
        observedAt: new Date('2026-08-01T00:00:01Z'),
      });
    });

    it('does not leak the SSE session id', () => {
      expect('sessionId' in toAgvStateChangeDto(transition())).toBe(false);
    });
  });

  describe('toAgvErrorEventDto', () => {
    const event = (
      o: Partial<VehicleErrorEventEntity> = {},
    ): VehicleErrorEventEntity => ({
      id: '9',
      vehicleName: 'V1',
      kind: 'RAISED',
      fatalErrorTypes: ['motorOverheat'],
      warningErrorTypes: ['noRouteError'],
      vehicleState: 'ERROR',
      pointName: 'P-03',
      transportOrderName: 'PICKUP-x',
      metadata: { source: 'sse' },
      occurredAt: new Date('2026-08-01T00:00:00Z'),
      observedAt: null,
      mapRecordId: null,
      ...o,
    });

    it('maps the fault row including both error type lists', () => {
      expect(toAgvErrorEventDto(event())).toEqual({
        id: '9',
        vehicleName: 'V1',
        kind: 'RAISED',
        fatalErrorTypes: ['motorOverheat'],
        warningErrorTypes: ['noRouteError'],
        vehicleState: 'ERROR',
        pointName: 'P-03',
        transportOrderName: 'PICKUP-x',
        metadata: { source: 'sse' },
        occurredAt: new Date('2026-08-01T00:00:00Z'),
        observedAt: null,
      });
    });

    it('keeps recovery rows distinguishable by kind', () => {
      expect(toAgvErrorEventDto(event({ kind: 'RECOVERY_REFUSED' })).kind).toBe(
        'RECOVERY_REFUSED',
      );
    });
  });
});
