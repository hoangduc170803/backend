import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from '../../cargo/entities/transport-task.entity';
import type { CargoEntity } from '../../cargo/entities/cargo.entity';
import { currentLegOf, legsOf, toTaskDto } from './task-view';

function task(
  overrides: Partial<TransportTaskEntity> = {},
): TransportTaskEntity {
  return {
    id: 'task-1',
    requestCode: 'TR-1',
    cargoId: 'cargo-1',
    kind: TaskKind.CARGO,
    mapRecordId: 'map-a',
    status: TaskStatus.READY_TO_ASSIGN,
    metadata: {},
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date('2026-09-23T01:00:00Z'),
    updatedAt: new Date('2026-09-23T01:05:00Z'),
    ...overrides,
  };
}

describe('task-view', () => {
  it('lists the legs a task has issued, in driving order', () => {
    expect(
      legsOf(
        task({
          metadata: {
            dropoffOrderName: 'DROPOFF-x',
            pickupOrderName: 'PICKUP-x',
          },
        }),
      ),
    ).toEqual([
      { kind: 'PICKUP', orderName: 'PICKUP-x' },
      { kind: 'DROPOFF', orderName: 'DROPOFF-x' },
    ]);
  });

  it.each([
    [TaskStatus.READY_TO_ASSIGN, {}, null],
    [TaskStatus.PICKING_UP, {}, 'PICKUP'],
    [TaskStatus.DELIVERING, { approachOrderName: 'A' }, 'APPROACH'],
    [TaskStatus.DELIVERING, { dropoffOrderName: 'D' }, 'DROPOFF'],
    [TaskStatus.DELIVERY_COMPLETED, { dropoffOrderName: 'D' }, null],
  ])('current leg of %s %j is %s', (status, metadata, expected) => {
    expect(currentLegOf(task({ status, metadata }))).toBe(expected);
  });

  it('flattens task, cargo and zone into one row', () => {
    const cargo = {
      itemCode: 'BOX-1',
      sourcePointName: 'P1',
      sourcePickupLocationName: 'LOC-1',
      destinationZoneId: 'zone-1',
      destinationLocationName: null,
    } as unknown as CargoEntity;

    const dto = toTaskDto(
      task({
        status: TaskStatus.PICKING_UP,
        metadata: { assignedVehicleName: 'V1', pickupOrderName: 'PICKUP-x' },
        assignedAt: new Date('2026-09-23T01:01:00Z'),
      }),
      { cargo, destinationZoneName: 'Khu A', failureReason: null },
    );

    expect(dto).toMatchObject({
      taskId: 'task-1',
      requestCode: 'TR-1',
      status: TaskStatus.PICKING_UP,
      itemCode: 'BOX-1',
      vehicle: 'V1',
      pickupPointName: 'P1',
      destinationZoneName: 'Khu A',
      currentLeg: 'PICKUP',
      legs: [{ kind: 'PICKUP', orderName: 'PICKUP-x' }],
      assignedAt: '2026-09-23T01:01:00.000Z',
      completedAt: null,
    });
  });
});
