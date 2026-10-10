import { kernelSessionStub } from '../kernel-session/kernel-session.testing';
import { DropoffCommitLoop } from './dropoff-commit.loop';
import { VehicleAimService } from './vehicle-aim.service';
import { CargoStatus } from './entities/cargo.entity';
import { TaskStatus } from './entities/transport-task.entity';
import type { SlotCommitResult } from './slot-reservation.service';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';

const GATE = 'D1';
const WAIT = 'W-D';
const INSIDE = 'D2';
const OUTSIDE = '0005';
const CROSSING = 'W-S';

function slot(name: string) {
  return { locationName: name, pointName: name };
}

const LAYOUT = {
  mainlinePoints: new Set<string>(),
  columns: [
    [slot('D3'), slot('S3')],
    [slot('D2'), slot('S2')],
    [slot('D1'), slot('S1')],
  ],
  lanes: [
    {
      axis: 1000,
      slots: [slot('S3'), slot('S2'), slot('S1')],
      axisPoints: ['S3', 'S2', 'S1', WAIT, 'W-S2'],
      axisAlong: [0, 1000, 2000, 3000, 4000],
    },
    {
      axis: 2000,
      slots: [slot('D3'), slot('D2'), slot('D1')],
      axisPoints: ['D3', 'D2', 'D1', 'W-D', 'W-D2'],
      axisAlong: [0, 1000, 2000, 3000, 4000],
    },
  ],
  entryPoints: ['S1', 'D1'],
  memberPointNames: new Set(['D1', 'D2', 'D3', 'S1', 'S2', 'S3']),
  strandedLocationNames: [],
};

const KEPT_OWN_SLOT: SlotCommitResult = {
  slot: 'D3',
  keptOwnReservation: true,
  displaced: null,
};

const COMMITTED_SHALLOWEST: SlotCommitResult = {
  slot: 'D1',
  keptOwnReservation: true,
  displaced: null,
};

const STOLE_FROM_CARGO_2: SlotCommitResult = {
  slot: 'D3',
  keptOwnReservation: false,
  displaced: { cargoId: 'cargo-2', lostSlot: 'D3', replacementSlot: 'D2' },
};

interface FleetMember {
  vehicle: string;
  taskId: string;
  cargoId: string;
  position: string;
  cargo?: Record<string, unknown>;
  unloaded?: boolean;
  approach?: string;
}

function solo(
  position: string,
  cargo?: Record<string, unknown>,
): FleetMember[] {
  return [
    { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position, cargo },
  ];
}

