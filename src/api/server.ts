import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { RunStatus } from "../domain/types.js";
import { ConflictError, NotFoundError, ValidationError } from "../engine/errors.js";
import type { WorkflowService } from "../engine/workflow-service.js";

const RUN_STATUSES: [RunStatus, ...RunStatus[]] = [
  "pending",
  "running",
  "completed",
  "failed",
  "compensating",
  "compensated",
  "cancelled",
];

const createRunSchema = z.object({
  input: z.unknown().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const listRunsSchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  workflow: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(5_000).optional(),
});

const runParamsSchema = z.object({ id: z.string().min(1) });
const workflowParamsSchema = z.object({ name: z.string().min(1) });

export interface BuildAppOptions {
  service: WorkflowService;
  logger?: FastifyServerOptions["logger"];
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError("Invalid request", result.error.issues);
  }
  return result.data as z.infer<S>;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const { service } = options;

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: { type: "not_found", message: error.message } });
    }
    if (error instanceof ConflictError) {
      return reply.status(409).send({ error: { type: "conflict", message: error.message } });
    }
    if (error instanceof ValidationError) {
      return reply.status(400).send({
        error: { type: "validation_error", message: error.message, details: error.details },
      });
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.status(400).send({
        error: {
          type: "validation_error",
          message: error instanceof Error ? error.message : "Invalid request",
        },
      });
    }
    request.log.error({ err: error }, "Unhandled request error");
    return reply
      .status(500)
      .send({ error: { type: "internal_error", message: "Internal server error" } });
  });

  app.get("/health", async () => ({ status: "ok", now: Date.now() }));

  app.get("/api/workflows", async () => ({ workflows: service.listWorkflows() }));

  app.post<{ Params: { name: string }; Body: unknown }>(
    "/api/workflows/:name/runs",
    async (request, reply) => {
      const { name } = parse(workflowParamsSchema, request.params);
      const body = parse(createRunSchema, request.body ?? {});
      const result = service.createRun(name, body.input, body.idempotencyKey);
      return reply.status(result.created ? 202 : 200).send({
        created: result.created,
        run: result.run,
        steps: result.steps,
      });
    },
  );

  app.get<{ Querystring: unknown }>("/api/runs", async (request) => {
    const query = parse(listRunsSchema, request.query);
    const { runs, total } = service.listRuns({
      status: query.status,
      workflowName: query.workflow,
      limit: query.limit,
      offset: query.offset,
    });
    return { runs, total, limit: query.limit ?? 50, offset: query.offset ?? 0 };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => {
    const { id } = parse(runParamsSchema, request.params);
    return service.getRun(id);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/steps", async (request) => {
    const { id } = parse(runParamsSchema, request.params);
    return { steps: service.getRun(id).steps };
  });

  app.get<{ Params: { id: string }; Querystring: unknown }>(
    "/api/runs/:id/events",
    async (request) => {
      const { id } = parse(runParamsSchema, request.params);
      const query = parse(eventsQuerySchema, request.query);
      return { events: service.getEvents(id, query.after, query.limit) };
    },
  );

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
    const { id } = parse(runParamsSchema, request.params);
    return reply.status(202).send(service.cancelRun(id));
  });

  return app;
}
