import { describe, expect, it } from "vitest";
import {
  BUILDER_CODE,
  BUILDER_CODE_SUFFIX,
  buildEvmPaperDraft,
  isBuilderCodeAttributed,
  withBuilderCodeSuffix,
} from "../src/index.js";

describe("ERC-8021 builder code attribution", () => {
  it("suffix carries the code and ends with the 8021 repeating pattern", () => {
    expect(BUILDER_CODE).toBe("bc_fakbdw5t");
    const body = BUILDER_CODE_SUFFIX.slice(2);
    // last 16 bytes are the 8021 repeating pattern
    expect(body.slice(-32)).toBe("80218021802180218021802180218021");
    // [len][code] prefix
    expect(parseInt(body.slice(0, 2), 16)).toBe(BUILDER_CODE.length);
    expect(Buffer.from(body.slice(2, 2 + BUILDER_CODE.length * 2), "hex").toString("utf8")).toBe(BUILDER_CODE);
  });

  it("appends the suffix once and idempotently", () => {
    const base = "0xdeadbeef";
    const once = withBuilderCodeSuffix(base);
    expect(once).toBe(base + BUILDER_CODE_SUFFIX.slice(2));
    expect(withBuilderCodeSuffix(once)).toBe(once);
  });

  it("every EVM paper draft is attributed", () => {
    const draft = buildEvmPaperDraft({
      chain: "base",
      amountInRaw: "1000000",
      tokenIn: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      tokenOut: "0x4200000000000000000000000000000000000006",
      minAmountOutRaw: "1",
    });
    expect(isBuilderCodeAttributed(draft.data)).toBe(true);
    // trailing 16 bytes are the 8021 pattern per the Base verification FAQ
    expect(draft.data.slice(-32)).toBe("80218021802180218021802180218021");
  });

  it("flags unattributed or corrupt calldata", () => {
    expect(isBuilderCodeAttributed("0xdeadbeef")).toBe(false);
    const good = withBuilderCodeSuffix("0xdeadbeef");
    const corrupt = good.slice(0, -2) + "ff";
    expect(isBuilderCodeAttributed(corrupt)).toBe(false);
  });

  it("rejects non-hex calldata", () => {
    expect(() => withBuilderCodeSuffix("nope")).toThrow(/hex/);
  });
});
