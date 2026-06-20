/**
 * engine-client.ts — typed HTTP client for the Python fulfilment engine.
 *
 * Boundary shapes mirror engine/app/models.py (EnrichResponse / CostBreakdown /
 * EnrichRequest). Injected behind an interface so the supplier is offline-testable
 * with a fake. A non-2xx engine response RAISES — no silent substitution of an
 * empty/placeholder profile.
 */
import type { Depth } from "../lib/env.ts";

export interface CostBreakdown {
  tavily_searches: number;
  nebius_calls: number;
  nebius_tokens: number;
  est_usd: number;
}

export interface CompanyProfile {
  company: string;
  confidence: number;
  basics: Record<string, unknown>;
  product: Record<string, unknown>;
  funding: Record<string, unknown>;
  hiring: Record<string, unknown>;
  news: Record<string, unknown>;
}

export interface EnrichResponse {
  profile: CompanyProfile;
  cost: CostBreakdown;
  cache_hit: boolean;
  depth_served: Depth;
}

export interface EnrichRequest {
  company: string;
  depth: Depth;
  force_refresh?: boolean;
}

export interface PreviewResponse {
  disambiguation_choices: Array<{ id: string; display_name: string; description?: string | null; domain?: string | null }>;
}

export interface EngineClient {
  enrich(req: EnrichRequest): Promise<EnrichResponse>;
  preview(company: string): Promise<PreviewResponse>;
}

export class HttpEngineClient implements EngineClient {
  constructor(private readonly baseUrl: string) {}

  async enrich(req: EnrichRequest): Promise<EnrichResponse> {
    const res = await fetch(`${this.baseUrl}/enrich`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`engine /enrich failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as EnrichResponse;
  }

  async preview(company: string): Promise<PreviewResponse> {
    const res = await fetch(`${this.baseUrl}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company }),
    });
    if (!res.ok) {
      throw new Error(`engine /preview failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as PreviewResponse;
  }
}
