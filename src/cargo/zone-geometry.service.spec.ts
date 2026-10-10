import { Logger } from '@nestjs/common';
import { ZoneGeometryService } from './zone-geometry.service';

const ZONE = {
  id: 'zone-1',
  name: 'khu a',
  members: [
    { locationName: 'location_0100' },
    { locationName: 'location_0110' },
  ],
} as never;

function plantModel(aisleLink: {
  src: string;
  dest: string;
  maxVelocity: number;
  maxReverseVelocity: number;
}) {
  return {
    points: [
      { name: '0082', position: { x: 37000, y: 1000 } },
      { name: '0100', position: { x: 37000, y: 2000 } },
      { name: '0110', position: { x: 37000, y: 3000 } },
    ],
    paths: [
      {
        srcPointName: aisleLink.src,
        destPointName: aisleLink.dest,
        maxVelocity: aisleLink.maxVelocity,
        maxReverseVelocity: aisleLink.maxReverseVelocity,
      },
      {
        srcPointName: '0100',
        destPointName: '0110',
        maxVelocity: 1,
        maxReverseVelocity: 1,
      },
    ],
    locations: [
      { name: 'location_0100', links: [{ pointName: '0100' }] },
      { name: 'location_0110', links: [{ pointName: '0110' }] },
    ],
  };
}

function makeService(model: unknown) {
  const kernelApi = { getPlantModelView: jest.fn().mockResolvedValue(model) };
  return new ZoneGeometryService(kernelApi as never);
}

describe('ZoneGeometryService', () => {
  it('reads the way in from a two-way path drawn as if it led out of the zone', async () => {
    const service = makeService(
      plantModel({
        src: '0100',
        dest: '0082',
        maxVelocity: 1,
        maxReverseVelocity: 1,
      }),
    );

    const axes = await service.computeMemberAxes(ZONE);

    expect(axes).not.toBeNull();
    expect(axes!.get('location_0110')!.depthKey).toBeGreaterThan(
      axes!.get('location_0100')!.depthKey,
    );
  });

  it('reads the way in from a path drawn into the zone', async () => {
    const service = makeService(
      plantModel({
        src: '0082',
        dest: '0100',
        maxVelocity: 1,
        maxReverseVelocity: 0,
      }),
    );

    const axes = await service.computeMemberAxes(ZONE);

    expect(axes!.get('location_0110')!.depthKey).toBeGreaterThan(
      axes!.get('location_0100')!.depthKey,
    );
  });

  it('reads the depth axis off a one-way link no matter which way it runs', async () => {
    const service = makeService(
      plantModel({
        src: '0100',
        dest: '0082',
        maxVelocity: 1,
        maxReverseVelocity: 0,
      }),
    );

    const axes = await service.computeMemberAxes(ZONE);

    expect(axes!.get('location_0110')!.depthKey).toBeGreaterThan(
      axes!.get('location_0100')!.depthKey,
    );
  });

  it('reports no geometry when nothing at all touches the zone', async () => {
    const model = plantModel({
      src: '0100',
      dest: '0110',
      maxVelocity: 1,
      maxReverseVelocity: 1,
    });
    model.points = model.points.filter((p) => p.name !== '0082');

    await expect(
      makeService(model).computeMemberAxes(ZONE),
    ).resolves.toBeNull();
  });
});

const RACK_ZONE = {
  id: 'zone-rack',
  name: 'khu tra hang 4',
  members: [
    { locationName: 'location_0157' },
    { locationName: 'location_0158' },
    { locationName: 'location_0167' },
    { locationName: 'location_0168' },
    { locationName: 'location_0177' },
    { locationName: 'location_0178' },
  ],
} as never;

