import { PermanentError, RetryableError } from "../../engine/errors.js";
import type {
  FaultSpec,
  OrderItem,
  PaymentOutput,
  ReservationOutput,
  ShipmentOutput,
} from "./types.js";

/**
 * Tracks how many times a given idempotency key was invoked so the demo can
 * fail the first N attempts.
 */
function createFaultGate(): (key: string, fault?: FaultSpec) => Promise<void> {
  const attempts = new Map<string, number>();
  return async (key, fault) => {
    if (!fault) return;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (fault.delayMs !== undefined && fault.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    if (fault.permanent) {
      throw new PermanentError(`Injected permanent failure for ${key}`, {
        code: "INJECTED_FAULT",
      });
    }
    if (fault.failTimes !== undefined && attempt <= fault.failTimes) {
      throw new RetryableError(`Injected transient failure #${attempt} for ${key}`, {
        code: "INJECTED_FAULT",
      });
    }
  };
}

interface Reservation extends ReservationOutput {
  released: boolean;
}

export interface ReserveRequest {
  idempotencyKey: string;
  orderId: string;
  items: OrderItem[];
  faults?: FaultSpec;
}

export interface ReleaseRequest {
  idempotencyKey: string;
  reservationId: string;
  faults?: FaultSpec;
}

/**
 * In-memory stand-in for a warehouse service. Effects are keyed by
 * idempotency key, so a retried call returns the original result instead of
 * reserving stock twice.
 */
export class InMemoryInventoryService {
  private readonly stock = new Map<string, number>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly releases = new Set<string>();
  private readonly gate = createFaultGate();
  private sequence = 0;

  constructor(initialStock: Record<string, number> = { "sku-1": 100, "sku-2": 100 }) {
    for (const [sku, quantity] of Object.entries(initialStock)) this.stock.set(sku, quantity);
  }

  async reserve(request: ReserveRequest): Promise<ReservationOutput> {
    const existing = this.reservations.get(request.idempotencyKey);
    if (existing) return { reservationId: existing.reservationId, items: existing.items };

    await this.gate(request.idempotencyKey, request.faults);

    for (const item of request.items) {
      const available = this.stock.get(item.sku) ?? 0;
      if (available < item.quantity) {
        throw new PermanentError(
          `Insufficient stock for ${item.sku}: requested ${item.quantity}, available ${available}`,
          { code: "INSUFFICIENT_STOCK" },
        );
      }
    }
    for (const item of request.items) {
      this.stock.set(item.sku, (this.stock.get(item.sku) ?? 0) - item.quantity);
    }

    this.sequence += 1;
    const reservation: Reservation = {
      reservationId: `res_${this.sequence}`,
      items: request.items,
      released: false,
    };
    this.reservations.set(request.idempotencyKey, reservation);
    return { reservationId: reservation.reservationId, items: reservation.items };
  }

  async release(request: ReleaseRequest): Promise<void> {
    if (this.releases.has(request.idempotencyKey)) return;
    await this.gate(request.idempotencyKey, request.faults);

    const reservation = [...this.reservations.values()].find(
      (candidate) => candidate.reservationId === request.reservationId,
    );
    if (!reservation) {
      throw new PermanentError(`Unknown reservation ${request.reservationId}`, {
        code: "UNKNOWN_RESERVATION",
      });
    }
    if (!reservation.released) {
      for (const item of reservation.items) {
        this.stock.set(item.sku, (this.stock.get(item.sku) ?? 0) + item.quantity);
      }
      reservation.released = true;
    }
    this.releases.add(request.idempotencyKey);
  }

  available(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }

  get reservationCount(): number {
    return this.reservations.size;
  }

  get releaseCount(): number {
    return this.releases.size;
  }
}

export interface ChargeRequest {
  idempotencyKey: string;
  orderId: string;
  amount: number;
  faults?: FaultSpec;
}

export interface RefundRequest {
  idempotencyKey: string;
  paymentId: string;
  amount: number;
  faults?: FaultSpec;
}

/** In-memory stand-in for a payment gateway with idempotent charges/refunds. */
export class InMemoryPaymentService {
  private readonly charges = new Map<string, PaymentOutput & { orderId: string }>();
  private readonly refunds = new Map<string, { paymentId: string; amount: number }>();
  private readonly gate = createFaultGate();
  private sequence = 0;

  async charge(request: ChargeRequest): Promise<PaymentOutput> {
    const existing = this.charges.get(request.idempotencyKey);
    if (existing) return { paymentId: existing.paymentId, amount: existing.amount };

    await this.gate(request.idempotencyKey, request.faults);

    if (!Number.isFinite(request.amount) || request.amount <= 0) {
      throw new PermanentError(`Invalid payment amount: ${request.amount}`, {
        code: "INVALID_AMOUNT",
      });
    }

    this.sequence += 1;
    const charge = {
      paymentId: `pay_${this.sequence}`,
      amount: request.amount,
      orderId: request.orderId,
    };
    this.charges.set(request.idempotencyKey, charge);
    return { paymentId: charge.paymentId, amount: charge.amount };
  }

  async refund(request: RefundRequest): Promise<void> {
    if (this.refunds.has(request.idempotencyKey)) return;
    await this.gate(request.idempotencyKey, request.faults);

    const paymentExists = [...this.charges.values()].some(
      (charge) => charge.paymentId === request.paymentId,
    );
    if (!paymentExists) {
      throw new PermanentError(`Unknown payment ${request.paymentId}`, {
        code: "UNKNOWN_PAYMENT",
      });
    }
    this.refunds.set(request.idempotencyKey, {
      paymentId: request.paymentId,
      amount: request.amount,
    });
  }

  get chargeCount(): number {
    return this.charges.size;
  }

  get refundCount(): number {
    return this.refunds.size;
  }

  totalCharged(): number {
    let total = 0;
    for (const charge of this.charges.values()) total += charge.amount;
    return total;
  }
}

export interface ArrangeShipmentRequest {
  idempotencyKey: string;
  orderId: string;
  faults?: FaultSpec;
}

export interface CancelShipmentRequest {
  idempotencyKey: string;
  shipmentId: string;
  faults?: FaultSpec;
}

/** In-memory stand-in for a logistics provider. */
export class InMemoryShippingService {
  private readonly shipments = new Map<string, ShipmentOutput & { orderId: string }>();
  private readonly cancellations = new Set<string>();
  private readonly gate = createFaultGate();
  private sequence = 0;

  async arrange(request: ArrangeShipmentRequest): Promise<ShipmentOutput> {
    const existing = this.shipments.get(request.idempotencyKey);
    if (existing) {
      return { shipmentId: existing.shipmentId, trackingNumber: existing.trackingNumber };
    }

    await this.gate(request.idempotencyKey, request.faults);

    this.sequence += 1;
    const shipment = {
      shipmentId: `shp_${this.sequence}`,
      trackingNumber: `TRK-${String(this.sequence).padStart(6, "0")}`,
      orderId: request.orderId,
    };
    this.shipments.set(request.idempotencyKey, shipment);
    return { shipmentId: shipment.shipmentId, trackingNumber: shipment.trackingNumber };
  }

  async cancel(request: CancelShipmentRequest): Promise<void> {
    if (this.cancellations.has(request.idempotencyKey)) return;
    await this.gate(request.idempotencyKey, request.faults);

    const shipmentExists = [...this.shipments.values()].some(
      (shipment) => shipment.shipmentId === request.shipmentId,
    );
    if (!shipmentExists) {
      throw new PermanentError(`Unknown shipment ${request.shipmentId}`, {
        code: "UNKNOWN_SHIPMENT",
      });
    }
    this.cancellations.add(request.idempotencyKey);
  }

  get shipmentCount(): number {
    return this.shipments.size;
  }

  get cancellationCount(): number {
    return this.cancellations.size;
  }
}

export interface OrderServices {
  inventory: InMemoryInventoryService;
  payment: InMemoryPaymentService;
  shipping: InMemoryShippingService;
}

export function createOrderServices(): OrderServices {
  return {
    inventory: new InMemoryInventoryService(),
    payment: new InMemoryPaymentService(),
    shipping: new InMemoryShippingService(),
  };
}
