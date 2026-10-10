import {
  ALIGNMENT_TOLERANCE_MM,
  alignPoints,
  type AxisShift,
} from '../../opentcs/domain/point-alignment';
import type {
  KernelLocation,
  KernelLocationType,
  KernelPath,
  KernelPoint,
} from '../../opentcs/domain/kernel-model';

export type MapHealthCode =
  | 'MISALIGNED_POINT'
  | 'PARK_CAPACITY'
  | 'SINK_POINT'
  | 'ZONE_OPERATION_MISMATCH';

export type MapHealthSeverity = 'ok' | 'warn';

export interface MapHealthFinding {
  readonly detail: string;
  readonly pointNames: readonly string[];
  readonly locationNames: readonly string[];
}

export interface MapHealthCheck {
  readonly code: MapHealthCode;
  readonly severity: MapHealthSeverity;
  readonly title: string;
  readonly summary: string;
  readonly findings: readonly MapHealthFinding[];
}

export interface MapHealthReport {
  readonly mapName: string | null;
  readonly toleranceMm: number;
  readonly counts: { readonly ok: number; readonly warn: number };
  readonly checks: readonly MapHealthCheck[];
}

export interface MapHealthZone {
  readonly name: string;
  readonly type: 'PICKUP' | 'DROPOFF';
  readonly locationNames: readonly string[];
}

export interface MapHealthInput {
  readonly mapName: string | null;
  readonly points: readonly KernelPoint[];
  readonly paths: readonly KernelPath[];
  readonly locations: readonly KernelLocation[];
  readonly locationTypes: readonly KernelLocationType[];
  readonly chargeOperation: string;
  readonly loadOperation: string;
  readonly unloadOperation: string;
  readonly vehicleNames: readonly string[];
  readonly zones: readonly MapHealthZone[];
}

export function buildMapHealthReport(
  input: MapHealthInput,
  toleranceMm: number = ALIGNMENT_TOLERANCE_MM,
): MapHealthReport {
  const checks: MapHealthCheck[] = [
    misalignedPoints(input, toleranceMm),
    parkCapacity(input),
    sinkPoints(input),
    zoneOperations(input),
  ];

  return {
    mapName: input.mapName,
    toleranceMm,
    counts: {
      ok: checks.filter((check) => check.severity === 'ok').length,
      warn: checks.filter((check) => check.severity === 'warn').length,
    },
    checks,
  };
}

function misalignedPoints(
  { points }: MapHealthInput,
  toleranceMm: number,
): MapHealthCheck {
  const { shifts } = alignPoints(points, toleranceMm);
  const drifted = new Set(shifts.flatMap((shift) => shift.pointNames));
  const worst = shifts.reduce(
    (largest, shift) => Math.max(largest, Math.abs(shift.to - shift.from)),
    0,
  );

  return check({
    code: 'MISALIGNED_POINT',
    title: 'Điểm lệch hàng/cột',
    okSummary: `Mọi điểm đều thẳng hàng và thẳng cột (dung sai ${toleranceMm}mm)`,
    warnSummary: `${drifted.size} điểm lệch khỏi hàng/cột, lệch nhiều nhất ${worst}mm — WES đã tự nắn về giá trị của số đông`,
    findings: shifts.map((shift) => ({
      detail: describeDrift(shift),
      pointNames: shift.pointNames,
      locationNames: [],
    })),
  });
}

function describeDrift(shift: AxisShift): string {
  const delta = shift.to - shift.from;
  return `${shift.axis} ${shift.from} → ${shift.to} (${delta > 0 ? '+' : ''}${delta}mm)`;
}

function parkCapacity(input: MapHealthInput): MapHealthCheck {
  const { points, vehicleNames } = input;
  const parkPointNames = points
    .filter((point) => point.type === 'PARK_POSITION')
    .map((point) => point.name)
    .sort();
  const chargeLocationNames = chargeLocationsOf(input);

  const fleet = vehicleNames.length;
  const parks = parkPointNames.length;
  const chargers = chargeLocationNames.length;
  const shortfall = fleet - parks;

  return check({
    code: 'PARK_CAPACITY',
    title: 'Sức chứa điểm đỗ & sạc',
    okSummary: `${parks} điểm đỗ + ${chargers} điểm sạc cho ${fleet} xe`,
    warnSummary: `Thiếu điểm đỗ cho ${shortfall} xe`,
    findings:
      shortfall > 0
        ? [
            {
              detail: `${fleet} xe / ${parks} điểm đỗ + ${chargers} điểm sạc`,
              pointNames: parkPointNames,
              locationNames: chargeLocationNames,
            },
          ]
        : [],
  });
}

function chargeLocationsOf({
  locations,
  locationTypes,
  chargeOperation,
}: MapHealthInput): string[] {
  const chargeTypeNames = new Set(
    locationTypes
      .filter((type) => type.allowedOperations.includes(chargeOperation))
      .map((type) => type.name),
  );
  return locations
    .filter((location) =>
      chargeTypeNames.has(location.typeName ?? location.type ?? ''),
    )
    .map((location) => location.name)
    .sort();
}

