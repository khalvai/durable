export interface OrderItem {
  sku: string;
  quantity: number;
}

/**
 * Test/demo-only fault injection. Each workflow step reads its own entry and
 * the in-memory services throw accordingly.
 */
export interface FaultSpec {
  /** Fail this many initial calls with a retryable error. */
  failTimes?: number;
  /** Fail every call with a permanent error. */
  permanent?: boolean;
  /** Simulate a slow downstream service. */
  delayMs?: number;
}

export type OrderFaults = Record<string, FaultSpec>;

export interface OrderInput {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  amount: number;
  faults?: OrderFaults;
}

export interface ReservationOutput {
  reservationId: string;
  items: OrderItem[];
}

export interface PaymentOutput {
  paymentId: string;
  amount: number;
}

export interface ShipmentOutput {
  shipmentId: string;
  trackingNumber: string;
}
