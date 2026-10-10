import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_CATALOGUE,
  SYSTEM_ROLE_GRANTS,
  effectivePermissions,
  rolesGrantedOnIntroduction,
} from './permission.catalogue';

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...controllerFiles(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

describe('permission catalogue', () => {
  it('has unique keys', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
  });

  it('grants only keys that exist in the catalogue', () => {
    const known = new Set(ALL_PERMISSION_KEYS);
    for (const [role, keys] of Object.entries(SYSTEM_ROLE_GRANTS)) {
      for (const key of keys) {
        expect({ role, key, known: known.has(key) }).toEqual({
          role,
          key,
          known: true,
        });
      }
    }
  });

  it('admin is granted every permission', () => {
    expect([...SYSTEM_ROLE_GRANTS.admin].sort()).toEqual(
      [...ALL_PERMISSION_KEYS].sort(),
    );
  });

  const LADDER = [
    'viewer',
    'scanner',
    'mapper',
    'operator',
    'dispatcher',
    'tester',
    'dev',
    'admin',
  ];
  const holds = (role: string, key: string) =>
    SYSTEM_ROLE_GRANTS[role].includes(key);
  const firstHolder = (key: string) => LADDER.find((role) => holds(role, key));

  it('each tier holds everything of the tier it builds on', () => {
    const builtOn: [string, string[]][] = [
      ['scanner', ['viewer']],
      ['mapper', ['viewer']],
      ['operator', ['scanner', 'mapper']],
      ['dispatcher', ['operator']],
      ['tester', ['dispatcher']],
      ['dev', ['tester']],
      ['admin', ['dev']],
    ];
    for (const [role, bases] of builtOn)
      for (const base of bases)
        for (const key of SYSTEM_ROLE_GRANTS[base])
          expect({ role, key, held: holds(role, key) }).toEqual({
            role,
            key,
            held: true,
          });
  });

  it('introduces each capability at the tier that owns it', () => {
    const owner: Record<string, string> = {
      'op.dock.vehicles': 'viewer',
      'op.dock.alarms': 'viewer',
      'op.layers.areas': 'viewer',
      'op.layers.names': 'viewer',
      'op.layers.direction': 'viewer',
      'cargo.create': 'scanner',
      'cargo.cancel': 'scanner',
      'area.edit': 'mapper',
      'area.purge_cargo': 'mapper',
      'screen.map': 'mapper',
      'agvs.manage': 'operator',
      'screen.vehicles': 'operator',
      'vehicle.send_to_point': 'operator',
      'fleet.control': 'operator',
      'op.map.minimap': 'operator',
      'op.status.connections': 'operator',
      'op.status.cursor': 'operator',
      'op.dock.cargos': 'operator',
      'op.dock.areas': 'operator',
      'op.dock.vehicles.focus': 'operator',
      'screen.cargo': 'operator',
      'order.create': 'dispatcher',
      'op.dock.tasks': 'dispatcher',
      'screen.tasks': 'dispatcher',
      'screen.scanner': 'tester',
      'screen.api_docs': 'tester',
      'tools.agv': 'tester',
      'tools.cargo_generator': 'tester',
      'op.layers.slots': 'dev',
      'op.layers.obstacles': 'dev',
      'op.layers.type': 'dev',
      'op.dock.vehicles.detailed_layout': 'dev',
      'op.dock.vehicles.card.position': 'dev',
      'op.map.vehicle.label.all': 'dev',
      'op.map.free_zoom': 'dev',
      'screen.transport_orders': 'dev',
      'simulator.manage': 'dev',
      'screen.admin': 'admin',
      'roles.manage': 'admin',
      'users.manage': 'admin',
    };
    for (const [key, role] of Object.entries(owner))
      expect({ key, role: firstHolder(key) }).toEqual({ key, role });
  });

  it('keeps the scanner and the mapper out of the work of the other', () => {
    expect(holds('scanner', 'area.edit')).toBe(false);
    expect(holds('mapper', 'cargo.create')).toBe(false);
  });

  it('every @RequirePermissions key in a controller exists in the catalogue', () => {
    const known = new Set(ALL_PERMISSION_KEYS);
    const files = controllerFiles(resolve(__dirname, '..'));
    const used = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const re = /@RequirePermissions\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        for (const lit of m[1].matchAll(/['"]([^'"]+)['"]/g)) used.add(lit[1]);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) {
      expect({ key, known: known.has(key) }).toEqual({ key, known: true });
    }
  });

  it('every catalogue entry has a cluster, screen, group, kind and labels', () => {
    for (const p of PERMISSION_CATALOGUE) {
      expect(p.cluster).toBeTruthy();
      expect(p.screen && p.group && p.kind).toBeTruthy();
      expect(p.labelVi && p.labelEn && p.labelJa).toBeTruthy();
      expect(p.key.length).toBeLessThanOrEqual(64);
      expect(p.group.length).toBeLessThanOrEqual(48);
    }
  });

  it('every nav screen has an access key granted to all existing roles or by a rule', () => {
    const screens = new Set(
      PERMISSION_CATALOGUE.filter((p) => p.screen !== 'system').map(
        (p) => p.screen,
      ),
    );
    for (const screen of screens) {
      const access = PERMISSION_CATALOGUE.find(
        (p) => p.key === `screen.${screen}`,
      );
      expect({
        screen,
        kind: access?.kind,
        grant: !!access?.defaultGrant,
      }).toEqual({ screen, kind: 'screen', grant: true });
    }
  });

  it('server-enforced keys are never introduced silently to other roles', () => {
    for (const p of PERMISSION_CATALOGUE.filter((d) => d.kind === 'action')) {
      expect({ key: p.key, defaultGrant: p.defaultGrant }).toEqual({
        key: p.key,
        defaultGrant: undefined,
      });
    }
  });
});

