import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { validateStateTransition } from "@/lib/state-machine";
import { StatusTransitionPayload } from "@/lib/types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const resolvedParams = await params;
    const orderId = resolvedParams.id;
    const body: StatusTransitionPayload = await req.json();
    const { nextStatus, actorRole = "ADMIN", actorId, reason } = body;

    if (!nextStatus) {
      return NextResponse.json(
        { success: false, error: "Field 'nextStatus' is required in payload." },
        { status: 400 }
      );
    }

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: { shipment: true },
    });

    if (!order) {
      return NextResponse.json(
        { success: false, error: `Order with ID '${orderId}' does not exist.` },
        { status: 404 }
      );
    }

    const validation = validateStateTransition(order.status, nextStatus);

    if (!validation.allowed) {
      await createAuditLog({
        entityType: "SECURITY",
        entityId: order.id,
        action: "ILLEGAL_STATE_TRANSITION_REJECTED",
        previousState: { status: order.status },
        newState: { attemptedStatus: nextStatus },
        actorRole: (actorRole as "ADMIN" | "WAREHOUSE" | "CUSTOMER" | "SYSTEM") || "SYSTEM",
        actorId: actorId || null,
        metadata: {
          errorMessage: validation.errorMessage,
          allowedNextStatuses: validation.allowedNextStatuses,
          attemptedBy: actorRole,
        },
      });

      return NextResponse.json(
        {
          success: false,
          error: validation.errorMessage,
          details: {
            currentStatus: validation.currentStatus,
            attemptedStatus: validation.attemptedStatus,
            allowedNextStatuses: validation.allowedNextStatuses,
          },
        },
        { status: 400 }
      );
    }

    const updatedOrder = await db.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: nextStatus.toUpperCase() },
      });

      if (nextStatus.toUpperCase() === "DISPATCHED") {
        if (!order.shipment) {
          await tx.shipment.create({
            data: {
              orderId: order.id,
              trackingNumber: `TRK-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
              carrier: "EXPRESS_LOGISTICS",
              status: "IN_TRANSIT",
            },
          });
        } else {
          await tx.shipment.update({
            where: { orderId: order.id },
            data: { status: "IN_TRANSIT" },
          });
        }
      } else if (nextStatus.toUpperCase() === "DELIVERED") {
        if (order.shipment) {
          await tx.shipment.update({
            where: { orderId: order.id },
            data: { status: "DELIVERED" },
          });
        }
      }

      await createAuditLog(
        {
          entityType: "ORDER",
          entityId: order.id,
          action: "ORDER_STATUS_TRANSITIONED",
          previousState: { status: order.status },
          newState: { status: nextStatus.toUpperCase() },
          actorRole: (actorRole as "ADMIN" | "WAREHOUSE" | "CUSTOMER" | "SYSTEM") || "SYSTEM",
          actorId: actorId || null,
          metadata: {
            reason: reason || "Manual state-machine operation",
            transition: `${order.status} -> ${nextStatus.toUpperCase()}`,
          },
        },
        tx
      );

      return updated;
    });

    return NextResponse.json({
      success: true,
      message: `Order transitioned from ${order.status} to ${nextStatus.toUpperCase()} successfully.`,
      data: updatedOrder,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Error executing status transition";
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
