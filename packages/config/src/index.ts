import { z } from "zod";

/**
 * Environment configuration for Sentinel Mesh services.
 *
 * Design rules:
 *  - Every environment variable the platform understands is declared here.
 *    Anything else fails validation (strict schema).
 *  - Development must work with ZERO environment variables: all infrastructure
 *    (database, redis) is optional and the API falls back to in-process mock
 *    drivers when they are unset. This keeps the dev environment deterministic
 *    and dependency-free.
 *  - Phase 0 guardrails are enums with a single legal value each:
 *      chainAdapterMode: "mock"        (no live chain access)
 *      policyMode:       "dry-run"     (no enforcement beyond evaluation)
 *      executionMode:    "disabled"    (fail-closed default; "paper" via explicit opt-in; "live" rejected)
 *    Setting any other value fails startup with a clear error.
 */

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

const EvmAddressPattern = /^0x[a-fA-F0-9]{40}$/;

export const AppConfig = z
  .object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    apiPort: z.coerce.number().int().min(1).max(65535).default(3001),
    orchestratorPort: z.coerce.number().int().min(1).max(65535).default(3002),
    /** Optional in dev. Unset means in-process mock drivers and no persistence. */
    databaseUrl: z.string().url().optional(),
    /** Optional in dev. Unset means the in-memory event bus. */
    redisUrl: z.string().url().optional(),
    /**
     * x402 receiver: OUR project EVM wallet (the EVM_PRIVATE_KEY holder).
     * Never point this at a third-party watched-trader wallet: payments
     * must only ever route to the wallet this project controls.
     */
    paymentsReceiverAddress: z.string().regex(EvmAddressPattern).default(
      "0x0bee61d45d42d7342d57ea7581d17581203447a8",
    ),
    /** Market data source: live (free public APIs, fixture fallback labeled per call) or fixture (deterministic placeholders). Default live since 2026-10-19. */
    dataSource: z.enum(["fixture", "live"]).default("live"),
    /**
     * x402 facilitation mode.
     * paper = mock facilitator (signatures trusted, settlement claimed).
     * live  = base-usdc-facilitator-v1 (see docs/ADR/ADR-003-live-x402-facilitator.md):
     *          EIP-3009 signatures verified cryptographically and settlement
     *          confirmed on-chain (receipt + authorizationStates) before any
     *          API content is unlocked. Live mode requires the strict settled-gate.
     */
    paymentsMode: z.enum(["paper", "live"]).default("paper"),
    /** Public Base JSON-RPC endpoint used by the live facilitator (HTTPS only). */
    baseRpcUrl: z.string().url().default("https://mainnet.base.org"),
    /**
     * USDC contract address on Base used for x402 settlement. Defaults to
     * canonical native USDC; override via BASE_USDC_ADDRESS if the
     * deployment chain's USDC lives elsewhere.
     */
    baseUsdcAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    /**
     * Treasury gas top-up: auto-convert received USDC revenue into
     * just-enough ETH gas (Base) and SOL gas (Solana, via Mayan) after
     * each settled x402 payment. Disabled by default; live deployments
     * opt in with TREASURY_ENABLED=true.
     */
    treasuryEnabled: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    /** ETH gas target for the project wallet (wei). Default 0.003 ETH. */
    treasuryEthTargetWei: z.coerce.bigint().positive().default(3_000_000_000_000_000n),
    /** SOL gas target for the Solana project wallet (lamports). Default 0.1 SOL. */
    treasurySolTargetLamports: z.coerce.bigint().positive().default(100_000_000n),
    /** USDC raw kept as operating reserve — never auto-swapped. */
    treasuryUsdcReserveRaw: z.coerce.bigint().min(0n).default(0n),
    /** Slippage for treasury swaps, basis points (max 10%). */
    treasurySlippageBps: z.coerce.number().int().min(0).max(1000).default(500),
    /** Solana project wallet: SOL gas destination and Mayan bridge target. */
    solanaWalletAddress: z.string().min(32).default("H2jn8HAwt14tJEmQ4g9uFMGWsznWuKoooACDA6STFWVF"),
    /** Phase 0: only "mock" is legal. The enum documents the future "readonly" mode. */
    chainAdapterMode: z.enum(["mock", "readonly"]).default("mock").refine(
      (mode) => mode === "mock",
      { message: "phase 0 supports chainAdapterMode=mock only; readonly adapters are not enabled yet" },
    ),
    /**
     * Policy posture. "dry-run": signals are evaluated and recorded, but
     * nothing is ever submitted for execution (phase 0 behavior).
     * "enforce" (ADR-016): an "allow" policy decision on a signal with
     * explicit amounts authorizes and submits a guarded intent through
     * the full guard pipeline (kill switch, idempotency, policy
     * re-check, authorization, limits, liquidity, bounds, validation,
     * signing). Caps are ENFORCED on every fill, not just evaluated.
     */
    policyMode: z.enum(["dry-run", "enforce"]).default("dry-run"),
    /**
     * Guarded execution mode. "paper" enables the guarded paper executor
     * (mock signing, never broadcast). "disabled" is the fail-closed default
     * for any environment that has not opted in. "live" is REJECTED at config
     * load: live trading requires the production go-live checklist
     * (docs/EXECUTION.md) and a deliberate platform release.
     */
    /**
     * Guarded execution mode (ADR-016). "disabled": fail-closed default.
     * "paper": guarded paper executor (mock signing, never broadcast).
     * "live": real swaps via the live trade legs — requires
     * policyMode=enforce (validateExecutionCoupling), both runtime
     * signer keys at boot (buildExecutionStack fails closed), and the
     * docs/EXECUTION.md go-live checklist completed by the operator.
     * Owner approved live trading 2026-10-19; release = deliberately
     * setting EXECUTION_MODE=live in the deployment environment.
     */
    executionMode: z.enum(["disabled", "paper", "live"]).default("disabled"),
    mockSignerAddress: z.string().regex(EvmAddressPattern).default(`0x${"0".repeat(40)}`),
    policyMaxNotionalUsdCents: z.coerce
      .number()
      .int()
      .positive()
      .max(100_000_00)
      .default(50_000),
    /**
     * CORS: browser origins allowed to call the service APIs. Empty or
     * "none" disables CORS (same-origin / non-browser callers only, e.g.
     * when a zero-trust proxy fronts the service and browsers hit the
     * proxy's origin). Production should list exactly the web dashboard
     * origin(s).
     */
    allowedOrigins: z
      .string()
      .transform((raw) =>
        raw
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0 && origin !== "none"),
      )
      .pipe(z.array(z.string().url()).min(0))
      .default("http://localhost:3000"),
  })
  .strict();

