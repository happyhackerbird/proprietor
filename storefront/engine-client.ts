/**
 * engine-client.ts (storefront) — thin client for the engine's FREE /preview
 * (name disambiguation). The PAID fulfilment path does NOT call the engine
 * directly — it pays the supplier (see fulfiller.ts). A non-2xx response raises.
 */
export interface DisambiguationChoice {
  id: string;
  display_name: string;
  description?: string | null;
  domain?: string | null;
}

export interface PreviewResponse {
  disambiguation_choices: DisambiguationChoice[];
}

export interface PreviewClient {
  preview(company: string): Promise<PreviewResponse>;
}

export class HttpPreviewClient implements PreviewClient {
  constructor(private readonly baseUrl: string) {}

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
