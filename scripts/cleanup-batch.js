/* eslint-disable */
// @ts-nocheck
/**
 * Clean up between scenario runs: cancel any non-terminal transport tasks and
 * soft-delete all live cargo, which frees the drop-off zone slots and the pickup
 * source points so the next run starts from an empty board.
 *
 * Mirrors EVAL-RUNBOOK §5 (DB path). Vehicles and zones are left untouched.
 *
 *   node scripts/cleanup-batch.js
 *
 * Reads DATABASE_URL from ./.env (falls back to the local default).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

async function main() {
  loadEnv();
  const connectionString =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/wes';
  const db = new Client({ connectionString });
  await db.connect();

  const tasks = await db.query(
    `UPDATE transport_requests tr
        SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
       FROM cargos c
      WHERE tr.cargo_id = c.id
        AND c.deleted_at IS NULL
        AND tr.status NOT IN ('CANCELLED', 'FAILED', 'DELIVERY_COMPLETED')
      RETURNING tr.id`,
  );
  const cargos = await db.query(
    `UPDATE cargos SET deleted_at = now(), updated_at = now()
      WHERE deleted_at IS NULL RETURNING id`,
  );

  console.log(
    `tasks cancelled: ${tasks.rowCount} | cargos soft-deleted: ${cargos.rowCount}`,
  );
  await db.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
