import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgvHistoryService } from './agv-history.service';
import { AgvEntity } from './entities/agv.entity';
import { VehicleErrorEventEntity } from './entities/vehicle-error-event.entity';
import { VehicleStateTransitionEntity } from '../opentcs/entities/vehicle-state-transition.entity';
import {
  TaskStatus,
  TransportTaskEntity,
} from '../cargo/entities/transport-task.entity';
import { CargoEntity } from '../cargo/entities/cargo.entity';
import { TaskOrderEntity } from '../cargo/entities/task-order.entity';

type MockRepo = {
  find: jest.Mock;
  findOne: jest.Mock;
  findAndCount: jest.Mock;
  createQueryBuilder: jest.Mock;
};

const makeRepo = (): MockRepo => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const makeAgv = (overrides: Partial<AgvEntity> = {}): AgvEntity =>
  ({
    id: 'agv-1',
    code: 'AGV-001',
    name: 'AGV 1',
    ...overrides,
  }) as AgvEntity;

const makeTransition = (
  overrides: Partial<VehicleStateTransitionEntity> = {},
): VehicleStateTransitionEntity => ({
  id: '10',
  sessionId: '3',
  vehicleName: 'AGV 1',
  pointName: 'P-01',
  procState: 'PROCESSING_ORDER',
  vehicleState: 'EXECUTING',
  orderName: 'PICKUP-abc',
  occurredAt: new Date('2026-08-01T10:00:00Z'),
  observedAt: null,
  mapRecordId: null,
  ...overrides,
});

const makeErrorEvent = (
  overrides: Partial<VehicleErrorEventEntity> = {},
): VehicleErrorEventEntity => ({
  id: '20',
  vehicleName: 'AGV 1',
  kind: 'RAISED',
  fatalErrorTypes: ['motorOverheat'],
  warningErrorTypes: [],
  vehicleState: 'ERROR',
  pointName: 'P-01',
  transportOrderName: 'PICKUP-abc',
  metadata: {},
  occurredAt: new Date('2026-08-01T10:00:00Z'),
  observedAt: null,
  mapRecordId: null,
  ...overrides,
});

type QueryBuilderMock = {
  select: jest.Mock;
  addSelect: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  groupBy: jest.Mock;
  addGroupBy: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  offset: jest.Mock;
  limit: jest.Mock;
  withDeleted: jest.Mock;
  distinct: jest.Mock;
  getRawMany: jest.Mock;
  getCount: jest.Mock;
};

const makeQueryBuilder = (
  rows: unknown[],
  count = rows.length,
): QueryBuilderMock => {
  const builder: Partial<QueryBuilderMock> = {};
  const chain = (name: keyof QueryBuilderMock) => {
    builder[name] = jest.fn().mockReturnValue(builder);
  };
  (
    [
      'select',
      'addSelect',
      'leftJoin',
      'where',
      'andWhere',
      'groupBy',
      'addGroupBy',
      'orderBy',
      'addOrderBy',
      'offset',
      'limit',
      'withDeleted',
      'distinct',
    ] as const
  ).forEach(chain);
  builder.getRawMany = jest.fn().mockResolvedValue(rows);
  builder.getCount = jest.fn().mockResolvedValue(count);
  return builder as QueryBuilderMock;
};

const makeTaskRow = (overrides: Record<string, unknown> = {}) => ({
  task_id: 'task-1',
  request_code: 'REQ-0001',
  status: TaskStatus.DELIVERY_COMPLETED,
  started_at: new Date('2026-08-01T10:00:00Z'),
  completed_at: new Date('2026-08-01T10:12:00Z'),
  cancelled_at: null,
  source_point_name: 'P-01',
  destination_location_name: 'SLOT-07',
  ...overrides,
});

