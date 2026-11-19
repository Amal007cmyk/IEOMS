import { Prisma } from "@prisma/client";
import { db } from "./db";

export interface LogAuditParams {
  entityType: "ORDER" | "INVENTORY" | "PAYMENT" | "SHIPMENT" | "SECURITY" | "SYSTEM";
  entityId: string;
  action: string;
  previousState?: unknown;
  newState?: unknown;
  actorRole: "ADMIN" | "WAREHOUSE" | "CUSTOMER" | "SYSTEM";
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createAuditLog(
  params: LogAuditParams,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const client = tx || db;

  await client.auditLog.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      previousState: params.previousState !== undefined ? JSON.stringify(params.previousState) : null,
      newState: params.newState !== undefined ? JSON.stringify(params.newState) : null,
      actorRole: params.actorRole,
      actorId: params.actorId || null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    },
  });
}
