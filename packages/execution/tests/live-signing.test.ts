import { describe, expect, it } from "vitest";
import { verifyMessage } from "viem";
import { LiveEvmSigner } from "../src/live-signing.js";
import { DeterministicMockSigner } from "../src/signing.js";

/** Throwaway throwaway key generated for this test ONLY — never funded, never used anywhere else. */
const TEST_KEY: `0x${string}` = "0x59c3f7a2f6a6b1b47e5b3bc664f687d434e2d405df52e5b8a418bb5e68e2f1e3";

describe("LiveEvmSigner", () => {
  it("signs the canonical payload with a verifiable ECDSA signature", async () => {
    const signer = new LiveEvmSigner({ privateKey: TEST_KEY });
    expect(signer.mode).toBe("live");
    const result = await signer.signExecution("canonical execution payload v1");
    expect(result.mode).toBe("live");
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(result.signerId).toContain("live-evm-");
    // signature recovers to the signer's public address — proves real ECDSA
    const recovered = await verifyMessage({
      address: signer.address as `0x${string}`,
      message: "canonical execution payload v1",
      signature: result.signature as `0x${string}`,
    });
    expect(recovered).toBe(true);
  });

  it("rejects malformed keys and empty payloads (fail closed)", () => {
    expect(() => new LiveEvmSigner({ privateKey: "0x1234" as `0x${string}` })).toThrow();
    const signer = new LiveEvmSigner({ privateKey: TEST_KEY });
    expect(signer.signExecution("")).rejects.toThrow();
  });

  it("keeps the mock signer intact (port stays interchangeable)", async () => {
    const mock = new DeterministicMockSigner();
    const result = await mock.signExecution("payload");
    expect(result.mode).toBe("mock");
  });
});
