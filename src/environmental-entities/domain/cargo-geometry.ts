export interface CargoFootprint {
  lengthMm: number;
  widthMm: number;
}

export interface EntityCouple {
  x: number;
  y: number;
}

export interface EntityEnvelope {
  vertices: EntityCouple[];
}

export interface EntityPose {
  position: { x: number; y: number; z: number };
  orientationAngle: number;
}

export interface PointPoseSource {
  name: string;
  x: number;
  y: number;
  z: number;
  orientationAngle: unknown;
}

export type OrientationSource = 'POINT' | 'DEFAULT';

export const DEFAULT_CARGO_FOOTPRINT: CargoFootprint = {
  lengthMm: 800,
  widthMm: 740,
};

export function cargoFootprintFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CargoFootprint {
  return {
    lengthMm: positiveOr(env.CARGO_LENGTH_MM, DEFAULT_CARGO_FOOTPRINT.lengthMm),
    widthMm: positiveOr(env.CARGO_WIDTH_MM, DEFAULT_CARGO_FOOTPRINT.widthMm),
  };
}

function positiveOr(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function centeredEnvelope(footprint: CargoFootprint): EntityEnvelope {
  const halfLength = Math.round(footprint.lengthMm / 2);
  const halfWidth = Math.round(footprint.widthMm / 2);
  const corners: EntityCouple[] = [
    { x: -halfLength, y: -halfWidth },
    { x: halfLength, y: -halfWidth },
    { x: halfLength, y: halfWidth },
    { x: -halfLength, y: halfWidth },
  ];
  return { vertices: [...corners, { ...corners[0] }] };
}

export function envelopeProblem(envelope: EntityEnvelope): string | null {
  const vertices = envelope.vertices ?? [];
  if (
    vertices.some(
      (vertex) => !Number.isFinite(vertex.x) || !Number.isFinite(vertex.y),
    )
  ) {
    return 'Envelope có toạ độ không hợp lệ';
  }
  if (vertices.length < 5) {
    return 'Envelope phải có ít nhất 4 đỉnh và khép kín (đỉnh cuối trùng đỉnh đầu)';
  }
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  if (first.x !== last.x || first.y !== last.y) {
    return 'Envelope không khép kín: đỉnh cuối phải trùng đỉnh đầu';
  }
  const distinct = new Set(
    vertices.slice(0, -1).map((vertex) => `${vertex.x},${vertex.y}`),
  );
  if (distinct.size < 4) return 'Envelope cần ít nhất 4 đỉnh phân biệt';
  if (Math.abs(polygonArea(vertices)) < 1) {
    return 'Envelope có diện tích bằng 0';
  }
  return null;
}

function polygonArea(vertices: EntityCouple[]): number {
  let twice = 0;
  for (let i = 0; i < vertices.length - 1; i++) {
    twice +=
      vertices[i].x * vertices[i + 1].y - vertices[i + 1].x * vertices[i].y;
  }
  return twice / 2;
}

export function poseAtPoint(point: PointPoseSource): {
  pose: EntityPose;
  orientationSource: OrientationSource;
} | null {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    return null;
  }
  const angle = numericAngle(point.orientationAngle);
  return {
    pose: {
      position: {
        x: Math.round(point.x),
        y: Math.round(point.y),
        z: Math.round(point.z),
      },
      orientationAngle: angle ?? 0,
    },
    orientationSource: angle === null ? 'DEFAULT' : 'POINT',
  };
}

export function pointPoseSourceFromRawModel(
  rawModel: unknown,
  pointName: string,
): PointPoseSource | null {
  if (!rawModel || typeof rawModel !== 'object') return null;
  const points = (rawModel as { points?: unknown }).points;
  if (!Array.isArray(points)) return null;
  const point = (points as Record<string, unknown>[]).find(
    (candidate) => candidate?.name === pointName,
  );
  if (!point) return null;

  const pose = point.pose as Record<string, unknown> | undefined;
  const position = (pose?.position ?? point.position) as
    | Record<string, unknown>
    | undefined;
  return {
    name: pointName,
    x: Number(position?.x),
    y: Number(position?.y),
    z: Number(position?.z ?? 0),
    orientationAngle: pose?.orientationAngle ?? point.vehicleOrientationAngle,
  };
}

function numericAngle(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function placedEnvelope(
  envelope: EntityEnvelope,
  pose: EntityPose,
): EntityCouple[] {
  const radians = (pose.orientationAngle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return envelope.vertices.map((vertex) => ({
    x: pose.position.x + vertex.x * cos - vertex.y * sin,
    y: pose.position.y + vertex.x * sin + vertex.y * cos,
  }));
}