function makeLoop(
  options: {
    fleet?: FleetMember[];
    commits?: Record<string, SlotCommitResult | null>;
    victimTask?: Record<string, unknown> | null;
    cargoWithoutATask?: { id: string; reserved: string }[];
  } = {},
) {
  const fleet = options.fleet ?? solo(OUTSIDE);
  const tasks = fleet.map((member) => ({
    id: member.taskId,
    status: TaskStatus.DELIVERING,
    cargoId: member.cargoId,
    metadata: {
      assignedVehicleName: member.vehicle,
      dropoffOrderName: `DROPOFF-${member.vehicle}-old`,
      // `ApproachOrderService.aim` always sets these two fields together — a vehicle already
      // aimed somewhere never has one without the other, so the fixture shouldn't either.
      ...(member.approach
        ? {
            approachPointName: member.approach,
            approachOrderName: `APPROACH-${member.vehicle}-active`,
          }
        : {}),
      ...(member.unloaded ? { unloadedAt: '2026-08-18T00:00:00.000Z' } : {}),
    },
  }));
  const cargos = [
    ...fleet.map((member) => ({
      id: member.cargoId,
      destinationZoneId: 'zone-1',
      destinationLocationName: null,
      reservedLocationName: 'D3',
      status: CargoStatus.ACTIVE,
      ...member.cargo,
    })),
    ...(options.cargoWithoutATask ?? []).map((orphan) => ({
      id: orphan.id,
      destinationZoneId: 'zone-1',
      destinationLocationName: null,
      reservedLocationName: orphan.reserved,
      status: CargoStatus.ACTIVE,
    })),
  ];
  const positionByVehicle = new Map(
    fleet.map((member) => [member.vehicle, member.position]),
  );
  const victimTask =
    options.victimTask === undefined
      ? {
          id: 'task-2',
          status: TaskStatus.DELIVERING,
          cargoId: 'cargo-2',
          metadata: {
            assignedVehicleName: 'V2',
            dropoffOrderName: 'DROPOFF-V2-old',
          },
        }
      : options.victimTask;

  const taskRepo = {
    find: jest.fn().mockResolvedValue(tasks),
    findOne: jest.fn().mockResolvedValue(victimTask),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const cargoRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(cargos.find((cargo) => cargo.id === where.id) ?? null),
    ),
    find: jest.fn(
      ({
        where,
      }: {
        where: { destinationLocationName?: { type?: string } };
      }) => {
        const wantsUncommitted =
          where?.destinationLocationName?.type === 'isNull';
        return Promise.resolve(
          cargos.filter((cargo) =>
            wantsUncommitted
              ? !cargo.destinationLocationName
              : !!cargo.destinationLocationName,
          ),
        );
      },
    ),
  };
  const zoneRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'zone-1', name: 'zone_1' }),
  };
  const vehicleStore = {
    get: jest.fn((name: string) => ({
      currentPosition: positionByVehicle.get(name) ?? OUTSIDE,
    })),
  };
  const deliverySlotEngine = { layoutFor: jest.fn().mockResolvedValue(LAYOUT) };
  const slotReservation = {
    claimCell: jest.fn().mockResolvedValue({ previous: null }),
    restoreClaim: jest.fn().mockResolvedValue(undefined),
    releaseCommit: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn((cargoId: string) =>
      Promise.resolve(
        options.commits && cargoId in options.commits
          ? options.commits[cargoId]
          : KEPT_OWN_SLOT,
      ),
    ),
  };
  const dropoffOrder = {
    issue: jest.fn().mockResolvedValue('DROPOFF-new'),
    reissue: jest.fn().mockResolvedValue('DROPOFF-new'),
  };
  const approachOrder = {
    aim: jest.fn().mockResolvedValue('APPROACH-new'),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  const vehicleAim = new VehicleAimService(
    slotReservation as never,
    approachOrder as never,
    dropoffOrder as never,
    vehicleStore as never,
    taskRepo as never,
    { latestActiveOrder: jest.fn().mockResolvedValue(null) } as never,
  );

  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([{ locked: true }]),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

  const loop = new DropoffCommitLoop(
    taskRepo as never,
    cargoRepo as never,
    zoneRepo as never,
    dataSource as never,
    vehicleStore as never,
    deliverySlotEngine as never,
    slotReservation as never,
    vehicleAim,
    fixedActiveMap(),
    kernelSessionStub(),
  );

  return {
    loop,
    taskRepo,
    slotReservation,
    dropoffOrder,
    approachOrder,
    vehicleAim,
    queryRunner,
    dataSource,
    tasks,
    victimTask,
  };
}

