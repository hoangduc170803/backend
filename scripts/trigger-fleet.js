/* eslint-disable */
// @ts-nocheck
/**
 * Re-trigger the AGV fleet after a kernel restart (runbook §1).
 *
 *   node scripts/trigger-fleet.js [--count 15]
 *
 * POST /agvs/:id/connect enables the comm adapter and sets loadOperation /
 * unloadOperation / operatingTime plus integration level TO_BE_UTILIZED. For
 * VDA5050 vehicles that is enough — the sim reports its own position, so there
 * is no separate placement call (WES no longer exposes /agvs/:id/position).
 *
 * Env (all optional):
 *   WES_BASE_URL   default http://localhost:3000/api
 *   KERNEL_URL     default http://localhost:55200
 *   WES_USER       default quan.tran
 *   WES_PASS       default Wes@1234
 */

'use strict';

const cfg = {
  baseUrl: process.env.WES_BASE_URL ?? 'http://localhost:3000/api',
  kernelUrl: process.env.KERNEL_URL ?? 'http://localhost:55200',
  user: process.env.WES_USER ?? 'quan.tran',
  pass: process.env.WES_PASS ?? 'Wes@1234',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function login() {
  const res = await fetch(`${cfg.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: cfg.user, password: cfg.pass }),
  });
  if (!res.ok) throw new Error(`login ${res.status} — is the WES backend up?`);
  return (await res.json()).token;
}

async function main() {
  const count = Number(arg('count', 15));
  const token = await login();
  const listed = await fetch(`${cfg.baseUrl}/agvs?limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const agvs = (Array.isArray(listed) ? listed : listed.agvs ?? []).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const targets = agvs.slice(0, count);
  if (targets.length < count) {
    console.log(`only ${targets.length} AGVs registered in WES, wanted ${count}`);
  }

  let ok = 0;
  for (const agv of targets) {
    const connect = await fetch(`${cfg.baseUrl}/agvs/${agv.id}/connect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (connect.ok) ok++;
    console.log(`  ${agv.name}  connect=${connect.status}${connect.ok ? '' : '  <-- FAILED'}`);
  }

  await new Promise((r) => setTimeout(r, 3000));

  const after = await fetch(`${cfg.kernelUrl}/v1/vehicles`).then((r) => r.json());
  const ready = after.filter((v) => v.integrationLevel === 'TO_BE_UTILIZED' && v.currentPosition);
  console.log(`\n${ok}/${targets.length} triggered — kernel now reports ${ready.length}/${after.length} ready`);
  if (ready.length < targets.length) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
