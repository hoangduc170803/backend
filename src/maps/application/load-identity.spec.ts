import { PlantModelWriter } from '../../opentcs/plant-model-writer.service';
import { MapLibraryService } from './map-library.service';
import { ActiveMapRecordService } from '../infrastructure/active-map-record.service';

describe('load → active identity → sync', () => {
  it.each([true, false])(
    'sync resolves the new record when names match=%s',
    async (sameName) => {
      const xml = (name: string) =>
        `<model name="${name}"><point name="P1" positionX="1" positionY="2" positionZ="0" type="HALT_POSITION"/><visualLayout name="layout" scaleX="1" scaleY="1"/></model>`;
      type LoadedRecord = {
        id: string;
        name: string;
        xmlContent: string;
        lastLoadedAt: Date | null;
      };
      let latest: LoadedRecord = {
        id: 'a',
        name: 'factory',
        xmlContent: xml('factory'),
        lastLoadedAt: new Date(1),
      };
      const target = {
        id: 'b',
        name: sameName ? 'factory' : 'other',
        xmlContent: xml(sameName ? 'factory' : 'other'),
        lastLoadedAt: null,
      };
      let live: unknown;
      const builder = {
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getOne: () => Promise.resolve(latest),
      };
      const repo = {
        findOne: jest.fn().mockResolvedValue(target),
        save: jest.fn((record: LoadedRecord) => {
          latest = { ...record };
          return Promise.resolve(record);
        }),
        createQueryBuilder: () => builder,
      };
      const kernel = {
        invalidatePlantModelCache: jest.fn(),
        putRawPlantModel: (model: unknown) => {
          live = model;
          return Promise.resolve();
        },
        getRawPlantModel: () => Promise.resolve(live),
        initializeVehiclesForOperation: () => Promise.resolve(),
      };
      const active = new ActiveMapRecordService(repo as never, kernel as never);
      const synced: (string | null)[] = [];
      const zones = {
        sync: async () => {
          synced.push(await active.resolveId());
          return { markedActive: 0, markedStale: 0 };
        },
      };
      const service = new MapLibraryService(
        kernel as never,
        repo as never,
        { find: () => Promise.resolve([]) } as never,
        zones as never,
        active,
        { emit: jest.fn() } as never,
        new PlantModelWriter(
          kernel as never,
          {
            emitAsync: jest.fn().mockResolvedValue([]),
          } as never,
        ),
      );
      await service.loadLibraryMap('b');
      expect(synced).toEqual(['b']);
      expect(await active.resolveId()).toBe('b');
    },
  );
});
