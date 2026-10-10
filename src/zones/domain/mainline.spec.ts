import {
  acrossLane,
  alongLane,
  findMainlines,
  laneAxisOf,
  mainlinePointNames,
  type LayoutProperty,
} from './mainline';
import type { PlantPath, TopologyPoint } from './zone-topology';

const PITCH = 950;
const MAINLINE_LENGTH = 10;
const LANE_DEPTH = 4;

interface Model {
  readonly points: TopologyPoint[];
  readonly paths: PlantPath[];
}

function at(name: string, x: number, y: number): TopologyPoint {
  return { name, position: { x, y } };
}

function link(from: string, to: string): PlantPath {
  return {
    srcPointName: from,
    destPointName: to,
    maxVelocity: 1000,
    maxReverseVelocity: 1000,
  };
}

function warehouse(): Model {
  const points: TopologyPoint[] = [];
  const paths: PlantPath[] = [];

  for (const [row, y] of [
    ['A', 0],
    ['B', PITCH],
  ] as const) {
    for (let index = 0; index < MAINLINE_LENGTH; index++) {
      points.push(at(`${row}${index}`, index * PITCH, y));
      if (index > 0) paths.push(link(`${row}${index - 1}`, `${row}${index}`));
    }
  }

  for (const column of [2, 5, 8]) {
    let previous = `A${column}`;
    for (let depth = 1; depth <= LANE_DEPTH; depth++) {
      const name = `L${column}_${depth}`;
      points.push(at(name, column * PITCH, -depth * PITCH));
      paths.push(link(previous, name));
      previous = name;
    }
  }
  return { points, paths };
}

function turnedAQuarter({ points, paths }: Model): Model {
  return {
    points: points.map((point) =>
      at(point.name, point.position.y, point.position.x),
    ),
    paths,
  };
}

const NO_PROPERTIES: LayoutProperty[] = [];
const ROTATED_LAYOUT: LayoutProperty[] = [{ name: 'direction', value: 'X+' }];

describe('findMainlines', () => {
  it('picks out the two through-lines and leaves the short lanes alone', () => {
    const mainlines = findMainlines(warehouse().points, warehouse().paths);

    expect(mainlines).toHaveLength(2);
    expect(mainlines.map((mainline) => mainline.axis)).toEqual(['x', 'x']);
    expect(mainlines.map((mainline) => mainline.offset)).toEqual([0, PITCH]);
    expect(mainlines[0].pointNames).toHaveLength(MAINLINE_LENGTH);
  });

  it('finds the same two through-lines on a map drawn a quarter turn round', () => {
    const turned = turnedAQuarter(warehouse());

    const mainlines = findMainlines(turned.points, turned.paths);

    expect(mainlines).toHaveLength(2);
    expect(mainlines.map((mainline) => mainline.axis)).toEqual(['y', 'y']);
    expect(mainlines.map((mainline) => mainline.pointNames.length)).toEqual([
      MAINLINE_LENGTH,
      MAINLINE_LENGTH,
    ]);
  });

  it('names every point on a mainline so callers can test membership', () => {
    const names = mainlinePointNames(
      findMainlines(warehouse().points, warehouse().paths),
    );

    expect(names.has('A0')).toBe(true);
    expect(names.has('B9')).toBe(true);
    expect(names.has('L2_1')).toBe(false);
  });

  it('reports nothing when no path is traversable in either direction', () => {
    const { points, paths } = warehouse();
    const locked = paths.map((path) => ({
      ...path,
      maxVelocity: 0,
      maxReverseVelocity: 0,
    }));

    expect(findMainlines(points, locked)).toEqual([]);
  });
});

describe('laneAxisOf', () => {
  it('takes the layout at its word when it declares the rotated frame', () => {
    const { points, paths } = warehouse();

    expect(laneAxisOf(points, paths, ROTATED_LAYOUT)).toEqual({
      axis: 'y',
      source: 'declared',
    });
  });

  it('reads the geometry when the layout declares nothing', () => {
    const { points, paths } = warehouse();

    expect(laneAxisOf(points, paths, NO_PROPERTIES)).toEqual({
      axis: 'y',
      source: 'detected',
    });
  });

  it('does not mirror an undeclared map that is drawn the other way round', () => {
    const turned = turnedAQuarter(warehouse());

    expect(laneAxisOf(turned.points, turned.paths, NO_PROPERTIES)).toEqual({
      axis: 'x',
      source: 'detected',
    });
  });
});

describe('alongLane / acrossLane', () => {
  it('measures depth on the lane axis and lane identity on the other one', () => {
    const position = { x: 7, y: 11 };

    expect(alongLane('y', position)).toBe(11);
    expect(acrossLane('y', position)).toBe(7);
    expect(alongLane('x', position)).toBe(7);
    expect(acrossLane('x', position)).toBe(11);
  });
});
