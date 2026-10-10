import { CargoStatus } from '../cargo/entities/cargo.entity';
import { TaskStatus } from '../cargo/entities/transport-task.entity';
import { LegacyFmsException, legacyHttpStatus } from './legacy-fms.errors';
import { parseLegacyCargoRequest, toLegacyState } from './legacy-fms.mapping';

describe('parseLegacyCargoRequest', () => {
  it('accepts the legacy body', () => {
    expect(
      parseLegacyCargoRequest({
        name: 'abc',
        position: '0110',
        destination: '866',
      }),
    ).toEqual({ name: 'abc', position: '0110', destination: '866' });
  });

  it('reads numeric fields as text like Jackson asText()', () => {
    expect(
      parseLegacyCargoRequest({ name: 'abc', position: 110, destination: 866 }),
    ).toEqual({ name: 'abc', position: '110', destination: '866' });
  });

  it.each([
    [{ name: 'abc', position: '0110' }],
    [{ name: 'abc', position: ' ', destination: '866' }],
    [null],
  ])('rejects %j with code 40001', (body) => {
    expect(() => parseLegacyCargoRequest(body)).toThrow(
      expect.objectContaining({
        code: 40001,
        message: 'Cargo name, position and destination are required',
      }) as LegacyFmsException,
    );
  });
});

describe('legacyHttpStatus', () => {
  it.each([
    [40001, 400],
    [40901, 409],
    [40903, 409],
    [500, 500],
    [12, 500],
  ])('maps %i to %i', (code, status) => {
    expect(legacyHttpStatus(code)).toBe(status);
  });
});

describe('toLegacyState', () => {
  it.each([
    [CargoStatus.ACTIVE, TaskStatus.CREATED, 'NONE'],
    [CargoStatus.ACTIVE, TaskStatus.READY_TO_ASSIGN, 'WAITING_FOR_VEHICLE'],
    [CargoStatus.ACTIVE, TaskStatus.PICKING_UP, 'BEING_PROCESSED'],
    [CargoStatus.DELIVERED, TaskStatus.DELIVERY_COMPLETED, 'FINISHED'],
    [CargoStatus.CANCELLED, TaskStatus.CANCELLED, 'FAILED'],
  ])('%s/%s -> %s', (cargoStatus, taskStatus, expected) => {
    expect(toLegacyState(cargoStatus, taskStatus)).toBe(expected);
  });
});