describe('DropoffCommitLoop trigger', () => {
  it('commits as soon as the vehicle reaches the axis of its own lane', async () => {
    const { loop, slotReservation } = makeLoop({ fleet: solo(WAIT) });

    await loop.tick();

    expect(slotReservation.commit).toHaveBeenCalledWith(
      'cargo-1',
      expect.objectContaining({ id: 'zone-1' }),
      {
        blockedLocationNames: new Set(),
        unstealableLocationNames: new Set(),
        lane: LAYOUT.lanes[1],
        requesterVehicleName: 'V1',
      },
    );
  });

  it('commits just the same once the vehicle stands on a slot', async () => {
    const { loop, slotReservation } = makeLoop({ fleet: solo(INSIDE) });

    await loop.tick();

    expect(slotReservation.commit).toHaveBeenCalledWith(
      'cargo-1',
      expect.anything(),
      {
        blockedLocationNames: new Set(),
        unstealableLocationNames: new Set(),
        lane: LAYOUT.lanes[1],
        requesterVehicleName: 'V1',
      },
    );
  });

  it('leaves a vehicle that is not on any lane axis alone', async () => {
    const { loop, slotReservation } = makeLoop({ fleet: solo(OUTSIDE) });

    await loop.tick();

    expect(slotReservation.commit).not.toHaveBeenCalled();
  });

  it('leaves a vehicle crossing another lane on its way to its own alone', async () => {
    const { loop, slotReservation } = makeLoop({ fleet: solo(CROSSING) });

    await loop.tick();

    expect(slotReservation.commit).not.toHaveBeenCalled();
  });

  it('never offers a slot in the lane the vehicle is only passing through', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: solo('S2', { reservedLocationName: 'D3' }),
    });

    await loop.tick();

    expect(slotReservation.commit).not.toHaveBeenCalled();
  });

  it('leaves a cargo that has been aimed at nothing alone', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: solo(INSIDE, { reservedLocationName: null }),
    });

    await loop.tick();

    expect(slotReservation.commit).not.toHaveBeenCalled();
  });

  it('skips a cargo whose slot is already committed', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: solo(GATE, { destinationLocationName: 'D3' }),
    });

    await loop.tick();

    expect(slotReservation.commit).not.toHaveBeenCalled();
  });
});

describe('DropoffCommitLoop ordering', () => {
  it('serves the vehicle deepest in the lane first', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: [
        { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: WAIT },
        {
          vehicle: 'V2',
          taskId: 'task-2',
          cargoId: 'cargo-2',
          position: INSIDE,
        },
      ],
    });

    await loop.tick();

    expect(slotReservation.commit.mock.calls.map((call) => call[0])).toEqual([
      'cargo-2',
      'cargo-1',
    ]);
  });
});

describe('DropoffCommitLoop order re-issue', () => {
  it('leaves the order alone when the commit matches the reservation', async () => {
    const { loop, dropoffOrder } = makeLoop({ fleet: solo(GATE) });

    await loop.tick();

    expect(dropoffOrder.reissue).not.toHaveBeenCalled();
  });

  it('re-aims the committing vehicle when it took a different slot', async () => {
    const { loop, dropoffOrder, tasks } = makeLoop({
      fleet: solo(GATE),
      commits: {
        'cargo-1': { slot: 'D2', keptOwnReservation: false, displaced: null },
      },
    });

    await loop.tick();

    expect(dropoffOrder.reissue).toHaveBeenCalledWith(tasks[0], 'V1', 'D2', {
      id: 'zone-1',
      name: 'zone_1',
    });
  });

  it('leaves the cargo it stole from waiting, without an order of its own', async () => {
    const { loop, dropoffOrder, taskRepo, victimTask } = makeLoop({
      fleet: solo(GATE),
      commits: { 'cargo-1': STOLE_FROM_CARGO_2 },
    });

    await loop.tick();

    expect(dropoffOrder.reissue).not.toHaveBeenCalledWith(
      victimTask,
      'V2',
      'D2',
      expect.anything(),
    );
    expect(taskRepo.save).toHaveBeenCalledWith(victimTask);
  });

  it('reuses the displaced task this tick already holds instead of re-reading it', async () => {
    const { loop, taskRepo, tasks } = makeLoop({
      fleet: [
        { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: GATE },
        { vehicle: 'V2', taskId: 'task-2', cargoId: 'cargo-2', position: GATE },
      ],
      commits: { 'cargo-1': STOLE_FROM_CARGO_2 },
      victimTask: null,
    });

    await loop.tick();

    expect(taskRepo.save).toHaveBeenCalledWith(tasks[1]);
    expect(taskRepo.findOne).not.toHaveBeenCalled();
  });

  it('counts the swap on the task it displaced', async () => {
    const { loop, taskRepo } = makeLoop({
      fleet: solo(GATE),
      commits: { 'cargo-1': STOLE_FROM_CARGO_2 },
    });

    await loop.tick();

    const saved = taskRepo.save.mock.calls[0][0] as {
      metadata: { swapCount: number };
    };
    expect(saved.metadata.swapCount).toBe(1);
  });

  it('does not re-aim a displaced cargo that has nowhere left to go', async () => {
    const { loop, dropoffOrder } = makeLoop({
      fleet: solo(GATE),
      commits: {
        'cargo-1': {
          slot: 'D3',
          keptOwnReservation: true,
          displaced: {
            cargoId: 'cargo-2',
            lostSlot: 'D3',
            replacementSlot: null,
          },
        },
      },
    });

    await loop.tick();

    expect(dropoffOrder.reissue).not.toHaveBeenCalled();
  });
});

