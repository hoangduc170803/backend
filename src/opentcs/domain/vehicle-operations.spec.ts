import { vehicleOperationsFor } from './vehicle-operations';

describe('vehicleOperationsFor', () => {
  it('gives loopback vehicles the openTCS default operation names', () => {
    expect(vehicleOperationsFor('loopback')).toEqual({
      load: 'PICK_UP',
      unload: 'DROP_OFF',
      charge: 'CHARGE',
    });
  });

  it('gives VDA5050 vehicles the action names the adapter sends on the wire', () => {
    expect(vehicleOperationsFor('vda5050')).toEqual({
      load: 'liftUp',
      unload: 'liftDown',
      charge: 'startCharging',
    });
  });

  it('refuses to boot on an unknown VEHICLE_TYPE instead of picking a default', () => {
    expect(() => vehicleOperationsFor('vda5051')).toThrow(
      /VEHICLE_TYPE không hợp lệ: "vda5051"/,
    );
    expect(() => vehicleOperationsFor('')).toThrow(/loopback \| vda5050/);
  });
});
