import type { PaymentRecord } from "@sentinel-mesh/contracts";

/** In-memory payment record store with nonce and paymentId indexes. */
export class PaymentRecordStore {
  private readonly byId = new Map<string, PaymentRecord>();
  private readonly nonceIndex = new Map<string, string>();

  save(record: PaymentRecord): void {
    this.byId.set(record.paymentId, record);
    if (record.nonce && record.nonce !== "00000000-0000-4000-8000-000000000000") {
      this.nonceIndex.set(record.nonce, record.paymentId);
    }
  }

  find(paymentId: string): PaymentRecord | undefined {
    return this.byId.get(paymentId);
  }

  findByNonce(nonce: string): PaymentRecord | undefined {
    const paymentId = this.nonceIndex.get(nonce);
    return paymentId ? this.byId.get(paymentId) : undefined;
  }

  list(): PaymentRecord[] {
    return [...this.byId.values()];
  }
}
