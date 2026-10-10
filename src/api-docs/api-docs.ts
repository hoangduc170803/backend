import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { LegacyFmsApiModule } from '../legacy-fms-api/legacy-fms-api.module';
import { ApiDocsRegistry } from './api-docs.registry';

interface LayerInfo {
  layer: string;
  title: string;
  description: string;
  server: string;
  serverDescription: string;
}

export function setupApiDocs(app: INestApplication): void {
  const kernelUrl = trimSlash(
    process.env.OPENTCS_KERNEL_URL ?? 'http://localhost:55200',
  );
  const kernelV8Url = trimSlash(
    process.env.OPENTCS_KERNEL_V8_URL ?? 'http://localhost:55300',
  );

  const legacy = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().addBearerAuth().build(),
    { include: [LegacyFmsApiModule] },
  );
  const wes = withoutPaths(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    ),
    legacy,
  );

  const registry = app.get(ApiDocsRegistry);
  registry.register(
    'wes',
    withLayer(wes, {
      layer: 'WES',
      title: 'Tầng WES — WES API',
      description:
        'Tầng WES (NestJS, cổng 3000, `/api/*`). Client wes-client-v2 gọi các API này; WES là tầng duy nhất gọi tiếp xuống kernel openTCS. ' +
        'Gồm Maps (Map Library, plant model), Operating (xe, lệnh, khu vực, hàng) và quản trị (RBAC, người dùng, token). Xác thực: Bearer JWT.',
      server: '/',
      serverDescription: 'Tầng WES',
    }),
  );
  registry.register(
    'legacy-fms-v1',
    withLayer(legacy, {
      layer: 'WES / Legacy FMS v1',
      title: 'Tầng WES / Legacy FMS API v1',
      description:
        'Chạy trong tiến trình WES (`/api/v1/*`) nhưng giữ nguyên hợp đồng của FMS cũ, cho máy quét cầm tay: kiểm tra vị trí, kiểm tra đích, thêm hàng. ' +
        'Lỗi nghiệp vụ trả `{ code, error }`; thiếu/sai token trả 403 `Permission denied!`. Xác thực: Bearer JWT (thường là token vĩnh viễn).',
      server: '/',
      serverDescription: 'Tầng WES (hợp đồng FMS cũ)',
    }),
  );
  registry.register(
    'kernel-v1',
    withLayer(loadSpec('opentcs-kernel-v1'), {
      layer: 'Kernel',
      title: 'Tầng Kernel — openTCS Web API v1 (7.4.0 + FMS extension)',
      description:
        `Tầng Kernel openTCS (\`${kernelUrl}/v1\`). Chỉ WES gọi (\`src/opentcs/\`). Tag **FMS extension** là endpoint riêng của \`FMSV1RequestHandler\`. ` +
        'Xác thực: header `X-Api-Access-Key` nếu kernel cấu hình `servicewebapi.accessKey` (mặc định trống).',
      server: `${kernelUrl}/v1`,
      serverDescription: 'Tầng Kernel (openTCS v1)',
    }),
  );
  registry.register(
    'kernel-v8',
    withLayer(loadSpec('opentcs-kernel-v8'), {
      layer: 'Kernel',
      title: 'Tầng Kernel — openTCS Web API v8 (preview, 7.4.0)',
      description: `Tầng Kernel openTCS, bản preview (\`${kernelV8Url}/v8\`). Hiện chưa tầng nào gọi. Xác thực: cookie phiên qua \`POST /login\`.`,
      server: `${kernelV8Url}/v8`,
      serverDescription: 'Tầng Kernel (openTCS v8 preview)',
    }),
  );
}

function withLayer(spec: OpenAPIObject, layer: LayerInfo): OpenAPIObject {
  const upstream = spec.info?.description;
  return {
    ...spec,
    info: {
      ...spec.info,
      title: layer.title,
      version: spec.info?.version || '1.0',
      description: upstream
        ? `${layer.description}\n\n---\n\n${upstream}`
        : layer.description,
      'x-layer': layer.layer,
    } as OpenAPIObject['info'],
    servers: [{ url: layer.server, description: layer.serverDescription }],
  };
}

function withoutPaths(
  spec: OpenAPIObject,
  excluded: OpenAPIObject,
): OpenAPIObject {
  const excludedPaths = new Set(Object.keys(excluded.paths));
  return {
    ...spec,
    paths: Object.fromEntries(
      Object.entries(spec.paths).filter(([path]) => !excludedPaths.has(path)),
    ),
  };
}

function loadSpec(name: string): OpenAPIObject {
  const file = join(__dirname, 'specs', `${name}.openapi.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as OpenAPIObject;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
