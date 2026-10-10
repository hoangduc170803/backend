import {
  buildMapHealthReport,
  type MapHealthCode,
  type MapHealthInput,
} from './map-health';

const point = (
  name: string,
  x: number,
  y: number,
  type: 'HALT_POSITION' | 'PARK_POSITION' = 'HALT_POSITION',
) => ({ name, type, position: { x, y }, parkingPriority: null });

const path = (
  srcPointName: string,
  destPointName: string,
  overrides: Partial<{
    maxVelocity: number;
    maxReverseVelocity: number;
    locked: boolean;
  }> = {},
) => ({
  srcPointName,
  destPointName,
  length: 1000,
  maxVelocity: 1000,
  maxReverseVelocity: 1000,
  locked: false,
  ...overrides,
});

const input = (overrides: Partial<MapHealthInput> = {}): MapHealthInput => ({
  mapName: 'test-map',
  points: [point('A', 0, 0), point('B', 1000, 0, 'PARK_POSITION')],
  paths: [path('A', 'B')],
  locations: [],
  locationTypes: [{ name: 'charging', allowedOperations: ['startCharging'] }],
  chargeOperation: 'startCharging',
  loadOperation: 'liftUp',
  unloadOperation: 'liftDown',
  vehicleNames: ['V1'],
  zones: [],
  ...overrides,
});

const slot = (name: string, typeName: string) => ({
  name,
  typeName,
  links: [{ pointName: 'A' }],
});

const charger = (name: string) => ({
  name,
  typeName: 'charging',
  links: [{ pointName: 'A' }],
});

const checkFor = (
  report: ReturnType<typeof buildMapHealthReport>,
  code: MapHealthCode,
) => report.checks.find((check) => check.code === code)!;