describe('AgvHistoryService', () => {
  let service: AgvHistoryService;
  let agvRepo: MockRepo;
  let transitionRepo: MockRepo;
  let errorRepo: MockRepo;
  let taskRepo: MockRepo;
  let orderRepo: MockRepo;

  beforeEach(async () => {
    agvRepo = makeRepo();
    transitionRepo = makeRepo();
    errorRepo = makeRepo();
    taskRepo = makeRepo();
    orderRepo = makeRepo();
    orderRepo.find.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgvHistoryService,
        { provide: getRepositoryToken(AgvEntity), useValue: agvRepo },
        {
          provide: getRepositoryToken(VehicleStateTransitionEntity),
          useValue: transitionRepo,
        },
        {
          provide: getRepositoryToken(VehicleErrorEventEntity),
          useValue: errorRepo,
        },
        {
          provide: getRepositoryToken(TransportTaskEntity),
          useValue: taskRepo,
        },
        {
          provide: getRepositoryToken(TaskOrderEntity),
          useValue: orderRepo,
        },
      ],
    }).compile();

    service = module.get(AgvHistoryService);
  });

  describe('taskHistory', () => {
    it('filters by the vehicle name inside the task metadata JSONB', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      const builder = makeQueryBuilder([makeTaskRow()], 380);
      taskRepo.createQueryBuilder.mockReturnValue(builder);

      const result = await service.taskHistory('agv-1', { page: 3, limit: 20 });

      expect(builder.where).toHaveBeenCalledWith(
        expect.stringContaining('task_order.agv_id = :agvId'),
        { agvId: 'agv-1', vehicleName: 'AGV 1' },
      );
      expect(builder.offset).toHaveBeenCalledWith(40);
      expect(builder.limit).toHaveBeenCalledWith(20);
      expect(result).toMatchObject({
        agvId: 'agv-1',
        vehicleName: 'AGV 1',
        total: 380,
        page: 3,
        limit: 20,
      });
    });

    it('joins cargos for the source and destination and orders newest-first', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      const builder = makeQueryBuilder([makeTaskRow()]);
      taskRepo.createQueryBuilder.mockReturnValue(builder);

      const [entry] = (await service.taskHistory('agv-1')).entries;

      expect(builder.leftJoin).toHaveBeenCalledWith(
        CargoEntity,
        'cargo',
        'cargo.id = task.cargoId',
      );
      expect(builder.select).toHaveBeenCalledWith('task.id', 'task_id');
      expect(builder.addSelect).toHaveBeenCalledWith(
        'task.requestCode',
        'request_code',
      );
      expect(builder.orderBy).toHaveBeenCalledWith('task.createdAt', 'DESC');
      expect(builder.addOrderBy).toHaveBeenCalledWith('task.id', 'DESC');
      expect(entry).toEqual({
        taskId: 'REQ-0001',
        source: 'P-01',
        destination: 'SLOT-07',
        startedAt: new Date('2026-08-01T10:00:00Z'),
        endedAt: new Date('2026-08-01T10:12:00Z'),
        status: TaskStatus.DELIVERY_COMPLETED,
        orders: [],
      });
    });

    it('opts out of the cargo soft-delete filter before joining, so a removed cargo still shows its points', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      const builder = makeQueryBuilder([makeTaskRow()]);
      taskRepo.createQueryBuilder.mockReturnValue(builder);

      await service.taskHistory('agv-1');

      expect(builder.withDeleted).toHaveBeenCalled();
      expect(builder.leftJoin).toHaveBeenCalledWith(
        CargoEntity,
        'cargo',
        'cargo.id = task.cargoId',
      );
    });

    it('ends a cancelled task at its cancellation time', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      taskRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([
          makeTaskRow({
            status: TaskStatus.CANCELLED,
            completed_at: null,
            cancelled_at: new Date('2026-08-01T10:05:00Z'),
          }),
        ]),
      );

      const [entry] = (await service.taskHistory('agv-1')).entries;

      expect(entry.endedAt).toEqual(new Date('2026-08-01T10:05:00Z'));
      expect(entry.status).toBe(TaskStatus.CANCELLED);
    });

    it('leaves the end time empty for a task that neither completed nor cancelled', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      taskRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([
          makeTaskRow({
            status: TaskStatus.FAILED,
            completed_at: null,
            cancelled_at: null,
          }),
        ]),
      );

      const [entry] = (await service.taskHistory('agv-1')).entries;

      expect(entry.endedAt).toBeNull();
    });

    it('applies the optional date range to the task creation time', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      const builder = makeQueryBuilder([]);
      taskRepo.createQueryBuilder.mockReturnValue(builder);

      await service.taskHistory('agv-1', {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-02T23:59:59.999Z',
      });

      expect(builder.andWhere).toHaveBeenCalledWith('task.createdAt >= :from', {
        from: new Date('2026-08-01T00:00:00.000Z'),
      });
      expect(builder.andWhere).toHaveBeenCalledWith('task.createdAt <= :to', {
        to: new Date('2026-08-02T23:59:59.999Z'),
      });
    });

    it('omits the date range when it is not supplied', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      const builder = makeQueryBuilder([]);
      taskRepo.createQueryBuilder.mockReturnValue(builder);

      const result = await service.taskHistory('agv-1');

      expect(builder.andWhere).not.toHaveBeenCalled();
      expect(builder.offset).toHaveBeenCalledWith(0);
      expect(builder.limit).toHaveBeenCalledWith(20);
      expect(result.entries).toEqual([]);
    });

    it('throws NotFoundException when the AGV does not exist', async () => {
      agvRepo.findOne.mockResolvedValue(null);

      await expect(service.taskHistory('missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('stateLog', () => {
    it('resolves the AGV id to its vehicle name and queries newest-first', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      transitionRepo.findAndCount.mockResolvedValue([[makeTransition()], 1]);

      const result = await service.stateLog('agv-1', {
        page: 2,
        limit: 5,
      });

      expect(transitionRepo.findAndCount).toHaveBeenCalledWith({
        where: { vehicleName: 'AGV 1' },
        order: { occurredAt: 'DESC', id: 'DESC' },
        skip: 5,
        take: 5,
      });
      expect(result.agvId).toBe('agv-1');
      expect(result.vehicleName).toBe('AGV 1');
      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(5);
    });

    it('defaults to the first page of 20 entries', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      transitionRepo.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.stateLog('agv-1');

      expect(transitionRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result.entries).toEqual([]);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('maps rows to the response DTO without leaking the session id', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      transitionRepo.findAndCount.mockResolvedValue([[makeTransition()], 1]);

      const [entry] = (await service.stateLog('agv-1')).entries;

      expect(entry).toEqual({
        id: '10',
        vehicleName: 'AGV 1',
        pointName: 'P-01',
        procState: 'PROCESSING_ORDER',
        vehicleState: 'EXECUTING',
        orderName: 'PICKUP-abc',
        occurredAt: new Date('2026-08-01T10:00:00Z'),
        observedAt: null,
      });
      expect('sessionId' in entry).toBe(false);
    });

    it('throws NotFoundException when the AGV does not exist', async () => {
      agvRepo.findOne.mockResolvedValue(null);

      await expect(service.stateLog('missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(transitionRepo.findAndCount).not.toHaveBeenCalled();
    });
  });

  describe('errorHistory', () => {
    it('filters by vehicle name and orders newest-first', async () => {
      agvRepo.findOne.mockResolvedValue(makeAgv());
      errorRepo.findAndCount.mockResolvedValue([[makeErrorEvent()], 1]);

      const result = await service.errorHistory('agv-1', { limit: 50 });

      expect(errorRepo.findAndCount).toHaveBeenCalledWith({
        where: { vehicleName: 'AGV 1' },
        order: { occurredAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 50,
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        kind: 'RAISED',
        fatalErrorTypes: ['motorOverheat'],
        warningErrorTypes: [],
        vehicleState: 'ERROR',
      });
    });

    it('throws NotFoundException when the AGV does not exist', async () => {
      agvRepo.findOne.mockResolvedValue(null);

      await expect(service.errorHistory('missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(errorRepo.findAndCount).not.toHaveBeenCalled();
    });
  });

  describe('errorFrequency', () => {
    it('counts fault rows per vehicle and attaches the registry id', async () => {
      const builder = makeQueryBuilder([
        {
          vehicle_name: 'AGV 1',
          error_count: 7,
          last_occurred_at: new Date('2026-08-03T09:00:00Z'),
        },
        {
          vehicle_name: 'AGV 9',
          error_count: 2,
          last_occurred_at: new Date('2026-08-02T09:00:00Z'),
        },
      ]);
      errorRepo.createQueryBuilder.mockReturnValue(builder);
      agvRepo.find.mockResolvedValue([makeAgv()]);

      const result = await service.errorFrequency({ window: '24h' });

      expect(result.window).toBe('24h');
      expect(result.vehicles).toEqual([
        {
          agvId: 'agv-1',
          vehicleName: 'AGV 1',
          errorCount: 7,
          lastOccurredAt: new Date('2026-08-03T09:00:00Z'),
        },
        {
          agvId: null,
          vehicleName: 'AGV 9',
          errorCount: 2,
          lastOccurredAt: new Date('2026-08-02T09:00:00Z'),
        },
      ]);
      expect(builder.orderBy).toHaveBeenCalledWith('error_count', 'DESC');
      expect(builder.limit).toHaveBeenCalledWith(20);
    });

    it('counts only RAISED and CHANGED rows', async () => {
      const builder = makeQueryBuilder([]);
      errorRepo.createQueryBuilder.mockReturnValue(builder);
      agvRepo.find.mockResolvedValue([]);

      await service.errorFrequency();

      expect(builder.andWhere).toHaveBeenCalledWith(
        'event.kind IN (:...kinds)',
        { kinds: ['RAISED', 'CHANGED'] },
      );
    });

    it('defaults to a 7 day window ending now', async () => {
      const builder = makeQueryBuilder([]);
      errorRepo.createQueryBuilder.mockReturnValue(builder);
      agvRepo.find.mockResolvedValue([]);

      const result = await service.errorFrequency();

      expect(result.window).toBe('7d');
      expect(result.to.getTime() - result.from.getTime()).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
      expect(builder.where).toHaveBeenCalledWith('event.occurredAt >= :from', {
        from: result.from,
      });
    });

    it('honours an explicit limit', async () => {
      const builder = makeQueryBuilder([]);
      errorRepo.createQueryBuilder.mockReturnValue(builder);
      agvRepo.find.mockResolvedValue([]);

      await service.errorFrequency({ limit: 3 });

      expect(builder.limit).toHaveBeenCalledWith(3);
    });
  });
});