export type AppConfig = z.infer<typeof AppConfig>;

function pick(env: NodeJS.ProcessEnv) {
  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    apiPort: env.API_PORT,
    orchestratorPort: env.ORCHESTRATOR_PORT,
    databaseUrl: env.DATABASE_URL === "" ? undefined : env.DATABASE_URL,
    redisUrl: env.REDIS_URL === "" ? undefined : env.REDIS_URL,
    paymentsReceiverAddress: env.PAYMENTS_RECEIVER_ADDRESS,
    paymentsMode: env.PAYMENTS_MODE,
    baseRpcUrl: env.BASE_RPC_URL,
    baseUsdcAddress: env.BASE_USDC_ADDRESS,
    treasuryEnabled: env.TREASURY_ENABLED === undefined ? undefined : String(env.TREASURY_ENABLED).toLowerCase(),
    treasuryEthTargetWei: env.TREASURY_ETH_TARGET_WEI,
    treasurySolTargetLamports: env.TREASURY_SOL_TARGET_LAMPORTS,
    treasuryUsdcReserveRaw: env.TREASURY_USDC_RESERVE_RAW,
    treasurySlippageBps: env.TREASURY_SLIPPAGE_BPS,
    solanaWalletAddress: env.SOLANA_WALLET_ADDRESS,
    dataSource: env.DATA_SOURCE,
    chainAdapterMode: env.CHAIN_ADAPTER_MODE,
    policyMode: env.POLICY_MODE,
    executionMode: env.EXECUTION_MODE,
    mockSignerAddress: env.MOCK_SIGNER_ADDRESS,
    policyMaxNotionalUsdCents: env.POLICY_MAX_NOTIONAL_USD_CENTS,
    allowedOrigins: env.ALLOWED_ORIGINS,
  };
}

/**
 * Load and validate configuration from an environment object.
 * Throws ConfigValidationError with per-variable details on failure.
 */
/**
 * Cross-field coupling (ADR-016): EXECUTION_MODE=live is only legal with
 * POLICY_MODE=enforce — live trades can never run under a dry-run policy
 * posture. Active the moment the executionMode gate (which still rejects
 * "live" until the owner releases it per docs/EXECUTION.md) is lifted.
 */
export function validateExecutionCoupling(config: {
  executionMode: string;
  policyMode: string;
}): void {
  if (config.executionMode === "live" && config.policyMode !== "enforce") {
    throw new ConfigValidationError(
      "Invalid environment configuration:\n  - executionMode: live execution requires policyMode=enforce (dry-run policy posture can never gate live trades)",
      [{ path: "executionMode", message: "live requires policyMode=enforce" }],
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = AppConfig.safeParse(pick(env));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
      message: issue.message,
    }));
    const summary = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
    throw new ConfigValidationError(`Invalid environment configuration:\n${summary}`, issues);
  }
  validateExecutionCoupling(result.data);
  return result.data;
}
