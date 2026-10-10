import { ALIGNMENT_TOLERANCE_MM, alignPoints } from './point-alignment';

const point = (name: string, x: number, y: number) => ({
  name,
  position: { x, y },
});

describe('alignPoints', () => {
  it('pulls a stray coordinate onto the value its neighbours share', () => {
    const { points } = alignPoints([
      point('1017', 54967, 28338),
      point('2083', 54952, 27503),
      point('2054', 54967, 26788),
    ]);

    expect(points.map((p) => p.position.x)).toEqual([54967, 54967, 54967]);
  });

  it('leaves coordinates alone when they already agree', () => {
    const input = [point('A', 1000, 0), point('B', 1000, 800)];

    const { points, shifts } = alignPoints(input);

    expect(points.map((p) => p.position)).toEqual(input.map((p) => p.position));
    expect(shifts).toEqual([]);
  });

  it('keeps rows apart when the gap is a real one, not jitter', () => {
    const { points } = alignPoints([
      point('A', 0, 22288),
      point('B', 0, 23088),
    ]);

    expect(points.map((p) => p.position.y)).toEqual([22288, 23088]);
  });

  it('moves the minority onto the majority, never the other way round', () => {
    const { points } = alignPoints([
      point('A', 36917, 0),
      point('B', 36917, 800),
      point('C', 36902, 1600),
    ]);

    expect(points.map((p) => p.position.x)).toEqual([36917, 36917, 36917]);
  });

  it('reports every shift with the points it moved', () => {
    const { shifts } = alignPoints([
      point('A', 36917, 0),
      point('B', 36917, 800),
      point('C', 36902, 1600),
    ]);

    expect(shifts).toEqual([
      { axis: 'x', from: 36902, to: 36917, pointNames: ['C'] },
    ]);
  });

  it('cannot chain a cluster wider than the tolerance', () => {
    const { points } = alignPoints(
      [point('A', 0, 0), point('B', 90, 0), point('C', 180, 0)],
      100,
    );

    expect(points.map((p) => p.position.x)).toEqual([0, 0, 180]);
  });

  it('is a no-op when the tolerance is zero', () => {
    const { points, shifts } = alignPoints(
      [point('A', 54967, 0), point('B', 54952, 0)],
      0,
    );

    expect(points.map((p) => p.position.x)).toEqual([54967, 54952]);
    expect(shifts).toEqual([]);
  });

  it('keeps fields the caller carries alongside the position', () => {
    const { points } = alignPoints([
      { name: 'A', type: 'PARK_POSITION', position: { x: 1, y: 2, z: 3 } },
    ]);

    expect(points[0]).toEqual({
      name: 'A',
      type: 'PARK_POSITION',
      position: { x: 1, y: 2, z: 3 },
    });
  });

  it('tolerates the 35mm drift seen in v7-being at the default tolerance', () => {
    expect(ALIGNMENT_TOLERANCE_MM).toBeGreaterThan(35);

    const { points } = alignPoints([
      point('2100', 56867, 27538),
      point('2101', 57817, 27538),
      point('2083', 54952, 27503),
    ]);

    expect(points.map((p) => p.position.y)).toEqual([27538, 27538, 27538]);
  });
});