describe('DropoffCommitLoop lane admission', () => {
  const inFlight = (overrides: Record<string, unknown> = {}) => ({
    vehicle: 'V9',
    taskId: 'task-9',
    cargoId: 'cargo-9',
    position: 'D3',
    cargo: { destinationLocationName: 'D3' },
    ...overrides,
  });

  function blockedIn(call: unknown): string[] {
    const [, , options] = call as [
      string,
      unknown,
      { blockedLocationNames: ReadonlySet<string> },
    ];
    return [...options.blockedLocationNames].sort();
  }

  it('blocks every slot of a lane another vehicle is still working', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: [
        { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: GATE },
        inFlight(),
      ],
    });

    await loop.tick();

    const call = slotReservation.commit.mock.calls.find(
      (candidate) => candidate[0] === 'cargo-1',
    );
    expect(blockedIn(call)).toEqual(['D1', 'D2', 'D3']);
  });

  it('frees the lane once the vehicle unloaded and drove off its slots', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: [
        { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: GATE },
        inFlight({ position: OUTSIDE, unloaded: true }),
      ],
    });

    await loop.tick();

    const call = slotReservation.commit.mock.calls.find(
      (candidate) => candidate[0] === 'cargo-1',
    );
    expect(blockedIn(call)).toEqual([]);
  });

  it('keeps the lane blocked while the vehicle sits on its retreat cell', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: [
        { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: GATE },
        inFlight({ position: 'D1', unloaded: true }),
      ],
    });

    await loop.tick();

    const call = slotReservation.commit.mock.calls.find(
      (candidate) => candidate[0] === 'cargo-1',
    );
    expect(blockedIn(call)).toEqual(['D1', 'D2', 'D3']);
  });
});

describe('DropoffCommitLoop queue re-aim', () => {
  it('sends the vehicles still waiting for that lane to the cells behind the retreat', async () => {
    const { loop, approachOrder, tasks } = makeLoop({
      fleet: [
        {
          vehicle: 'V1',
          taskId: 'task-1',
          cargoId: 'cargo-1',
          position: 'D3',
        },
        {
          vehicle: 'V2',
          taskId: 'task-2',
          cargoId: 'cargo-2',
          position: 'W-D',
          cargo: { reservedLocationName: 'D2' },
        },
        {
          vehicle: 'V3',
          taskId: 'task-3',
          cargoId: 'cargo-3',
          position: 'W-D2',
          cargo: { reservedLocationName: 'D1' },
        },
      ],
      commits: { 'cargo-2': null, 'cargo-3': null },
      victimTask: null,
    });

    await loop.tick();

    expect(approachOrder.aim.mock.calls).toEqual([
      [tasks[1], 'V2', { pointName: 'W-D' }],
      [tasks[2], 'V3', { pointName: 'W-D2' }],
    ]);
  });

  it('leaves nobody to re-aim when the lane has no cells behind the retreat', async () => {
    const { loop, approachOrder } = makeLoop({
      fleet: [
        {
          vehicle: 'V1',
          taskId: 'task-1',
          cargoId: 'cargo-1',
          position: 'D1',
        },
        {
          vehicle: 'V2',
          taskId: 'task-2',
          cargoId: 'cargo-2',
          position: 'W-D2',
          cargo: { reservedLocationName: 'D2' },
        },
      ],
      commits: { 'cargo-1': COMMITTED_SHALLOWEST, 'cargo-2': null },
      victimTask: null,
    });

    await loop.tick();

    expect(approachOrder.aim).not.toHaveBeenCalled();
  });
});

