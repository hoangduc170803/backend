import { Injectable, NotFoundException } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

export const API_LAYER_SLUGS = [
  'wes',
  'legacy-fms-v1',
  'kernel-v1',
  'kernel-v8',
] as const;

export type ApiLayerSlug = (typeof API_LAYER_SLUGS)[number];

export interface ApiLayerSummary {
  slug: ApiLayerSlug;
  title: string;
  layer: string;
  description: string;
  server: string;
  permission: string;
  paths: number;
}

export const API_LAYER_PERMISSION: Record<ApiLayerSlug, string> = {
  wes: 'api_docs.wes',
  'legacy-fms-v1': 'api_docs.legacy_fms',
  'kernel-v1': 'api_docs.kernel_v1',
  'kernel-v8': 'api_docs.kernel_v8',
};

@Injectable()
export class ApiDocsRegistry {
  private readonly specs = new Map<ApiLayerSlug, OpenAPIObject>();

  register(slug: ApiLayerSlug, spec: OpenAPIObject): void {
    this.specs.set(slug, spec);
  }

  layersFor(permissions: ReadonlySet<string>): ApiLayerSummary[] {
    return API_LAYER_SLUGS.filter(
      (slug) =>
        this.specs.has(slug) && permissions.has(API_LAYER_PERMISSION[slug]),
    ).map((slug) => this.summarize(slug, this.specs.get(slug)!));
  }

  spec(slug: string): OpenAPIObject {
    const spec = this.specs.get(slug as ApiLayerSlug);
    if (!spec) throw new NotFoundException(`Không có tài liệu API: ${slug}`);
    return spec;
  }

  private summarize(slug: ApiLayerSlug, spec: OpenAPIObject): ApiLayerSummary {
    const info = spec.info as OpenAPIObject['info'] & { 'x-layer'?: string };
    return {
      slug,
      title: info.title,
      layer: info['x-layer'] ?? slug,
      description: info.description ?? '',
      server: spec.servers?.[0]?.url ?? '/',
      permission: API_LAYER_PERMISSION[slug],
      paths: Object.keys(spec.paths).length,
    };
  }
}
