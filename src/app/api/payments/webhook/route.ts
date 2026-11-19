import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { PaymentWebhookPayload } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const body: PaymentWebhookPayload = await req.json();
    const { paymentIntentId, status, reason, provider } = body;

    if (!paymentIntentId || !status) {
      return NextResponse.json(
        { success: false, error: "paymentIntentId and status ('SUCCESS' | 'FAILED') are required in payload." },
        { status: 400 }
      );
    }

    if (status !== "SUCCESS" && status !== "FAILED") {
      return NextResponse.json(
        { success: false, error: `Invalid status '${status}'. Must be either 'SUCCESS' or 'FAILED'.` },
        { status: 400 }
      );
    }

    const updateResult = await db.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { paymentIntentId },
        include: {
          order: { include: { items: true } },
        },
      });

      if (!payment) {
        throw new Error(`Payment with intent ID '${paymentIntentId}' not found.`);
      }

      if (payment.status === status) {
        return {
          idempotentReplay: true,
          payment,
          order: payment.order,
          message: `Payment '${paymentIntentId}' already settled with status '${status}'. No mutation required.`,
        };
      }

      if (payment.status !== "PENDING") {
        throw new Error(
          `Payment cannot be modified. Current status is already finalized as '${payment.status}'.`
        );
      }

      if (status === "SUCCESS") {
        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "SUCCESS",
            provider: provider || payment.provider,
            rawPayload: JSON.stringify(body),
          },
        });

        for (const item of payment.order.items) {
          const inventory = await tx.inventory.findUnique({
            where: { productId: item.productId },
          });

          if (inventory) {
            const updatedInventory = await tx.inventory.update({
              where: { productId: item.productId },
              data: {
                reservedQty: { decrement: item.quantity },
                version: { increment: 1 },
              },
            });

            await createAuditLog(
              {
                entityType: "INVENTORY",
                entityId: updatedInventory.id,
                action: "STOCK_COMMITTED_PAYMENT_SUCCESS",
                previousState: { availableQty: inventory.availableQty, reservedQty: inventory.reservedQty },
                newState: { availableQty: updatedInventory.availableQty, reservedQty: updatedInventory.reservedQty },
                actorRole: "SYSTEM",
                metadata: { orderId: payment.order.id, productId: item.productId, committedQty: item.quantity },
              },
              tx
            );
          }
        }

        const updatedOrder = await tx.order.update({
          where: { id: payment.order.id },
          data: { status: "PAID" },
        });

        await createAuditLog(
          {
            entityType: "PAYMENT",
            entityId: updatedPayment.id,
            action: "PAYMENT_SETTLED_SUCCESS",
            previousState: { status: payment.status },
            newState: { status: "SUCCESS" },
            actorRole: "SYSTEM",
            metadata: { orderId: updatedOrder.id, paymentIntentId },
          },
          tx
        );

        await createAuditLog(
          {
            entityType: "ORDER",
            entityId: updatedOrder.id,
            action: "ORDER_STATUS_UPDATED_TO_PAID",
            previousState: { status: payment.order.status },
            newState: { status: updatedOrder.status },
            actorRole: "SYSTEM",
            metadata: { paymentIntentId },
          },
          tx
        );

        return {
          idempotentReplay: false,
          payment: updatedPayment,
          order: updatedOrder,
          message: "Payment successfully confirmed. Stock committed to order.",
        };
      } else {
        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "FAILED",
            provider: provider || payment.provider,
            rawPayload: JSON.stringify(body),
          },
        });

        for (const item of payment.order.items) {
          const inventory = await tx.inventory.findUnique({
            where: { productId: item.productId },
          });

          if (inventory) {
            const updatedInventory = await tx.inventory.update({
              where: { productId: item.productId },
              data: {
                availableQty: { increment: item.quantity },
                reservedQty: { decrement: item.quantity },
                version: { increment: 1 },
              },
            });

            await createAuditLog(
              {
                entityType: "INVENTORY",
                entityId: updatedInventory.id,
                action: "STOCK_RELEASED_PAYMENT_FAILURE",
                previousState: { availableQty: inventory.availableQty, reservedQty: inventory.reservedQty },
                newState: { availableQty: updatedInventory.availableQty, reservedQty: updatedInventory.reservedQty },
                actorRole: "SYSTEM",
                metadata: {
                  orderId: payment.order.id,
                  productId: item.productId,
                  releasedQty: item.quantity,
                  failureReason: reason || "Webhook simulation of declined charge",
                },
              },
              tx
            );
          }
        }

        const updatedOrder = await tx.order.update({
          where: { id: payment.order.id },
          data: { status: "CANCELLED" },
        });

        await createAuditLog(
          {
            entityType: "PAYMENT",
            entityId: updatedPayment.id,
            action: "PAYMENT_SETTLED_FAILURE",
            previousState: { status: payment.status },
            newState: { status: "FAILED" },
            actorRole: "SYSTEM",
            metadata: { orderId: updatedOrder.id, paymentIntentId, reason: reason || "Payment rejected" },
          },
          tx
        );

        await createAuditLog(
          {
            entityType: "ORDER",
            entityId: updatedOrder.id,
            action: "ORDER_CANCELLED_PAYMENT_FAILURE",
            previousState: { status: payment.order.status },
            newState: { status: updatedOrder.status },
            actorRole: "SYSTEM",
            metadata: { paymentIntentId, reason: reason || "Payment failed, stock restored" },
          },
          tx
        );

        return {
          idempotentReplay: false,
          payment: updatedPayment,
          order: updatedOrder,
          message: "Payment failed. Reserved stock returned to available inventory.",
        };
      }
    });

    return NextResponse.json({ success: true, ...updateResult }, { status: 200 });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Error processing payment webhook";
    return NextResponse.json({ success: false, error: errorMessage }, { status: 400 });
  }
}
