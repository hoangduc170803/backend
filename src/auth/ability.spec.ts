import { subject } from '@casl/ability';
import { createAppAbility, PERMISSION_POLICIES } from './ability';
import {
  ALL_PERMISSION_KEYS,
  SYSTEM_ROLE_GRANTS,
  UI_PERMISSION_KEYS,
} from './permission.catalogue';

describe('authorization ability', () => {
  it('maps every catalogue capability without granting unassigned keys', () => {
    // Screen / UI / column keys are client-side visibility only — capability rule, no domain policy.
    expect(Object.keys(PERMISSION_POLICIES).sort()).toEqual(
      ALL_PERMISSION_KEYS.filter((k) => !UI_PERMISSION_KEYS.includes(k)).sort(),
    );
    for (const key of ALL_PERMISSION_KEYS) {
      const ability = createAppAbility([key]);
      for (const candidate of ALL_PERMISSION_KEYS)
        expect(ability.can(candidate, 'Capability')).toBe(candidate === key);
    }
  });
  it.each(Object.entries(SYSTEM_ROLE_GRANTS))(
    'preserves grants for %s',
    (_, keys) => {
      const ability = createAppAbility(keys);
      for (const key of ALL_PERMISSION_KEYS)
        expect(ability.can(key, 'Capability')).toBe(keys.includes(key));
    },
  );
  it('does not treat a role name or unknown capability as a grant', () => {
    expect(createAppAbility(['admin', 'unknown']).rules).toEqual([]);
  });
  it('checks Map and Area instances against explicit map scope', () => {
    const ability = createAppAbility(['map.download', 'area.edit'], ['map-a']);
    expect(ability.can('download', subject('Map', { id: 'map-a' }))).toBe(true);
    expect(ability.can('download', subject('Map', { id: 'map-b' }))).toBe(
      false,
    );
    expect(
      ability.can('update', subject('Area', { mapRecordId: 'map-b' })),
    ).toBe(false);
    expect(
      createAppAbility(['map.download'], []).can(
        'download',
        subject('Map', { id: 'map-a' }),
      ),
    ).toBe(false);
  });
  it('checks Cargo instances against explicit map scope, same as Area', () => {
    const ability = createAppAbility(['cargo.create'], ['map-a']);
    expect(
      ability.can('create', subject('Cargo', { mapRecordId: 'map-a' })),
    ).toBe(true);
    expect(
      ability.can('create', subject('Cargo', { mapRecordId: 'map-b' })),
    ).toBe(false);
    expect(
      createAppAbility(['cargo.create']).can(
        'create',
        subject('Cargo', { mapRecordId: 'map-b' }),
      ),
    ).toBe(true);
  });
});