describe('DropoffCommitLoop order handover', () => {
  const TOOK_A_DIFFERENT_SLOT: SlotCommitResult = {
    slot: 'D2',
    keptOwnReservation: false,
    displaced: null,
  };

  const convoy = (): FleetMember[] => [
    { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: INSIDE },
    {
      vehicle: 'V2',
      taskId: 'task-2',
      cargoId: 'cargo-2',
      position: 'W-D',
      cargo: { reservedLocationName: 'D2' },
    },
  ];

  it('cancels the stale approach order when the commit lands in another lane', async () => {
    const { loop, approachOrder, dropoffOrder, tasks } = makeLoop({
      fleet: [
        {
          vehicle: 'V1',
          taskId: 'task-1',
          cargoId: 'cargo-1',
          position: GATE,
          approach: 'S1',
        },
      ],
      commits: { 'cargo-1': TOOK_A_DIFFERENT_SLOT },
    });

    await loop.tick();

    expect(approachOrder.cancel).toHaveBeenCalledWith(tasks[0]);
    expect(dropoffOrder.reissue.mock.invocationCallOrder[0]).toBeLessThan(
      approachOrder.cancel.mock.invocationCallOrder[0],
    );
  });

  it('drops the approach claim even when the commit is further down the same lane', async () => {
    const { loop, approachOrder, tasks } = makeLoop({
      fleet: [
        {
          vehicle: 'V1',
          taskId: 'task-1',
          cargoId: 'cargo-1',
          position: INSIDE,
          approach: 'D2',
        },
      ],
      commits: {
        'cargo-1': { slot: 'D3', keptOwnReservation: false, displaced: null },
      },
    });

    await loop.tick();

    expect(approachOrder.cancel).toHaveBeenCalledWith(tasks[0]);
  });

  it('releases the slot and keeps the old order when the kernel refuses', async () => {
    const { loop, approachOrder, slotReservation, dropoffOrder } = makeLoop({
      fleet: solo(GATE),
      commits: { 'cargo-1': TOOK_A_DIFFERENT_SLOT },
    });
    dropoffOrder.reissue.mockResolvedValueOnce(null);

    await loop.tick();

    expect(slotReservation.releaseCommit).toHaveBeenCalledWith(
      'cargo-1',
      expect.anything(),
    );
    expect(approachOrder.cancel).not.toHaveBeenCalled();
  });

  it('sends a fresh order to the vehicle it took the slot from', async () => {
    const { loop, approachOrder } = makeLoop({
      fleet: convoy(),
      commits: { 'cargo-1': STOLE_FROM_CARGO_2, 'cargo-2': null },
    });

    await loop.tick();

    expect(approachOrder.aim).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-2' }),
      'V2',
      { pointName: 'W-D' },
    );
  });

  it('keeps serving the rest of the lane when one vehicle throws', async () => {
    const { loop, slotReservation } = makeLoop({ fleet: convoy() });
    slotReservation.commit.mockRejectedValueOnce(new Error('boom'));

    await loop.tick();

    expect(slotReservation.commit).toHaveBeenCalledTimes(2);
  });
});