function sinkPoints({ points, paths }: MapHealthInput): MapHealthCheck {
  const wayOut = new Set<string>();
  const reachable = new Set<string>();
  for (const path of paths) {
    reachable.add(path.srcPointName);
    reachable.add(path.destPointName);
    if (path.maxVelocity > 0) wayOut.add(path.srcPointName);
    if (path.maxReverseVelocity > 0) wayOut.add(path.destPointName);
  }
  const sinks = points
    .filter((point) => reachable.has(point.name) && !wayOut.has(point.name))
    .map((point) => point.name)
    .sort();

  return check({
    code: 'SINK_POINT',
    title: 'Điểm cụt không lối ra',
    okSummary: 'Mọi điểm đều có đường ra, kể cả khi phải lùi',
    warnSummary: `${sinks.length} điểm vào được nhưng không ra được, kể cả lùi — xe tới đó là kẹt vĩnh viễn`,
    findings: sinks.map((name) => ({
      detail: `${name} không có path nào đi ra, kể cả chiều lùi`,
      pointNames: [name],
      locationNames: [],
    })),
  });
}

const ZONE_LABEL: Record<MapHealthZone['type'], string> = {
  PICKUP: 'lấy hàng',
  DROPOFF: 'trả hàng',
};

function zoneOperations(input: MapHealthInput): MapHealthCheck {
  const typeOfLocation = new Map(
    input.locations.map((location) => [
      location.name,
      location.typeName ?? location.type ?? '',
    ]),
  );
  const operationsOfType = new Map(
    input.locationTypes.map((type) => [type.name, type.allowedOperations]),
  );
  const findings = input.zones.flatMap((zone) =>
    zoneOperationFinding(input, zone, typeOfLocation, operationsOfType),
  );

  return check({
    code: 'ZONE_OPERATION_MISMATCH',
    title: 'Khu WES lệch loại vị trí trên bản đồ',
    okSummary: input.zones.length
      ? `${input.zones.length} khu của WES đều trỏ vào vị trí nhận đúng thao tác`
      : 'Chưa có khu nào của WES gắn với bản đồ này',
    warnSummary:
      `${findings.length}/${input.zones.length} khu có vị trí không nhận được` +
      ' thao tác WES sẽ ra lệnh — xe chạy tới tận nơi rồi order mới hỏng',
    findings,
  });
}

function zoneOperationFinding(
  input: MapHealthInput,
  zone: MapHealthZone,
  typeOfLocation: ReadonlyMap<string, string>,
  operationsOfType: ReadonlyMap<string, readonly string[]>,
): MapHealthFinding[] {
  const operation =
    zone.type === 'PICKUP' ? input.loadOperation : input.unloadOperation;

  const groups = new Map<string, string[]>();
  for (const locationName of zone.locationNames) {
    const typeName = typeOfLocation.get(locationName);
    if (typeName === undefined) {
      groupUnder(groups, 'không có trên bản đồ', locationName);
      continue;
    }
    const allowed = operationsOfType.get(typeName) ?? [];
    if (allowed.includes(operation)) continue;
    groupUnder(groups, describeLocationType(typeName, allowed), locationName);
  }
  if (groups.size === 0) return [];

  const offenders = [...groups.values()].flat();
  return [
    {
      detail:
        `Khu ${ZONE_LABEL[zone.type]} "${zone.name}" cần ${operation} nhưng ` +
        `${offenders.length}/${zone.locationNames.length} vị trí ` +
        describeGroups(groups),
      pointNames: [],
      locationNames: offenders,
    },
  ];
}

function describeLocationType(
  typeName: string,
  allowed: readonly string[],
): string {
  return allowed.length > 0
    ? `thuộc kiểu ${typeName} (chỉ cho ${allowed.join(', ')})`
    : `thuộc kiểu ${typeName} (không cho thao tác nào)`;
}

function describeGroups(
  groups: ReadonlyMap<string, readonly string[]>,
): string {
  if (groups.size === 1) return [...groups.keys()][0];
  return [...groups]
    .map(([reason, names]) => `${names.length} ô ${reason}`)
    .join(', ');
}

function groupUnder(
  groups: Map<string, string[]>,
  reason: string,
  locationName: string,
): void {
  const named = groups.get(reason);
  if (named) named.push(locationName);
  else groups.set(reason, [locationName]);
}

function check(spec: {
  code: MapHealthCode;
  title: string;
  okSummary: string;
  warnSummary: string;
  findings: readonly MapHealthFinding[];
}): MapHealthCheck {
  const clean = spec.findings.length === 0;
  return {
    code: spec.code,
    severity: clean ? 'ok' : 'warn',
    title: spec.title,
    summary: clean ? spec.okSummary : spec.warnSummary,
    findings: spec.findings,
  };
}