describe('buildMapHealthReport', () => {
  it('runs every check and reports the passing ones too', () => {
    const report = buildMapHealthReport(input());

    expect(report.checks).toHaveLength(4);
    expect(report.counts.ok).toBe(4);
    expect(report.counts.warn).toBe(0);
  });

  it('carries the tolerance so the operator can see where the line is', () => {
    expect(buildMapHealthReport(input(), 250).toleranceMm).toBe(250);
  });

  it('flags a point that drifted off the point alignment and names it', () => {
    const report = buildMapHealthReport(
      input({
        points: [
          point('2054', 54967, 26788),
          point('1017', 54967, 28338),
          point('2083', 54952, 26788),
        ],
      }),
    );
    const drift = checkFor(report, 'MISALIGNED_POINT');

    expect(drift.severity).toBe('warn');
    expect(drift.findings).toEqual([
      {
        detail: 'x 54952 → 54967 (+15mm)',
        pointNames: ['2083'],
        locationNames: [],
      },
    ]);
  });

  it('stays quiet about drift once the tolerance is below the gap', () => {
    const report = buildMapHealthReport(
      input({
        points: [
          point('A', 54967, 0),
          point('B', 54967, 800),
          point('C', 54952, 1600),
        ],
      }),
      10,
    );

    expect(checkFor(report, 'MISALIGNED_POINT').severity).toBe('ok');
  });

  it('counts park points against the fleet the map declares', () => {
    const report = buildMapHealthReport(
      input({
        points: [point('P1', 0, 0, 'PARK_POSITION'), point('H1', 1000, 0)],
        vehicleNames: ['V1', 'V2', 'V3'],
      }),
    );
    const park = checkFor(report, 'PARK_CAPACITY');

    expect(park.severity).toBe('warn');
    expect(park.summary).toBe('Thiếu điểm đỗ cho 2 xe');
  });

  it('does not warn when there are more park points than vehicles', () => {
    const report = buildMapHealthReport(
      input({
        points: [
          point('P1', 0, 0, 'PARK_POSITION'),
          point('P2', 1000, 0, 'PARK_POSITION'),
        ],
        vehicleNames: ['V1'],
      }),
    );

    expect(checkFor(report, 'PARK_CAPACITY').severity).toBe('ok');
  });

  it('counts the chargers alongside the park points', () => {
    const report = buildMapHealthReport(
      input({
        points: [point('P1', 0, 0, 'PARK_POSITION')],
        locations: [charger('CHG-1')],
        vehicleNames: ['V1'],
      }),
    );

    expect(checkFor(report, 'PARK_CAPACITY').summary).toBe(
      '1 điểm đỗ + 1 điểm sạc cho 1 xe',
    );
  });

  it('spells out the fleet against both kinds of standing spot', () => {
    const report = buildMapHealthReport(
      input({
        points: [point('P1', 0, 0, 'PARK_POSITION')],
        locations: [charger('CHG-1'), charger('CHG-2')],
        vehicleNames: ['V1', 'V2'],
      }),
    );
    const park = checkFor(report, 'PARK_CAPACITY');

    expect(park.severity).toBe('warn');
    expect(park.summary).toBe('Thiếu điểm đỗ cho 1 xe');
    expect(park.findings[0].detail).toBe('2 xe / 1 điểm đỗ + 2 điểm sạc');
    expect(park.findings[0].locationNames).toEqual(['CHG-1', 'CHG-2']);
  });

  it('still warns when the chargers cannot absorb the overflow either', () => {
    const report = buildMapHealthReport(
      input({
        points: [point('P1', 0, 0, 'PARK_POSITION')],
        locations: [charger('CHG-1')],
        vehicleNames: ['V1', 'V2', 'V3', 'V4'],
      }),
    );

    expect(checkFor(report, 'PARK_CAPACITY').summary).toBe(
      'Thiếu điểm đỗ cho 3 xe',
    );
  });

  it('ignores a location whose type cannot charge', () => {
    const report = buildMapHealthReport(
      input({
        points: [point('P1', 0, 0, 'PARK_POSITION')],
        locations: [
          { name: 'DROP-1', typeName: 'Drop off', links: [{ pointName: 'A' }] },
        ],
        locationTypes: [{ name: 'Drop off', allowedOperations: ['liftDown'] }],
        vehicleNames: ['V1'],
      }),
    );

    expect(checkFor(report, 'PARK_CAPACITY').summary).toBe(
      '1 điểm đỗ + 0 điểm sạc cho 1 xe',
    );
  });

  it('finds a point a vehicle could never leave, reversing included', () => {
    const report = buildMapHealthReport(
      input({
        paths: [path('A', 'B', { maxReverseVelocity: 0 })],
      }),
    );
    const sinks = checkFor(report, 'SINK_POINT');

    expect(sinks.severity).toBe('warn');
    expect(sinks.findings[0].pointNames).toEqual(['B']);
  });

  it('treats a reversible dead end as having a way out', () => {
    const report = buildMapHealthReport(input({ paths: [path('A', 'B')] }));

    expect(checkFor(report, 'SINK_POINT').severity).toBe('ok');
  });

  it('does not call a point no path reaches a trap', () => {
    const report = buildMapHealthReport(
      input({
        points: [point('A', 0, 0), point('LONE', 9000, 9000)],
        paths: [path('A', 'A')],
      }),
    );

    expect(checkFor(report, 'SINK_POINT').findings).toHaveLength(0);
  });

  it('flags a drop-off zone whose slots are pick-up locations on the map', () => {
    const report = buildMapHealthReport(
      input({
        locations: [
          slot('location_3129', 'Pick up'),
          slot('location_3130', 'Pick up'),
        ],
        locationTypes: [{ name: 'Pick up', allowedOperations: ['liftUp'] }],
        zones: [
          {
            name: 'trả hàng 2',
            type: 'DROPOFF',
            locationNames: ['location_3129', 'location_3130'],
          },
        ],
      }),
    );
    const mismatch = checkFor(report, 'ZONE_OPERATION_MISMATCH');

    expect(mismatch.severity).toBe('warn');
    expect(mismatch.findings[0].detail).toBe(
      'Khu trả hàng "trả hàng 2" cần liftDown nhưng 2/2 vị trí thuộc kiểu Pick up (chỉ cho liftUp)',
    );
    expect(mismatch.findings[0].locationNames).toEqual([
      'location_3129',
      'location_3130',
    ]);
  });

  it('says nothing when the map type allows the operation the zone commands', () => {
    const report = buildMapHealthReport(
      input({
        locations: [slot('location_3088', 'Drop off')],
        locationTypes: [{ name: 'Drop off', allowedOperations: ['liftDown'] }],
        zones: [
          {
            name: 'trả hàng 1',
            type: 'DROPOFF',
            locationNames: ['location_3088'],
          },
        ],
      }),
    );

    expect(checkFor(report, 'ZONE_OPERATION_MISMATCH').severity).toBe('ok');
  });

  it('holds a pick-up zone to the load operation instead', () => {
    const report = buildMapHealthReport(
      input({
        locations: [slot('location_0115', 'Drop off')],
        locationTypes: [{ name: 'Drop off', allowedOperations: ['liftDown'] }],
        zones: [
          {
            name: 'lấy hàng 1',
            type: 'PICKUP',
            locationNames: ['location_0115'],
          },
        ],
      }),
    );

    expect(checkFor(report, 'ZONE_OPERATION_MISMATCH').findings[0].detail).toBe(
      'Khu lấy hàng "lấy hàng 1" cần liftUp nhưng 1/1 vị trí thuộc kiểu Drop off (chỉ cho liftDown)',
    );
  });

  it('separates slots the map never had from slots of the wrong type', () => {
    const report = buildMapHealthReport(
      input({
        locations: [
          slot('location_1', 'Pick up'),
          slot('location_2', 'Drop off'),
        ],
        locationTypes: [
          { name: 'Pick up', allowedOperations: ['liftUp'] },
          { name: 'Drop off', allowedOperations: ['liftDown'] },
        ],
        zones: [
          {
            name: 'trả hàng 9',
            type: 'DROPOFF',
            locationNames: ['location_1', 'location_2', 'location_gone'],
          },
        ],
      }),
    );
    const finding = checkFor(report, 'ZONE_OPERATION_MISMATCH').findings[0];

    expect(finding.detail).toBe(
      'Khu trả hàng "trả hàng 9" cần liftDown nhưng 2/3 vị trí 1 ô thuộc kiểu Pick up (chỉ cho liftUp), 1 ô không có trên bản đồ',
    );
    expect(finding.locationNames).toEqual(['location_1', 'location_gone']);
  });

  it('counts one finding per broken zone, not per slot', () => {
    const report = buildMapHealthReport(
      input({
        locations: [slot('a', 'Pick up'), slot('b', 'Drop off')],
        locationTypes: [
          { name: 'Pick up', allowedOperations: ['liftUp'] },
          { name: 'Drop off', allowedOperations: ['liftDown'] },
        ],
        zones: [
          { name: 'trả 1', type: 'DROPOFF', locationNames: ['b'] },
          { name: 'trả 2', type: 'DROPOFF', locationNames: ['a', 'a'] },
        ],
      }),
    );

    expect(checkFor(report, 'ZONE_OPERATION_MISMATCH').summary).toBe(
      '1/2 khu có vị trí không nhận được thao tác WES sẽ ra lệnh — xe chạy tới tận nơi rồi order mới hỏng',
    );
  });
});