describe('DropoffCommitLoop single runner', () => {
  it('stays idle while another instance holds the lock', async () => {
    const { loop, slotReservation, queryRunner } = makeLoop({
      fleet: solo(GATE),
    });
    queryRunner.query.mockResolvedValue([{ locked: false }]);

    await loop.tick();

    expect(slotReservation.commit).not.toHaveBeenCalled();
  });

  it('gives the connection back when the lock is refused', async () => {
    const { loop, queryRunner } = makeLoop({ fleet: solo(GATE) });
    queryRunner.query.mockResolvedValue([{ locked: false }]);

    await loop.tick();

    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('gives the connection back when the database is unreachable', async () => {
    const { loop, slotReservation, queryRunner } = makeLoop({
      fleet: solo(GATE),
    });
    queryRunner.connect.mockRejectedValue(new Error('down'));

    await loop.tick();

    expect(queryRunner.release).toHaveBeenCalled();
    expect(slotReservation.commit).not.toHaveBeenCalled();
  });

  it('takes over on a later tick once the lock frees up', async () => {
    const { loop, slotReservation, queryRunner } = makeLoop({
      fleet: solo(GATE),
    });
    queryRunner.query.mockResolvedValueOnce([{ locked: false }]);

    await loop.tick();
    expect(slotReservation.commit).not.toHaveBeenCalled();

    await loop.tick();
    expect(slotReservation.commit).toHaveBeenCalled();
  });

  it('only asks for the lock once while it still holds it', async () => {
    const { loop, dataSource } = makeLoop({ fleet: solo(GATE) });

    await loop.tick();
    await loop.tick();

    expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(1);
  });
});

describe('DropoffCommitLoop cell handover', () => {
  const swap = (victimApproach?: string): FleetMember[] => [
    { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: GATE },
    {
      vehicle: 'V2',
      taskId: 'task-2',
      cargoId: 'cargo-2',
      position: WAIT,
      approach: victimApproach,
    },
  ];

  const stealing = {
    'cargo-1': STOLE_FROM_CARGO_2,
    'cargo-2': null,
  };

  it('withdraws the loser claim on the cell before the winner asks for it', async () => {
    const { loop, approachOrder, dropoffOrder, tasks } = makeLoop({
      fleet: swap('D3'),
      commits: stealing,
      victimTask: null,
    });

    await loop.tick();

    expect(approachOrder.cancel).toHaveBeenCalledWith(tasks[1]);
    expect(approachOrder.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      dropoffOrder.reissue.mock.invocationCallOrder[0],
    );
  });

  it('leaves the loser order alone when it was never aimed at that cell', async () => {
    const { loop, approachOrder } = makeLoop({
      fleet: swap('D1'),
      commits: stealing,
      victimTask: null,
    });

    await loop.tick();

    expect(approachOrder.cancel).not.toHaveBeenCalled();
  });

  it('puts the loser back on an order when the kernel refuses the winner', async () => {
    const { loop, approachOrder, slotReservation, dropoffOrder, tasks } =
      makeLoop({
        fleet: swap('D3'),
        commits: stealing,
        victimTask: null,
      });
    dropoffOrder.reissue.mockResolvedValueOnce(null);

    await loop.tick();

    expect(slotReservation.releaseCommit).toHaveBeenCalledWith(
      'cargo-1',
      expect.anything(),
    );
    expect(approachOrder.aim).toHaveBeenCalledWith(tasks[1], 'V2', {
      locationName: 'D2',
    });
  });

  it('leaves the loser without an order when nothing is left to give it', async () => {
    const { loop, approachOrder, dropoffOrder } = makeLoop({
      fleet: swap('D3'),
      commits: {
        'cargo-1': {
          slot: 'D3',
          keptOwnReservation: false,
          displaced: {
            cargoId: 'cargo-2',
            lostSlot: 'D3',
            replacementSlot: null,
          },
        },
        'cargo-2': null,
      },
      victimTask: null,
    });
    dropoffOrder.reissue.mockResolvedValueOnce(null);

    await loop.tick();

    expect(approachOrder.aim).not.toHaveBeenCalled();
  });
});

describe('DropoffCommitLoop cells held ahead', () => {
  function unstealableIn(call: unknown): string[] {
    const [, , options] = call as [
      string,
      unknown,
      { unstealableLocationNames: ReadonlySet<string> },
    ];
    return [...options.unstealableLocationNames].sort();
  }

  const queueBehind = (): FleetMember[] => [
    {
      vehicle: 'V1',
      taskId: 'task-1',
      cargoId: 'cargo-1',
      position: WAIT,
      cargo: { reservedLocationName: 'D2' },
    },
    {
      vehicle: 'V2',
      taskId: 'task-2',
      cargoId: 'cargo-2',
      position: INSIDE,
      cargo: { reservedLocationName: 'D3' },
    },
  ];

  it('fences off the cell a vehicle ahead in the lane still holds', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: queueBehind(),
      commits: { 'cargo-1': null, 'cargo-2': null },
      victimTask: null,
    });

    await loop.tick();

    const call = slotReservation.commit.mock.calls.find(
      (candidate) => candidate[0] === 'cargo-1',
    );
    expect(unstealableIn(call)).toEqual(['D3']);
  });

  it('fences off nothing for the vehicle that is furthest in', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: queueBehind(),
      commits: { 'cargo-1': null, 'cargo-2': null },
      victimTask: null,
    });

    await loop.tick();

    const call = slotReservation.commit.mock.calls.find(
      (candidate) => candidate[0] === 'cargo-2',
    );
    expect(unstealableIn(call)).toEqual([]);
  });

  it('ignores a cell held by a vehicle that has not reached the lane', async () => {
    const { loop, slotReservation } = makeLoop({
      fleet: [
        { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: GATE },
        {
          vehicle: 'V2',
          taskId: 'task-2',
          cargoId: 'cargo-2',
          position: OUTSIDE,
          cargo: { reservedLocationName: 'D3' },
        },
      ],
      commits: { 'cargo-1': null },
      victimTask: null,
    });

    await loop.tick();

    const call = slotReservation.commit.mock.calls.find(
      (candidate) => candidate[0] === 'cargo-1',
    );
    expect(unstealableIn(call)).toEqual([]);
  });
});