describe('rolesGrantedOnIntroduction', () => {
  const grants = new Map<number, Set<string>>([
    [2, new Set(['order.create'])],
    [5, new Set(['users.view'])],
    [9, new Set()],
  ]);
  it('grants `all` keys to every role', () => {
    expect(rolesGrantedOnIntroduction({ defaultGrant: 'all' }, grants)).toEqual(
      [2, 5, 9],
    );
  });
  it('grants rule keys only to roles already holding a listed key', () => {
    expect(
      rolesGrantedOnIntroduction(
        { defaultGrant: ['users.view', 'roles.manage'] },
        grants,
      ),
    ).toEqual([5]);
  });
  it('grants nothing without a rule', () => {
    expect(rolesGrantedOnIntroduction({}, grants)).toEqual([]);
  });
});

describe('permission hierarchy', () => {
  it('every parent is a catalogue key and the tree has no cycle', () => {
    const byKey = new Map(PERMISSION_CATALOGUE.map((p) => [p.key, p]));
    for (const p of PERMISSION_CATALOGUE) {
      const seen = new Set<string>([p.key]);
      let parent = p.parent;
      while (parent) {
        expect({ key: p.key, parent, known: byKey.has(parent) }).toEqual({
          key: p.key,
          parent,
          known: true,
        });
        expect(seen.has(parent)).toBe(false);
        seen.add(parent);
        parent = byKey.get(parent)?.parent;
      }
    }
  });

  it('server-enforced keys never hang under a UI key', () => {
    for (const p of PERMISSION_CATALOGUE.filter((d) => d.kind === 'action'))
      expect({ key: p.key, parent: p.parent }).toEqual({
        key: p.key,
        parent: undefined,
      });
  });

  it('drops a key whose ancestor is missing, keeps full chains', () => {
    const effective = effectivePermissions(
      new Set([
        'screen.operating',
        'op.map.vehicle',
        'op.map.vehicle.outline',
        'op.map.vehicle.outline.alarm',
        'op.dock.vehicles',
        'op.col.vehicles.name',
        'vehicle.pause',
      ]),
    );
    expect(effective.has('op.map.vehicle.outline.alarm')).toBe(true);
    expect(effective.has('op.col.vehicles.name')).toBe(false);
    expect(effective.has('op.dock.vehicles')).toBe(false);
    expect(effective.has('vehicle.pause')).toBe(true);
  });

  it('turning off the screen switches off its whole tree', () => {
    const effective = effectivePermissions(
      new Set(ALL_PERMISSION_KEYS.filter((k) => k !== 'screen.operating')),
    );
    expect([...effective].filter((k) => k.startsWith('op.'))).toEqual([]);
  });
});
