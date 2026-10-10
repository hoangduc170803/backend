// Creates and drops its own disposable LOCAL database. Never migrates the configured WES DB.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { DataSource } = require('typeorm');
const { AppDataSource } = require('../dist/database/data-source');
const configured = AppDataSource.options;
const url = configured.url ? new URL(configured.url) : null;
const host = url?.hostname ?? configured.host;
if (!['localhost', '127.0.0.1', '::1'].includes(host))
  throw new Error('Rehearsal only permits a local PostgreSQL host.');
const config = {
  host,
  port: Number(url?.port || configured.port || 5432),
  user: url ? decodeURIComponent(url.username) : configured.username,
  password: url ? decodeURIComponent(url.password) : configured.password,
  database: 'postgres',
};
const database = `wes_review_${Date.now()}_${process.pid}`;
if (!/^wes_review_\d+_\d+$/.test(database))
  throw new Error('Invalid disposable database name');
const admin = new Client(config);
let scratch;
let created = false;
async function main() {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  scratch = new Client({ ...config, database });
  await scratch.connect();
  let schema = fs.readFileSync(
    path.join(__dirname, '../database/schema.sql'),
    'utf8',
  );
  schema = schema.replace(
    /COPY public\.migrations \(id, "timestamp", name\) FROM stdin;\r?\n([\s\S]*?)\\\./,
    (_, body) => {
      const rows = body
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [id, timestamp, name] = line.split('\t');
          if (
            !/^\d+$/.test(id) ||
            !/^\d+$/.test(timestamp) ||
            !/^\w+$/.test(name)
          )
            throw new Error('Unexpected migration ledger');
          return `(${id}, ${timestamp}, '${name}')`;
        });
      return `INSERT INTO public.migrations (id, "timestamp", name) VALUES ${rows.join(',')};`;
    },
  );
  await scratch.query(schema);
  const ds = new DataSource({
    ...configured,
    url: undefined,
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    database,
    logging: false,
  });
  await ds.initialize();
  try {
    await ds.runMigrations();
    assert.equal(
      (
        await ds.query(
          "SELECT count(*)::int AS count FROM permissions WHERE key IN ('agvs.manage','dispatch.manage')",
        )
      )[0].count,
      2,
    );
    console.log('PASS fresh bootstrap + migrations');
    let rollbackCount = 0;
    while (
      (
        await ds.query(
          "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='zones' AND column_name='map_record_id'",
        )
      )[0].count > 0
    ) {
      await ds.undoLastMigration();
      rollbackCount++;
    }
    assert.equal(
      (
        await ds.query(
          "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='zones' AND column_name='map_record_id'",
        )
      )[0].count,
      0,
    );
    console.log(`PASS rollback of ${rollbackCount} review migrations`);
    const [a] = await ds.query(
      "INSERT INTO map_records(name,original_filename,last_loaded_at) VALUES ('tie','a.xml','2026-01-01') RETURNING id",
    );
    await ds.query(
      "INSERT INTO map_records(name,original_filename,last_loaded_at) VALUES ('tie','b.xml','2026-01-01')",
    );
    const [b] = await ds.query(
      "INSERT INTO map_records(name,original_filename,last_loaded_at) VALUES ('unique','c.xml','2026-01-01') RETURNING id",
    );
    await ds.query(
      "INSERT INTO zones(name,type,plant_model_name) VALUES ('ambiguous','PICKUP','tie'),('matched','PICKUP','unique')",
    );
    await ds.runMigrations();
    const rows = await ds.query(
      'SELECT name,map_record_id FROM zones ORDER BY name',
    );
    assert.equal(rows.find((z) => z.name === 'ambiguous').map_record_id, null);
    assert.equal(rows.find((z) => z.name === 'matched').map_record_id, b.id);
    console.log(
      'PASS upgrade backfill: tie stays NULL; unique record is assigned',
    );
    await ds.undoLastMigration();
    await ds.query("UPDATE zones SET map_record_id=$1 WHERE name='ambiguous'", [
      a.id,
    ]);
    await ds.runMigrations();
    assert.equal(
      (
        await ds.query(
          'SELECT count(*)::int AS count FROM zone_map_binding_audit',
        )
      )[0].count,
      1,
    );
    assert.equal(
      (
        await ds.query("SELECT map_record_id FROM zones WHERE name='ambiguous'")
      )[0].map_record_id,
      a.id,
    );
    console.log(
      'PASS already-applied backfill audit preserves possible manual assignments',
    );
    const { RbacService } = require('../dist/admin-rbac/rbac.service');
    const { RoleEntity } = require('../dist/users/entities/role.entity');
    const {
      RolePermissionEntity,
    } = require('../dist/users/entities/role-permission.entity');
    const {
      RoleMapScopeEntity,
    } = require('../dist/users/entities/role-map-scope.entity');
    const {
      UserRoleEntity,
    } = require('../dist/users/entities/user-role.entity');
    const {
      MapRecordEntity,
    } = require('../dist/maps/infrastructure/entities/map-record.entity');
    let refreshes = 0;
    const rbac = new RbacService(
      ds.getRepository(RoleEntity),
      ds.getRepository(RolePermissionEntity),
      ds.getRepository(RoleMapScopeEntity),
      ds.getRepository(UserRoleEntity),
      ds.getRepository(MapRecordEntity),
      {
        refresh() {
          refreshes++;
        },
      },
    );
    const [role] = await ds.query(
      "INSERT INTO roles(key,name,is_system) VALUES ('review','Review',false) RETURNING id",
    );
    await rbac.setMapScope(role.id, { mapRecordIds: [a.id] });
    await ds.query(
      `CREATE FUNCTION reject_review_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated insert failure'; END $$`,
    );
    await ds.query(
      'CREATE TRIGGER reject_review_scope BEFORE INSERT ON role_map_scopes FOR EACH ROW EXECUTE FUNCTION reject_review_scope()',
    );
    await assert.rejects(
      rbac.setMapScope(role.id, { mapRecordIds: [b.id] }),
      /simulated insert failure/,
    );
    assert.deepEqual(
      await ds.query(
        'SELECT map_record_id FROM role_map_scopes WHERE role_id=$1',
        [role.id],
      ),
      [{ map_record_id: a.id }],
    );
    assert.equal(refreshes, 1);
    await ds.query('DROP TRIGGER reject_review_scope ON role_map_scopes');
    await Promise.all([
      rbac.setMapScope(role.id, { mapRecordIds: [a.id] }),
      rbac.setMapScope(role.id, { mapRecordIds: [b.id] }),
    ]);
    assert.equal(
      (
        await ds.query(
          'SELECT map_record_id FROM role_map_scopes WHERE role_id=$1',
          [role.id],
        )
      ).length,
      1,
    );
    console.log(
      'PASS real RbacService transaction: failed insert preserves scope; concurrent replacements do not union',
    );
  } finally {
    await ds.destroy();
  }
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (scratch) await scratch.end();
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  });
