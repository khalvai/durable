import { WorkflowRegistry } from "../engine/registry.js";
import { createOrderServices, type OrderServices } from "./order/services.js";
import { createOrderWorkflow } from "./order/workflow.js";

export interface DemoSetup {
  registry: WorkflowRegistry;
  services: OrderServices;
}

/** Registers every workflow shipped with the demo application. */
export function createDemoSetup(): DemoSetup {
  const services = createOrderServices();
  const registry = new WorkflowRegistry();
  registry.register(createOrderWorkflow(services));
  return { registry, services };
}

export { createOrderServices, type OrderServices } from "./order/services.js";
export { createOrderWorkflow, ORDER_WORKFLOW_NAME, ORDER_WORKFLOW_VERSION } from "./order/workflow.js";
export type {
  OrderFaults,
  OrderInput,
  OrderItem,
  PaymentOutput,
  ReservationOutput,
  ShipmentOutput,
} from "./order/types.js";
