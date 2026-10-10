import {
  DEFAULT_CARGO_FOOTPRINT,
  cargoFootprintFromEnv,
  centeredEnvelope,
  envelopeProblem,
  placedEnvelope,
  pointPoseSourceFromRawModel,
  poseAtPoint,
} from './cargo-geometry';

describe('cargo footprint', () => {
  it('defaults to 800 × 740 mm', () => {
    expect(cargoFootprintFromEnv({})).toEqual({ lengthMm: 800, widthMm: 740 });
    expect(DEFAULT_CARGO_FOOTPRINT).toEqual({ lengthMm: 800, widthMm: 740 });
  });

  it('reads CARGO_LENGTH_MM / CARGO_WIDTH_MM and ignores unusable values', () => {
    expect(
      cargoFootprintFromEnv({
        CARGO_LENGTH_MM: '1200',
        CARGO_WIDTH_MM: '1000',
      }),
    ).toEqual({ lengthMm: 1200, widthMm: 1000 });
    expect(
      cargoFootprintFromEnv({ CARGO_LENGTH_MM: '-5', CARGO_WIDTH_MM: 'abc' }),
    ).toEqual({ lengthMm: 800, widthMm: 740 });
  });
});

describe('centeredEnvelope', () => {
  const envelope = centeredEnvelope({ lengthMm: 800, widthMm: 740 });

  it('is a closed rectangle centred on the pose', () => {
    expect(envelope.vertices).toEqual([
      { x: -400, y: -370 },
      { x: 400, y: -370 },
      { x: 400, y: 370 },
      { x: -400, y: 370 },
      { x: -400, y: -370 },
    ]);
    expect(envelopeProblem(envelope)).toBeNull();
  });

  it('spans exactly the cargo size', () => {
    const xs = envelope.vertices.map((vertex) => vertex.x);
    const ys = envelope.vertices.map((vertex) => vertex.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(800);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(740);
  });
});

describe('envelopeProblem', () => {
  it('rejects an open polygon', () => {
    expect(
      envelopeProblem({
        vertices: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
          { x: 0, y: 2 },
        ],
      }),
    ).toContain('khép kín');
  });

  it('rejects fewer than 4 vertices', () => {
    expect(
      envelopeProblem({
        vertices: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: 0 },
        ],
      }),
    ).not.toBeNull();
  });

  it('rejects a degenerate polygon', () => {
    expect(
      envelopeProblem({
        vertices: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 3, y: 0 },
          { x: 0, y: 0 },
        ],
      }),
    ).toContain('diện tích');
  });

  it('rejects non-numeric coordinates', () => {
    expect(
      envelopeProblem({
        vertices: [
          { x: Number.NaN, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
          { x: Number.NaN, y: 0 },
        ],
      }),
    ).not.toBeNull();
  });
});

describe('poseAtPoint', () => {
  it("uses the point's coordinates as the pose", () => {
    expect(
      poseAtPoint({
        name: 'P',
        x: 47367,
        y: 25638,
        z: 0,
        orientationAngle: 45,
      }),
    ).toEqual({
      pose: { position: { x: 47367, y: 25638, z: 0 }, orientationAngle: 45 },
      orientationSource: 'POINT',
    });
  });

  it('falls back to 0° when the kernel reports no orientation ("NaN")', () => {
    expect(
      poseAtPoint({ name: 'P', x: 1, y: 2, z: 0, orientationAngle: 'NaN' }),
    ).toEqual({
      pose: { position: { x: 1, y: 2, z: 0 }, orientationAngle: 0 },
      orientationSource: 'DEFAULT',
    });
  });

  it('keeps a real 0° orientation as coming from the point', () => {
    expect(
      poseAtPoint({ name: 'P', x: 1, y: 2, z: 0, orientationAngle: 0 })
        ?.orientationSource,
    ).toBe('POINT');
  });

  it('refuses a point without valid coordinates', () => {
    expect(
      poseAtPoint({
        name: 'P',
        x: Number.NaN,
        y: 2,
        z: 0,
        orientationAngle: 0,
      }),
    ).toBeNull();
  });
});

describe('pointPoseSourceFromRawModel', () => {
  it('reads the flat shape the kernel web API returns', () => {
    const model = {
      points: [
        {
          name: '0001',
          position: { x: 47367, y: 25638, z: 0 },
          vehicleOrientationAngle: 'NaN',
        },
      ],
    };
    expect(pointPoseSourceFromRawModel(model, '0001')).toEqual({
      name: '0001',
      x: 47367,
      y: 25638,
      z: 0,
      orientationAngle: 'NaN',
    });
  });

  it('reads the nested pose shape', () => {
    const model = {
      points: [
        {
          name: 'P',
          pose: { position: { x: 5, y: 6, z: 7 }, orientationAngle: 30 },
        },
      ],
    };
    expect(pointPoseSourceFromRawModel(model, 'P')).toMatchObject({
      x: 5,
      y: 6,
      z: 7,
      orientationAngle: 30,
    });
  });

  it('returns null for an unknown point or no model', () => {
    expect(pointPoseSourceFromRawModel({ points: [] }, 'P')).toBeNull();
    expect(pointPoseSourceFromRawModel(null, 'P')).toBeNull();
  });
});

describe('placedEnvelope', () => {
  it('rotates the envelope around the pose', () => {
    const corners = placedEnvelope(
      centeredEnvelope({ lengthMm: 800, widthMm: 740 }),
      { position: { x: 1000, y: 1000, z: 0 }, orientationAngle: 90 },
    ).map((corner) => ({ x: Math.round(corner.x), y: Math.round(corner.y) }));

    expect(corners[0]).toEqual({ x: 1370, y: 600 });
    expect(corners[2]).toEqual({ x: 630, y: 1400 });
  });
});
