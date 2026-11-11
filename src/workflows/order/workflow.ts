import type { StepDefinition, WorkflowDefinition } from "../../domain/types.js";
import type { OrderServices } from "./services.js";
import type {
  OrderInput,
  PaymentOutput,
  ReservationOutput,
  ShipmentOutput,
} from "./types.js";

export const ORDER_WORKFLOW_NAME = "order-processing";
export const ORDER_WORKFLOW_VERSION = 1;

/**
 * The canonical example from the README:
 *
 *   1. Reserve inventory   -> compensate: release inventory
 *   2. Process payment     -> compensate: refund payment
 *   3. Arrange shipping    -> compensate: cancel shipment
 *
 * Steps are idempotent because every downstream call receives the engine's
 * stable per-step idempotency key. Compensation runs in reverse order when a
 * step fails permanently.
 */
export function createOrderWorkflow(services: OrderServices): WorkflowDefinition<OrderInput> {
  const steps: StepDefinition<OrderInput, unknown>[] = [
    {
      name: "reserve-inventory",
      async execute(ctx) {
        const reservation = await services.inventory.reserve({
          idempotencyKey: ctx.idempotencyKey,
          orderId: ctx.input.orderId,
          items: ctx.input.items,
          faults: ctx.input.faults?.["reserve-inventory"],
        });
        return { reservationId: reservation.reservationId, items: reservation.items };
      },
      async compensate(ctx, output) {
        const reservation = output as ReservationOutput;
        await services.inventory.release({
          idempotencyKey: ctx.idempotencyKey,
          reservationId: reservation.reservationId,
          faults: ctx.input.faults?.["reserve-inventory:compensate"],
        });
      },
    },
    {
      name: "process-payment",
      async execute(ctx) {
        const payment = await services.payment.charge({
          idempotencyKey: ctx.idempotencyKey,
          orderId: ctx.input.orderId,
          amount: ctx.input.amount,
          faults: ctx.input.faults?.["process-payment"],
        });
        return { paymentId: payment.paymentId, amount: payment.amount };
      },
      async compensate(ctx, output) {
        const payment = output as PaymentOutput;
        await services.payment.refund({
          idempotencyKey: ctx.idempotencyKey,
          paymentId: payment.paymentId,
          amount: payment.amount,
          faults: ctx.input.faults?.["process-payment:compensate"],
        });
      },
    },
    {
      name: "arrange-shipping",
      async execute(ctx) {
        const shipment = await services.shipping.arrange({
          idempotencyKey: ctx.idempotencyKey,
          orderId: ctx.input.orderId,
          faults: ctx.input.faults?.["arrange-shipping"],
        });
        return {
          shipmentId: shipment.shipmentId,
          trackingNumber: shipment.trackingNumber,
        } satisfies ShipmentOutput;
      },
      async compensate(ctx, output) {
        const shipment = output as ShipmentOutput;
        await services.shipping.cancel({
          idempotencyKey: ctx.idempotencyKey,
          shipmentId: shipment.shipmentId,
          faults: ctx.input.faults?.["arrange-shipping:compensate"],
        });
      },
    },
  ];

  return {
    name: ORDER_WORKFLOW_NAME,
    version: ORDER_WORKFLOW_VERSION,
    defaultRetry: {
      maxAttempts: 4,
      initialDelayMs: 100,
      maxDelayMs: 2_000,
      backoffFactor: 2,
    },
    steps,
  };
}
