/* eslint-disable */
// @ts-nocheck
/**
 * Full evaluation run: preflight -> cleanup -> run -> sample -> verify -> tag -> report.
 *
 *   node scripts/run-full.js [scenario.json] [--force] [--no-cleanup] [--dry-run]
 *
 * Defaults to scripts/scenarios/fullpick-80-4zone.json.
 *
 * Env (all optional — defaults target the local dev stack):
 *   DATABASE_URL   default postgres://postgres:postgres@127.0.0.1:5432/wes
 *   WES_BASE_URL   default http://localhost:3000/api
 *   KERNEL_URL     default http://localhost:55200
 *   WES_USER       default quan.tran
 *   WES_PASS       default Wes@1234
 *   TIMEOUT_MS     default 1200000
 *   SAMPLE_MS      default 20000
 *   EXPECT_FLEET   default 15
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');

const TERMINAL_ORDER = new Set(['FINISHED', 'FAILED', 'WITHDRAWN', 'UNROUTABLE']);
const TERMINAL_TASK = new Set(['DELIVERY_COMPLETED', 'FAILED', 'CANCELLED']);

function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function login(baseUrl, user, pass) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  return (await res.json()).token;
}

function fmt(n, digits = 1) {
  return n === null || n === undefined ? '-' : Number(n).toFixed(digits);
}

async function preflight(cfg) {
  const problems = [];

  let vehicles = null;
  try {
    vehicles = await getJson(`${cfg.kernelUrl}/v1/vehicles`);
  } catch (err) {
    problems.push(`kernel unreachable at ${cfg.kernelUrl} (${err.message})`);
  }

  try {
    await login(cfg.baseUrl, cfg.user, cfg.pass);
  } catch (err) {
    problems.push(`WES API unreachable at ${cfg.baseUrl} (${err.message})`);
  }

  const summary = {};
  if (vehicles) {
    const ready = vehicles.filter((v) => v.integrationLevel === 'TO_BE_UTILIZED' && v.currentPosition);
    const batteries = vehicles.map((v) => v.energyLevel).sort((a, b) => a - b);
    const orders = await getJson(`${cfg.kernelUrl}/v1/transportOrders`);
    const open = orders.filter((t) => !TERMINAL_ORDER.has(t.state));

    summary.fleet = vehicles.length;
    summary.ready = ready.length;
    summary.batteries = batteries;
    summary.openOrders = open.length;

    if (ready.length < cfg.expectFleet) {
      problems.push(`only ${ready.length}/${cfg.expectFleet} vehicles ready (TO_BE_UTILIZED + positioned) — run scripts/trigger-fleet.js`);
    }
    if (open.length > 0) {
      problems.push(`${open.length} kernel orders still open — leftovers from a previous batch`);
    }

    const median = batteries[Math.floor(batteries.length / 2)];
    summary.median = median;
    if (median < 55) {
      summary.warnings = [
        `median battery ${median}% — expect a mid-batch charging round (~+150s when the whole fleet drains together)`,
      ];
    }
  }

  return { problems, summary };
}

async function cleanup(db) {
  const before = await db.query(
    "select status, count(*)::int from cargos where deleted_at is null group by status",
  );
  const tasks = await db.query(
    `update transport_requests tr set status='CANCELLED', cancelled_at=now(), updated_at=now()
     from cargos c where tr.cargo_id=c.id and c.deleted_at is null
     and tr.status not in ('CANCELLED','FAILED','DELIVERY_COMPLETED') returning tr.id`,
  );
  const cargos = await db.query(
    'update cargos set deleted_at=now(), updated_at=now() where deleted_at is null returning id',
  );
  return { before: before.rows, tasksCancelled: tasks.rowCount, cargosDeleted: cargos.rowCount };
}

function startSampler(cfg, cutIso, samples) {
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const vehicles = await getJson(`${cfg.kernelUrl}/v1/vehicles`);
        const orders = await getJson(`${cfg.kernelUrl}/v1/transportOrders`);
        const fresh = orders.filter((t) => (t.creationTime || '') > cutIso);
        const byPrefix = {};
        for (const t of fresh) {
          const p = t.name.split('-')[0];
          byPrefix[p] = (byPrefix[p] ?? 0) + 1;
        }
        samples.push({
          at: new Date().toISOString(),
          finished: fresh.filter((t) => t.state === 'FINISHED').length,
          dispatchable: fresh.filter((t) => t.state === 'DISPATCHABLE').length,
          charge: byPrefix.CHARGE ?? 0,
          park: byPrefix.PARK ?? 0,
          idle: vehicles.filter((v) => v.procState === 'IDLE').length,
          processing: vehicles.filter((v) => v.procState === 'PROCESSING_ORDER').length,
          critical: vehicles.filter((v) => (v.energyLevel ?? 0) <= 30).length,
          battMin: Math.min(...vehicles.map((v) => v.energyLevel)),
          battMax: Math.max(...vehicles.map((v) => v.energyLevel)),
        });
      } catch {
        samples.push({ at: new Date().toISOString(), error: true });
      }
      await sleep(cfg.sampleMs);
    }
  })();
  return { stop: () => { stop = true; return loop; } };
}

function runScenario(scenarioPath, cfg) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, 'run-scenario.js'), scenarioPath],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, TIMEOUT_MS: String(cfg.timeoutMs) },
      },
    );
    let out = '';
    const relay = (buf) => {
      const text = buf.toString();
      out += text;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (line.startsWith('  + cargo')) continue;
        if (line.includes('waiting…')) continue;
        console.log(`    ${line.trim()}`);
      }
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function metrics(db, runId) {
  const run = (await db.query('select id, started_at, ended_at, notes from runs where id=$1', [runId])).rows[0];
  if (!run) return null;

  const statuses = await db.query(
    `select tr.status, count(*)::int from transport_requests tr
     join cargos c on c.id = tr.cargo_id
     where c.created_at >= $1 group by tr.status order by 2 desc`,
    [run.started_at],
  );

  const legs = await db.query(
    `with t as (
       select tr.id,
              min(ts.occurred_at) filter (where ts.to_status='PICKING_UP')         as pick,
              min(ts.occurred_at) filter (where ts.to_status='DELIVERING')         as deliv,
              min(ts.occurred_at) filter (where ts.to_status='DELIVERY_COMPLETED') as done,
              min(ts.occurred_at)                                                  as created
       from transport_requests tr
       join cargos c on c.id = tr.cargo_id
       join task_status_transitions ts on ts.task_id = tr.id
       where c.created_at >= $1
       group by tr.id
     )
     select count(*)::int as n,
            avg(extract(epoch from (done - pick)))                                        as avg_task,
            percentile_cont(0.5) within group (order by extract(epoch from (done - pick))) as med_task,
            percentile_cont(0.9) within group (order by extract(epoch from (done - pick))) as p90_task,
            avg(extract(epoch from (deliv - pick)))                                        as avg_pick_leg,
            avg(extract(epoch from (done - deliv)))                                        as avg_deliv_leg,
            avg(extract(epoch from (pick - created)))                                      as avg_queue,
            min(done) as first_done, max(done) as last_done
     from t where done is not null and pick is not null`,
    [run.started_at],
  );

  return { run, statuses: statuses.rows, legs: legs.rows[0] };
}

function analyseSamples(samples, endedAt) {
  const inRun = samples.filter((s) => !s.error && new Date(s.at) <= endedAt);
  const errors = samples.filter((s) => s.error).length;
  let longestFreeze = 0;
  let streak = 0;
  for (let i = 1; i < inRun.length; i++) {
    if (inRun[i].finished === inRun[i - 1].finished) {
      streak += 1;
      longestFreeze = Math.max(longestFreeze, streak);
    } else {
      streak = 0;
    }
  }
  return {
    samples: inRun.length,
    errors,
    longestFreeze,
    maxDispatchable: inRun.reduce((m, s) => Math.max(m, s.dispatchable), 0),
    maxCritical: inRun.reduce((m, s) => Math.max(m, s.critical), 0),
    chargeInRun: inRun.length ? inRun[inRun.length - 1].charge : 0,
    parkInRun: inRun.length ? inRun[inRun.length - 1].park : 0,
    battStart: inRun.length ? `${inRun[0].battMin}-${inRun[0].battMax}` : '-',
    battLow: inRun.reduce((m, s) => Math.min(m, s.battMin), 100),
  };
}

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const scenarioArg = args.find((a) => !a.startsWith('--'));
  const scenarioPath = scenarioArg ?? 'scripts/scenarios/fullpick-80-4zone.json';

  const cfg = {
    baseUrl: process.env.WES_BASE_URL ?? 'http://localhost:3000/api',
    kernelUrl: process.env.KERNEL_URL ?? 'http://localhost:55200',
    user: process.env.WES_USER ?? 'quan.tran',
    pass: process.env.WES_PASS ?? 'Wes@1234',
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 1_200_000),
    sampleMs: Number(process.env.SAMPLE_MS ?? 20_000),
    expectFleet: Number(process.env.EXPECT_FLEET ?? 15),
  };

  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/wes';

  console.log('── preflight ──────────────────────────────────────────────');
  const { problems, summary } = await preflight(cfg);
  if (summary.fleet !== undefined) {
    console.log(`  fleet      ${summary.ready}/${summary.fleet} ready`);
    console.log(`  battery    ${summary.batteries.join(', ')}   median ${summary.median}%`);
    console.log(`  open orders ${summary.openOrders}`);
    for (const w of summary.warnings ?? []) console.log(`  ~ ${w}`);
  }
  if (problems.length) {
    for (const p of problems) console.log(`  ! ${p}`);
    if (!flags.has('--force')) {
      console.error('\naborting — fix the above or re-run with --force');
      process.exit(1);
    }
    console.log('  (--force given, continuing)');
  } else {
    console.log('  all checks passed');
  }

  if (flags.has('--dry-run')) {
    console.log('\n--dry-run: stopping before cleanup');
    return;
  }

  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  try {
    if (!flags.has('--no-cleanup')) {
      console.log('\n── cleanup ────────────────────────────────────────────────');
      const c = await cleanup(db);
      console.log(`  before: ${JSON.stringify(c.before)}`);
      console.log(`  cancelled ${c.tasksCancelled} tasks, soft-deleted ${c.cargosDeleted} cargo`);
    }

    const beforeMax = (await db.query('select coalesce(max(id::int), 0)::int as m from runs')).rows[0].m;
    const cutIso = new Date(Date.now() - 60_000).toISOString().slice(0, 16);
    const samples = [];
    const sampler = startSampler(cfg, cutIso, samples);

    console.log('\n── run ────────────────────────────────────────────────────');
    console.log(`  scenario ${scenarioPath}  timeout ${cfg.timeoutMs}ms`);
    const started = Date.now();
    const { code } = await runScenario(scenarioPath, cfg);
    await sampler.stop();
    console.log(`  runner exited ${code} after ${((Date.now() - started) / 1000).toFixed(1)}s`);

    const runId = String(
      (await db.query('select coalesce(max(id::int), 0)::int as m from runs')).rows[0].m,
    );
    if (Number(runId) <= beforeMax) {
      console.error('\nno new run row was created — runner failed before opening the run');
      process.exit(1);
    }

    console.log('\n── verify ─────────────────────────────────────────────────');
    const m = await metrics(db, runId);
    const endedAt = m.run.ended_at ?? new Date();
    const trueMakespan = m.legs.last_done
      ? (new Date(m.legs.last_done) - new Date(m.run.started_at)) / 1000
      : null;
    const runnerElapsed = m.run.ended_at
      ? (new Date(m.run.ended_at) - new Date(m.run.started_at)) / 1000
      : null;

    const s = analyseSamples(samples, new Date(endedAt));
    const done = m.statuses.find((r) => r.status === 'DELIVERY_COMPLETED')?.count ?? 0;
    const total = m.statuses.reduce((a, r) => a + r.count, 0);
    const stuck = total - done;

    console.log(`  run #${runId}  ${m.run.started_at.toISOString()} -> ${m.run.ended_at ? m.run.ended_at.toISOString() : 'NULL'}`);
    console.log(`  statuses   ${JSON.stringify(m.statuses)}`);
    console.log(`  makespan   ${fmt(trueMakespan)}s (DB)   runner reported ${fmt(runnerElapsed)}s`);
    console.log(`  task       med ${fmt(m.legs.med_task)}s  avg ${fmt(m.legs.avg_task)}s  p90 ${fmt(m.legs.p90_task)}s`);
    console.log(`  legs       pick ${fmt(m.legs.avg_pick_leg)}s  deliv ${fmt(m.legs.avg_deliv_leg)}s   queue-wait ${fmt(m.legs.avg_queue)}s`);
    console.log(`  battery    start ${s.battStart}  low ${s.battLow}   critical max ${s.maxCritical}`);
    console.log(`  orders     CHARGE ${s.chargeInRun}  PARK ${s.parkInRun}   DISPATCHABLE max ${s.maxDispatchable}`);
    console.log(`  sampler    ${s.samples} samples, ${s.errors} errors, longest freeze ${s.longestFreeze} samples (~${s.longestFreeze * (cfg.sampleMs / 1000)}s)`);

    let reason;
    if (stuck === 0) reason = 'complete';
    else if (s.longestFreeze * cfg.sampleMs >= 180_000) reason = 'deadlock';
    else reason = 'failed';

    const tagged = await db.query(
      "update runs set notes = notes || ' | reason: ' || $2 where id=$1 and notes not like '%reason: '||$2||'%' returning notes",
      [runId, reason],
    );
    console.log(`\n  tagged     reason: ${reason}${tagged.rowCount ? '' : ' (already tagged)'}`);
    if (stuck > 0) {
      console.log(`  ! ${stuck}/${total} tasks did not reach DELIVERY_COMPLETED — inspect before trusting this run`);
    }
  } finally {
    await db.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
