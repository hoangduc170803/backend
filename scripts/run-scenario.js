/* eslint-disable */
// @ts-nocheck
/**
 * Scenario runner for evaluation experiments.
 *
 *   node scripts/run-scenario.js <scenario.json> [--label X] [--notes "..."]
 *
 * What it does:
 *   1. Opens a `runs` row in Postgres (started_at = now()).
 *   2. Logs into the WES HTTP API and POSTs cargo per the scenario schedule
 *      (this is the real path — release + assignment engines run for real).
 *   3. Polls GET /api/cargo until every posted cargo reaches a terminal
 *      taskStatus (DELIVERY_COMPLETED / FAILED / CANCELLED) or a timeout.
 *   4. Closes the `runs` row (ended_at = now()). SIGINT closes it too,
 *      with notes marked "aborted", so the analysis window is always bounded.
 *
 * The `runs` row has no FK to the transition tables on purpose — analysis cuts
 * the transitions by the [started_at, ended_at] time window.
 *
 * Config via env (all optional except DATABASE_URL):
 *   DATABASE_URL   Postgres connection string (required)
 *   WES_BASE_URL   default http://localhost:3000/api
 *   WES_USER       default quan.tran
 *   WES_PASS       default Wes@1234
 *   POLL_MS        completion poll interval, default 2000
 *   TIMEOUT_MS     max wait for completion, default 600000 (10 min)
 *
 * Scenario file shape (JSON):
 *   {
 *     "label": "gate-check_batch10_5agv_seed1",
 *     "notes": "optional free text",
 *     "cargos": [
 *       { "atMs": 0,    "sourcePointName": "P-A-01", "destinationZoneId": "<uuid>", "count": 3 },
 *       { "atMs": 5000, "sourcePointName": "P-B-04", "destinationZoneId": "<uuid>", "itemCode": "SKU-9" }
 *     ]
 *   }
 *   - atMs: milliseconds after run start to POST this entry.
 *   - count: how many identical cargos to POST (default 1).
 *   - itemCode: optional; auto-generated if omitted.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const TERMINAL = new Set(['DELIVERY_COMPLETED', 'FAILED', 'CANCELLED']);

/**
 * Minimal .env loader (no dependency): fills process.env from ./.env for any
 * key not already set, so DATABASE_URL etc. don't have to be typed inline.
 */
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') out.label = argv[++i];
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--pass') out.pass = argv[++i];
    else out._.push(a);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const scenarioPath = args._[0];
  if (!scenarioPath) {
    console.error('usage: node scripts/run-scenario.js <scenario.json> [--label X] [--notes "..."]');
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }

  const baseUrl = (process.env.WES_BASE_URL ?? 'http://localhost:3000/api').replace(/\/$/, '');
  const user = args.user ?? process.env.WES_USER ?? 'quan.tran';
  const pass = args.pass ?? process.env.WES_PASS ?? 'Wes@1234';
  const pollMs = Number(process.env.POLL_MS ?? 2000);
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? 600000);

  const scenario = JSON.parse(fs.readFileSync(path.resolve(scenarioPath), 'utf8'));
  const label = args.label ?? scenario.label ?? path.basename(scenarioPath, '.json');
  const notes = args.notes ?? scenario.notes ?? null;
  const entries = Array.isArray(scenario.cargos) ? scenario.cargos.slice() : [];
  if (entries.length === 0) {
    console.error('scenario has no cargos');
    process.exit(2);
  }
  entries.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));

  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  // --- open the run ---------------------------------------------------------
  const { rows } = await db.query(
    'INSERT INTO runs (label, notes) VALUES ($1, $2) RETURNING id, started_at',
    [label, notes],
  );
  const runId = rows[0].id;
  console.log(`▶ run #${runId} "${label}" opened at ${rows[0].started_at.toISOString?.() ?? rows[0].started_at}`);

  let aborted = false;
  async function closeRun(extraNote) {
    const finalNotes = [notes, extraNote].filter(Boolean).join(' | ') || null;
    try {
      await db.query('UPDATE runs SET ended_at = now(), notes = $2 WHERE id = $1', [runId, finalNotes]);
      console.log(`■ run #${runId} closed${extraNote ? ` (${extraNote})` : ''}`);
    } catch (err) {
      console.error(`failed to close run #${runId}:`, err.message);
    }
  }

  const onSigint = () => {
    if (aborted) return;
    aborted = true;
    console.log('\n⚠ SIGINT — closing run as aborted...');
    closeRun('aborted').finally(async () => {
      await db.end().catch(() => {});
      process.exit(130);
    });
  };
  process.on('SIGINT', onSigint);

  try {
    // --- login ------------------------------------------------------------
    const token = await login(baseUrl, user, pass);

    // --- post cargo per schedule -----------------------------------------
    const t0 = Date.now();
    const pending = new Set(); // cargo ids we are waiting on
    let seq = 0;
    for (const entry of entries) {
      if (aborted) break;
      const due = t0 + (entry.atMs ?? 0);
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const count = entry.count ?? 1;
      for (let i = 0; i < count; i++) {
        const body = {
          sourcePointName: entry.sourcePointName,
          destinationZoneId: entry.destinationZoneId,
          itemCode: entry.itemCode ?? `SCN-${runId}-${++seq}`,
        };
        try {
          const cargo = await createCargo(baseUrl, token, body);
          pending.add(cargo.id);
          console.log(`  + cargo ${cargo.id} (${body.sourcePointName} → ${entry.destinationZoneId}) @ +${entry.atMs ?? 0}ms`);
        } catch (err) {
          console.error(`  ! failed to POST cargo (${body.sourcePointName}): ${err.message}`);
        }
      }
    }
    console.log(`… posted ${pending.size} cargo; waiting for completion (timeout ${timeoutMs}ms)`);

    // --- poll for completion ---------------------------------------------
    const deadline = Date.now() + timeoutMs;
    const outcome = { DELIVERY_COMPLETED: 0, FAILED: 0, CANCELLED: 0 };
    while (!aborted && pending.size > 0 && Date.now() < deadline) {
      await sleep(pollMs);
      let list;
      try {
        list = await listCargo(baseUrl, token);
      } catch (err) {
        console.error(`  ! poll failed: ${err.message}`);
        continue;
      }
      for (const c of list) {
        if (pending.has(c.id) && c.taskStatus && TERMINAL.has(c.taskStatus)) {
          pending.delete(c.id);
          outcome[c.taskStatus] = (outcome[c.taskStatus] ?? 0) + 1;
        }
      }
      process.stdout.write(`\r  waiting… ${pending.size} pending  (done ${outcome.DELIVERY_COMPLETED}, failed ${outcome.FAILED}, cancelled ${outcome.CANCELLED})   `);
    }
    process.stdout.write('\n');

    if (aborted) return;

    const note = pending.size > 0 ? `timeout: ${pending.size} unfinished` : 'complete';
    await closeRun(note);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nSummary run #${runId}:`);
    console.log(`  elapsed        ${elapsed}s`);
    console.log(`  delivered      ${outcome.DELIVERY_COMPLETED}`);
    console.log(`  failed         ${outcome.FAILED}`);
    console.log(`  cancelled      ${outcome.CANCELLED}`);
    console.log(`  unfinished     ${pending.size}`);
  } catch (err) {
    console.error('run failed:', err.message);
    await closeRun(`error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    await db.end().catch(() => {});
  }
}

// --- HTTP helpers -----------------------------------------------------------

async function login(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.token) throw new Error('login response has no token');
  return data.token;
}

async function createCargo(baseUrl, token, body) {
  const res = await fetch(`${baseUrl}/cargo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function listCargo(baseUrl, token) {
  const res = await fetch(`${baseUrl}/cargo?limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const body = await res.json();
  return Array.isArray(body) ? body : (body.cargos ?? []);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
