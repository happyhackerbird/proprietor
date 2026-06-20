/**
 * fulfiller.ts (D16) — the storefront's fulfilment seam.
 *
 * `SupplierFulfiller` realizes the two-sided loop: it PAYS the supplier on-chain
 * (x402, via the reused treasury.payService, from the TREASURY wallet) and reads
 * back the research + the supplier settlement tx hash. This is the injection
 * point the future CFO wraps with its budget gate (it does not re-plumb payment).
 *
 * Failure-path: a supplier/engine error after the buyer was charged throws → the
 * storefront's paid handler surfaces a 502. No blind-retry, no silent success.
 */
import { Treasury } from "../money/treasury.ts";
import { env, parseUsd, type Depth } from "../lib/env.ts";
import type { CompanyProfile, CostBreakdown } from "../supplier/engine-client.ts";

export interface FulfilInput {
  company: string;
  depth: Depth;
  force_refresh?: boolean;
}

export interface FulfilResult {
  profile: CompanyProfile;
  cost: CostBreakdown;
  cache_hit: boolean;
  depth_served: Depth;
  wholesale_usdc: number;
  supplier_tx_hash: string | null;
}

export interface Fulfiller {
  fulfil(input: FulfilInput): Promise<FulfilResult>;
}

/** The shape the supplier's /research/<depth> route returns in its response body. */
interface SupplierBody {
  profile?: CompanyProfile;
  cost?: CostBreakdown;
  cache_hit?: boolean;
  depth_served?: Depth;
}

export class SupplierFulfiller implements Fulfiller {
  constructor(
    private readonly treasury: Treasury,
    private readonly supplierUrl: string = env.supplierUrl(),
    private readonly payFrom: string = env.treasuryAddress(),
    private readonly chain: string = env.chain(),
  ) {}

  async fulfil({ company, depth, force_refresh }: FulfilInput): Promise<FulfilResult> {
    const wholesale = env.wholesalePrice(depth); // "$0.015"
    const res = await this.treasury.payService({
      url: `${this.supplierUrl}/research/${depth}`,
      address: this.payFrom,
      chain: this.chain,
      method: "POST",
      data: { company, force_refresh: force_refresh ?? false },
      maxAmount: parseUsd(wholesale),
    });

    const body = res.response as SupplierBody | undefined;
    if (!body || !body.profile || !body.cost) {
      // Charged but no usable research came back — surface, never fake success.
      throw new Error(`supplier returned no profile for ${company}/${depth}: ${JSON.stringify(res.response)}`);
    }

    return {
      profile: body.profile,
      cost: body.cost,
      cache_hit: body.cache_hit ?? false,
      depth_served: body.depth_served ?? depth,
      wholesale_usdc: parseUsd(wholesale),
      supplier_tx_hash: res.txHash ?? null,
    };
  }
}
