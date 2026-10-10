export interface LegacyFmsErrorDef {
  code: number;
  message: string;
}

export const LegacyFmsError = {
  REQUIRED_FIELDS: {
    code: 40001,
    message: 'Cargo name, position and destination are required',
  },
  NOT_CARGO_POSITION: {
    code: 40001,
    message: 'Position is not cargo position',
  },
  POSITION_NOT_FOUND: { code: 40002, message: 'Position does not exist' },
  LOCATION_NOT_FOUND: { code: 40003, message: 'Destination does not exist' },
  LOCATION_NOT_DESTINATION_TYPE: {
    code: 40004,
    message: 'Location is not SHIPPING type',
  },
  NAME_EXISTS: { code: 40900, message: 'Name already exists' },
  POSITION_OCCUPIED_BY_CARGO: {
    code: 40901,
    message: 'Position is occupied by another cargo',
  },
  POSITION_OCCUPIED_BY_VEHICLE: {
    code: 40902,
    message: 'Position occupied with vehicle assigned',
  },
  DESTINATION_FULL: { code: 40903, message: 'Destination full' },
} as const satisfies Record<string, LegacyFmsErrorDef>;

export const LEGACY_PERMISSION_DENIED = 'Permission denied!';

export class LegacyFmsException extends Error {
  readonly code: number;

  constructor(error: LegacyFmsErrorDef) {
    super(error.message);
    this.code = error.code;
  }
}

export function legacyHttpStatus(code: number): number {
  let status = code;
  while (status > 599) {
    status = Math.trunc(status / 10);
  }
  return status < 100 ? 500 : status;
}