function rackModel() {
  const cells = {
    '0157': { x: 5450, y: -7250 },
    '0158': { x: 4500, y: -7250 },
    '0167': { x: 5450, y: -8050 },
    '0168': { x: 4500, y: -8050 },
    '0177': { x: 5450, y: -8850 },
    '0178': { x: 4500, y: -8850 },
  };
  const way = (
    srcPointName: string,
    destPointName: string,
    maxVelocity: number,
    maxReverseVelocity: number,
  ) => ({ srcPointName, destPointName, maxVelocity, maxReverseVelocity });

  return {
    points: [
      ...Object.entries(cells).map(([name, position]) => ({ name, position })),
      { name: '0147', position: { x: 5450, y: -6450 } },
      { name: '0148', position: { x: 4500, y: -6450 } },
      { name: '0156', position: { x: 6400, y: -7250 } },
      { name: '0166', position: { x: 6400, y: -8050 } },
      { name: '0176', position: { x: 6400, y: -8850 } },
    ],
    paths: [
      way('0147', '0157', 1000, 1000),
      way('0148', '0158', 1000, 1000),
      way('0157', '0156', 1000, 0),
      way('0167', '0166', 1000, 0),
      way('0177', '0176', 1000, 0),
      way('0157', '0167', 1000, 1000),
      way('0167', '0177', 1000, 1000),
      way('0158', '0168', 1000, 1000),
      way('0168', '0178', 1000, 1000),
    ],
    locations: Object.keys(cells).map((name) => ({
      name: `location_${name}`,
      links: [{ pointName: name }],
    })),
  };
}

describe('ZoneGeometryService rack geometry', () => {
  it('ignores one-way exits and reads the depth axis off the way in', async () => {
    const axes = await makeService(rackModel()).computeMemberAxes(RACK_ZONE);

    const lane = (name: string) => axes!.get(`location_${name}`)!.laneKey;
    const depth = (name: string) => axes!.get(`location_${name}`)!.depthKey;

    expect(lane('0157')).toBe(lane('0167'));
    expect(lane('0167')).toBe(lane('0177'));
    expect(lane('0158')).toBe(lane('0168'));
    expect(lane('0158')).not.toBe(lane('0157'));

    expect(depth('0157')).toBeLessThan(depth('0167'));
    expect(depth('0167')).toBeLessThan(depth('0177'));
  });

  it('separates cells one pitch apart even when the pitch is not a round 1000', async () => {
    const axes = await makeService(rackModel()).computeMemberAxes(RACK_ZONE);

    const depths = ['0157', '0167', '0177'].map(
      (name) => axes!.get(`location_${name}`)!.depthKey,
    );

    expect(new Set(depths).size).toBe(3);
  });

  it('keeps two lanes 950 apart from collapsing into one', async () => {
    const axes = await makeService(rackModel()).computeMemberAxes(RACK_ZONE);

    const lanes = new Set(
      [...axes!.values()].map((memberAxes) => memberAxes.laneKey),
    );

    expect(lanes.size).toBe(2);
  });
});

const POINT_NAMES = new Map([
  ['location_0100', ['0100']],
  ['location_0110', ['0110']],
]);

function makeIndexingService(model: unknown) {
  const kernelApi = {
    getPlantModelView: jest.fn().mockResolvedValue(model),
    getPointNamesByLocation: jest.fn().mockResolvedValue(POINT_NAMES),
  };
  return { service: new ZoneGeometryService(kernelApi as never), kernelApi };
}

const wayIn = () =>
  plantModel({
    src: '0082',
    dest: '0100',
    maxVelocity: 1,
    maxReverseVelocity: 0,
  });

describe('ZoneGeometryService.laneIndexOf', () => {
  afterEach(() => jest.restoreAllMocks());

  it('collects every point of a lane behind that lane key', async () => {
    const { service } = makeIndexingService(wayIn());

    const index = await service.laneIndexOf(ZONE);

    const laneKey = index!.axesByLocation.get('location_0100')!.laneKey;
    expect([...index!.pointsByLane.get(laneKey)!].sort()).toEqual([
      '0100',
      '0110',
    ]);
  });

  it('reuses the cached index while the members stay the same', async () => {
    const { service, kernelApi } = makeIndexingService(wayIn());

    await service.laneIndexOf(ZONE);
    await service.laneIndexOf(ZONE);

    expect(kernelApi.getPlantModelView).toHaveBeenCalledTimes(1);
  });

  it('reports no index when the geometry cannot be computed', async () => {
    const model = wayIn();
    model.points = model.points.filter((p) => p.name !== '0082');

    await expect(
      makeIndexingService(model).service.laneIndexOf(ZONE),
    ).resolves.toBeNull();
  });

  it('warns when two slots of a lane are not directly connected', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const model = wayIn();
    model.paths = model.paths.filter(
      (path) =>
        !(path.srcPointName === '0100' && path.destPointName === '0110'),
    );

    await makeIndexingService(model).service.laneIndexOf(ZONE);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('without a slot'),
    );
  });

  it('stays quiet when consecutive slots are directly connected', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await makeIndexingService(wayIn()).service.laneIndexOf(ZONE);

    expect(warn).not.toHaveBeenCalled();
  });
});
