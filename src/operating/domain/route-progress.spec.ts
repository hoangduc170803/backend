import {
  computeRouteProgress,
  realInstant,
  toTransportOrderDto,
  type RawOrder,
} from './route-progress';

describe('computeRouteProgress', () => {
  it('reports 0% and all points ahead for an order that has not moved yet', () => {
    const order: RawOrder = {
      currentDriveOrderIndex: 0,
      currentRouteStepIndex: -1,
      driveOrders: [
        {
          route: {
            steps: [
              { routeIndex: 0, destinationPoint: 'P1' },
              { routeIndex: 1, destinationPoint: 'P2' },
            ],
          },
        },
      ],
    };

    expect(computeRouteProgress(order)).toEqual({
      points: ['P1', 'P2'],
      percent: 0,
      steps: [
        { point: 'P1', driven: false },
        { point: 'P2', driven: false },
      ],
    });
  });

  it('marks steps up to and including the current index as driven, on the current drive order', () => {
    const order: RawOrder = {
      currentDriveOrderIndex: 0,
      currentRouteStepIndex: 0,
      driveOrders: [
        {
          route: {
            steps: [
              { routeIndex: 0, destinationPoint: 'P1' },
              { routeIndex: 1, destinationPoint: 'P2' },
            ],
          },
        },
      ],
    };

    const result = computeRouteProgress(order);
    expect(result.percent).toBe(50);
    expect(result.points).toEqual(['P2']);
    expect(result.steps).toEqual([
      { point: 'P1', driven: true },
      { point: 'P2', driven: false },
    ]);
  });

  it('marks every step of an earlier drive order as driven regardless of its own route index', () => {
    const order: RawOrder = {
      currentDriveOrderIndex: 1,
      currentRouteStepIndex: 0,
      driveOrders: [
        {
          route: {
            steps: [
              { routeIndex: 0, destinationPoint: 'A1' },
              { routeIndex: 1, destinationPoint: 'A2' },
            ],
          },
        },
        {
          route: {
            steps: [
              { routeIndex: 0, destinationPoint: 'B1' },
              { routeIndex: 1, destinationPoint: 'B2' },
            ],
          },
        },
      ],
    };

    const result = computeRouteProgress(order);
    expect(result.percent).toBe(75); // 3 of 4 steps driven: A1, A2, B1
    expect(result.points).toEqual(['B2']);
  });

  it('reports 100% once every step across every drive order is driven', () => {
    const order: RawOrder = {
      currentDriveOrderIndex: 0,
      currentRouteStepIndex: 0,
      driveOrders: [
        { route: { steps: [{ routeIndex: 0, destinationPoint: 'P1' }] } },
      ],
    };

    expect(computeRouteProgress(order).percent).toBe(100);
  });

  it('returns a zero-progress, empty-steps result for a null order (not found / kernel error)', () => {
    expect(computeRouteProgress(null)).toEqual({
      points: [],
      percent: 0,
      steps: [],
    });
  });

  it('returns 0% for a route with no steps at all rather than dividing by zero', () => {
    const order: RawOrder = {
      currentDriveOrderIndex: 0,
      currentRouteStepIndex: -1,
      driveOrders: [],
    };
    expect(computeRouteProgress(order)).toEqual({
      points: [],
      percent: 0,
      steps: [],
    });
  });

  it('skips steps with no destination point from points/steps but still counts them toward percent', () => {
    const order: RawOrder = {
      currentDriveOrderIndex: 0,
      currentRouteStepIndex: -1,
      driveOrders: [
        {
          route: {
            steps: [
              { routeIndex: 0 },
              { routeIndex: 1, destinationPoint: 'P2' },
            ],
          },
        },
      ],
    };

    const result = computeRouteProgress(order);
    expect(result.points).toEqual(['P2']);
    expect(result.steps).toEqual([{ point: 'P2', driven: false }]);
  });
});

describe('realInstant', () => {
  it('treats null/undefined as not finished', () => {
    expect(realInstant(null)).toBeNull();
    expect(realInstant(undefined)).toBeNull();
  });

  it('treats an unparsable date string as not finished', () => {
    expect(realInstant('not-a-date')).toBeNull();
  });

  it("treats openTCS's Instant.MAX sentinel as not finished", () => {
    // openTCS serializes Instant.MAX as a far-future ISO string outside what Date can represent.
    expect(realInstant('+1000000000-12-31T23:59:59.999999999Z')).toBeNull();
  });

  it('passes through a real, parsable timestamp unchanged', () => {
    expect(realInstant('2026-09-14T12:00:00.000Z')).toBe(
      '2026-09-14T12:00:00.000Z',
    );
  });
});

describe('toTransportOrderDto', () => {
  it('defaults every optional field to a safe empty value', () => {
    expect(toTransportOrderDto({})).toEqual({
      name: '',
      type: '',
      state: '',
      processingVehicle: null,
      intendedVehicle: null,
      wrappingSequence: null,
      destinations: [],
      creationTime: null,
      finishedTime: null,
      taskId: null,
    });
  });

  it('maps a fully populated raw order through unchanged', () => {
    const raw: RawOrder = {
      name: 'PICKUP-V1-P1-uuid',
      type: 'PICKUP',
      state: 'BEING_PROCESSED',
      processingVehicle: 'V1',
      intendedVehicle: 'V1',
      wrappingSequence: null,
      destinations: [{ locationName: 'P1', operation: 'MOVE' }],
      properties: [{ key: 'wes:taskId', value: 'task-1' }],
      creationTime: '2026-09-14T00:00:00.000Z',
      finishedTime: null,
    };

    expect(toTransportOrderDto(raw)).toEqual({
      name: 'PICKUP-V1-P1-uuid',
      type: 'PICKUP',
      state: 'BEING_PROCESSED',
      processingVehicle: 'V1',
      intendedVehicle: 'V1',
      wrappingSequence: null,
      destinations: [{ locationName: 'P1', operation: 'MOVE' }],
      creationTime: '2026-09-14T00:00:00.000Z',
      finishedTime: null,
      taskId: 'task-1',
    });
  });
});
