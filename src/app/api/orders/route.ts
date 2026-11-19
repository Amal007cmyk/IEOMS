import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { CreateOrderPayload } from "@/lib/types";

export async function GET() {
  try {
    const orders = await db.order.findMany({
      include: {
        items: { include: { product: true } },
        payments: true,
        shipment: true,
        user: { select: { id: true, email: true, name: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ success: true, data: orders });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body: CreateOrderPayload = await req.json();
    const { idempotencyKey, userId, items } = body;

    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      return NextResponse.json(
        { success: false, error: "Idempotency-Key header or property is strictly required to place an order." },
        { status: 400 }
      );
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { success: false, error: "Order must contain at least one valid item." },
        { status: 400 }
      );
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      return NextResponse.json(
        { success: false, error: `User with id '${userId}' does not exist.` },
        { status: 404 }
      );
    }

    const existingOrder = await db.order.findUnique({
      where: { idempotencyKey },
      include: {
        items: { include: { product: true } },
        payments: true,
        shipment: true,
      },
    });

    if (existingOrder) {
      await createAuditLog({
        entityType: "ORDER",
        entityId: existingOrder.id,
        action: "IDEMPOTENCY_REPLAY_DETECTED",
        previousState: null,
        newState: { orderId: existingOrder.id, status: existingOrder.status },
        actorRole: (user.role as "ADMIN" | "WAREHOUSE" | "CUSTOMER") || "CUSTOMER",
        actorId: user.id,
        metadata: {
          idempotencyKey,
          message: "Duplicate order submission prevented. Replaying original order snapshot.",
        },
      });

      return NextResponse.json(
        {
          success: true,
          idempotentReplay: true,
          message: "Order with this idempotency key already exists. Returning existing record.",
          data: existingOrder,
        },
        { status: 200 }
      );
    }

    const result = await db.$transaction(
      async (tx) => {
        let calculatedTotal = 0;
        const lineItemsToCreate: Array<{
          productId: string;
          quantity: number;
          unitPrice: number;
        }> = [];

        for (const item of items) {
          if (item.quantity <= 0) {
            throw new Error(`Quantity for product ${item.productId} must be greater than zero.`);
          }

          const product = await tx.product.findUnique({
            where: { id: item.productId },
            include: { inventory: true },
          });

          if (!product || !product.inventory) {
            throw new Error(`Product or Inventory not found for ID: ${item.productId}`);
          }

          if (product.inventory.availableQty < item.quantity) {
            throw new Error(
              `INSUFFICIENT_STOCK: Item '${product.title}' (SKU: ${product.sku}) has only ${product.inventory.availableQty} units available, but ${item.quantity} were requested.`
            );
          }

          const updatedInventory = await tx.inventory.update({
            where: { productId: item.productId },
            data: {
              availableQty: { decrement: item.quantity },
              reservedQty: { increment: item.quantity },
              version: { increment: 1 },
            },
          });

          await createAuditLog(
            {
              entityType: "INVENTORY",
              entityId: updatedInventory.id,
              action: "STOCK_RESERVED",
              previousState: {
                availableQty: product.inventory.availableQty,
                reservedQty: product.inventory.reservedQty,
              },
              newState: {
                availableQty: updatedInventory.availableQty,
                reservedQty: updatedInventory.reservedQty,
              },
              actorRole: (user.role as "ADMIN" | "WAREHOUSE" | "CUSTOMER") || "CUSTOMER",
              actorId: user.id,
              metadata: {
                productId: product.id,
                sku: product.sku,
                reservedDelta: item.quantity,
              },
            },
            tx
          );

          calculatedTotal += product.price * item.quantity;
          lineItemsToCreate.push({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: product.price,
          });
        }

        const generatedOrderNumber = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

        const newOrder = await tx.order.create({
          data: {
            orderNumber: generatedOrderNumber,
            userId: user.id,
            status: "PENDING",
            idempotencyKey,
            totalAmount: Number(calculatedTotal.toFixed(2)),
            items: { create: lineItemsToCreate },
          },
          include: {
            items: { include: { product: true } },
          },
        });

        const paymentIntentId = `pi_${randomUUID().replace(/-/g, "")}`;
        const newPayment = await tx.payment.create({
          data: {
            orderId: newOrder.id,
            paymentIntentId,
            amount: newOrder.totalAmount,
            status: "PENDING",
            provider: "MOCK_GATEWAY",
          },
        });

        await createAuditLog(
          {
            entityType: "ORDER",
            entityId: newOrder.id,
            action: "ORDER_CREATED",
            previousState: null,
            newState: {
              orderNumber: newOrder.orderNumber,
              totalAmount: newOrder.totalAmount,
              status: newOrder.status,
              itemCount: newOrder.items.length,
            },
            actorRole: (user.role as "ADMIN" | "WAREHOUSE" | "CUSTOMER") || "CUSTOMER",
            actorId: user.id,
            metadata: {
              idempotencyKey,
              paymentIntentId: newPayment.paymentIntentId,
            },
          },
          tx
        );

        return { order: newOrder, payment: newPayment };
      },
      { timeout: 10000 }
    );

    return NextResponse.json(
      {
        success: true,
        idempotentReplay: false,
        message: "Order placed successfully. Stock reserved pending payment.",
        data: {
          ...result.order,
          payment: result.payment,
        },
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error during order creation";

    if (errorMessage.includes("INSUFFICIENT_STOCK")) {
      return NextResponse.json(
        { success: false, error: errorMessage, code: "INSUFFICIENT_STOCK" },
        { status: 409 }
      );
    }

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