describe('DropoffCommitLoop queue seating', () => {
  const laneQueue = (): FleetMember[] => [
    { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: 'D3' },
    {
      vehicle: 'V2',
      taskId: 'task-2',
      cargoId: 'cargo-2',
      position: 'W-D',
      cargo: { reservedLocationName: 'D2' },
    },
  ];

  it('skips a waiting cell that a cargo outside the queue already holds', async () => {
    const { loop, approachOrder, tasks } = makeLoop({
      fleet: laneQueue(),
      commits: { 'cargo-2': null },
      victimTask: null,
      cargoWithoutATask: [{ id: 'cargo-9', reserved: 'W-D' }],
    });

    await loop.tick();

    expect(approachOrder.aim).toHaveBeenCalledWith(tasks[1], 'V2', {
      pointName: 'W-D2',
    });
  });

  it('takes the nearest waiting cell when nobody else holds it', async () => {
    const { loop, approachOrder, tasks } = makeLoop({
      fleet: laneQueue(),
      commits: { 'cargo-2': null },
      victimTask: null,
    });

    await loop.tick();

    expect(approachOrder.aim).toHaveBeenCalledWith(tasks[1], 'V2', {
      pointName: 'W-D',
    });
  });

  it('leaves a vehicle alone when it already waits where it belongs', async () => {
    const { loop, approachOrder } = makeLoop({
      fleet: [
        { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: 'D3' },
        {
          vehicle: 'V2',
          taskId: 'task-2',
          cargoId: 'cargo-2',
          position: 'W-D',
          cargo: { reservedLocationName: 'W-D' },
          approach: 'W-D',
        },
      ],
      commits: { 'cargo-2': null },
      victimTask: null,
    });

    await loop.tick();

    expect(approachOrder.aim).not.toHaveBeenCalled();
  });
});

describe('DropoffCommitLoop queue seating stays put', () => {
  it('does not shuffle the queue when two vehicles pass each other', async () => {
    const { loop, approachOrder } = makeLoop({
      fleet: [
        { vehicle: 'V1', taskId: 'task-1', cargoId: 'cargo-1', position: 'D3' },
        {
          vehicle: 'V2',
          taskId: 'task-2',
          cargoId: 'cargo-2',
          position: 'W-D2',
          cargo: { reservedLocationName: 'W-D' },
          approach: 'W-D',
        },
        {
          vehicle: 'V3',
          taskId: 'task-3',
          cargoId: 'cargo-3',
          position: 'W-D',
          cargo: { reservedLocationName: 'W-D2' },
          approach: 'W-D2',
        },
      ],
      commits: { 'cargo-2': null, 'cargo-3': null },
      victimTask: null,
    });

    await loop.tick();

    expect(approachOrder.aim).not.toHaveBeenCalled();
  });
});
