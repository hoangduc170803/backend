<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Getting Started (FE-07 — Auth, Account & Admin User Management)

### Prerequisites
- Node.js 20+
- PostgreSQL 16+ running locally (or via `docker compose up -d`)

### 1. Backend

```bash
# Install dependencies
pnpm install

# Create the database and apply the schema
#   (Docker:  docker compose up -d   — auto-applies schema.sql)
createdb wes
psql -d wes -f database/schema.sql

# (optional) Load test data: 12 users, password "Wes@1234"
psql -d wes -f database/seed.sql

# Configure environment
copy .env.example .env        # then edit PGPASSWORD / DATABASE_URL

# Seed the initial admin (admin / Wes@1234)
npm run seed

# Run the API → http://localhost:3000/api
npm run start:dev
```

### 2. Frontend

```bash
cd frontend
pnpm install
npm run dev                   # http://localhost:5173
```

The frontend calls the real backend (proxied `/api` → `:3000`). Sign in with a
seeded account — e.g. `admin`, or any `database/seed.sql`
account — all use password `Wes@1234`.

### Default scripts

```bash
npm run start:dev    # backend, watch mode
npm run build        # compile (nest build)
npm run seed         # seed initial admin
npm run start:prod   # node dist/main
```

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).

---

## SQL chẩn đoán Dispatcher

Các query dưới đây dùng cho PostgreSQL database `wes`.

### 1. Tìm task “ma”

Theo logic dispatcher, AGV đang bận khi task có trạng thái `PICKING_UP` hoặc `DELIVERING` và có `metadata.assignedVehicleName`.

Query sau tìm các task có dấu hiệu bị treo hoặc không còn hợp lệ:

```sql
SELECT
    tr.id AS task_id,
    tr.request_code,
    tr.status AS task_status,
    tr.metadata ->> 'assignedVehicleName' AS agent_name,
    tr.metadata ->> 'pickupOrderName' AS pickup_order,
    tr.metadata ->> 'approachOrderName' AS approach_order,
    tr.metadata ->> 'dropoffOrderName' AS dropoff_order,
    c.item_code,
    c.status AS cargo_status,
    tr.created_at,
    tr.updated_at,
    now() - tr.updated_at AS stale_for,
    last_transition.to_status AS last_transition_status,
    last_transition.occurred_at AS last_transition_at,
    last_transition.reason AS last_transition_reason
FROM public.transport_requests tr
LEFT JOIN public.cargos c
    ON c.id = tr.cargo_id
LEFT JOIN LATERAL (
    SELECT
        tst.to_status,
        tst.occurred_at,
        tst.reason
    FROM public.task_status_transitions tst
    WHERE tst.task_id = tr.id
    ORDER BY tst.occurred_at DESC
    LIMIT 1
) last_transition ON TRUE
WHERE tr.status IN ('PICKING_UP', 'DELIVERING')
  AND (
      tr.metadata ->> 'assignedVehicleName' IS NULL
      OR tr.updated_at < now() - INTERVAL '5 minutes'
      OR c.status IS DISTINCT FROM 'ACTIVE'
      OR tr.cargo_id IS NULL
  )
ORDER BY tr.updated_at;
```

Nếu query trả về `0 rows` thì hiện không có task “ma” trong `transport_requests`. Không nên cancel các task đang `READY_TO_ASSIGN`; đó là task đang chờ dispatcher gán xe.

### 2. Tìm xe/AGV trùng tên

Dispatcher group AGV theo `name`. Nếu cùng một tên xuất hiện nhiều lần, toàn bộ các bản ghi trùng tên sẽ bị loại khỏi danh sách ứng viên.

```sql
SELECT
    name,
    COUNT(*) AS duplicate_count,
    ARRAY_AGG(id ORDER BY id) AS agv_ids,
    ARRAY_AGG(
        COALESCE(NULLIF(plant_model_name, ''), '[NO_MAP]')
        ORDER BY id
    ) AS maps
FROM public.agvs
GROUP BY name
HAVING COUNT(*) > 1
ORDER BY name;
```

Để xem chi tiết các bản ghi thuộc nhóm trùng tên:

```sql
WITH duplicate_names AS (
    SELECT name
    FROM public.agvs
    GROUP BY name
    HAVING COUNT(*) > 1
)
SELECT
    a.id,
    a.code,
    a.name,
    a.plant_model_name,
    a.is_dispatch_enabled,
    a.is_ignored,
    als.state AS live_state,
    als.battery_level,
    als.last_synced_at
FROM public.agvs a
JOIN duplicate_names d
    ON d.name = a.name
LEFT JOIN public.agv_live_status als
    ON als.agv_id = a.id
ORDER BY a.name, a.plant_model_name NULLS FIRST, a.id;
```

Nếu có xe trùng tên, cần xác định bản ghi cũ/không có map rồi đổi tên hoặc loại khỏi nhóm trùng. Chỉ đặt `is_ignored = true` là chưa đủ nếu tên vẫn bị trùng.
