import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";

export async function GET() {
  try {
    const products = await db.product.findMany({
      include: {
        inventory: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({
      success: true,
      data: products,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch products";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, sku, description, price, initialStock, actorId, actorRole } = body;

    // 1. Validation
    if (!title || !sku || price === undefined || initialStock === undefined) {
      return NextResponse.json(
        {
          success: false,
          error: "Fields 'title', 'sku', 'price', and 'initialStock' are strictly required.",
        },
        { status: 400 }
      );
    }

    const parsedPrice = parseFloat(price);
    const parsedStock = parseInt(initialStock, 10);

    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      return NextResponse.json(
        { success: false, error: "Price must be a valid number greater than 0." },
        { status: 400 }
      );
    }

    if (isNaN(parsedStock) || parsedStock < 0) {
      return NextResponse.json(
        { success: false, error: "Initial stock must be a non-negative integer." },
        { status: 400 }
      );
    }

    const normalizedSku = sku.trim().toUpperCase();

    // 2. Check for duplicate SKU
    const existingSku = await db.product.findUnique({
      where: { sku: normalizedSku },
    });

    if (existingSku) {
      return NextResponse.json(
        { success: false, error: `Product with SKU '${normalizedSku}' already exists.` },
        { status: 409 }
      );
    }

    // Generate unique slug
    const baseSlug = title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const uniqueSlug = `${baseSlug}-${Date.now().toString(36)}`;

    // 3. Atomic Database Transaction: Create Product + Inventory + AuditLog
    const result = await db.$transaction(async (tx) => {
      const newProduct = await tx.product.create({
        data: {
          title: title.trim(),
          sku: normalizedSku,
          slug: uniqueSlug,
          description: description?.trim() || "No description provided.",
          price: Number(parsedPrice.toFixed(2)),
          inventory: {
            create: {
              availableQty: parsedStock,
              reservedQty: 0,
              version: 0,
            },
          },
        },
        include: {
          inventory: true,
        },
      });

      // Write to immutable audit ledger
      await createAuditLog(
        {
          entityType: "INVENTORY",
          entityId: newProduct.id,
          action: "PRODUCT_CREATED",
          previousState: null,
          newState: {
            productId: newProduct.id,
            sku: newProduct.sku,
            title: newProduct.title,
            price: newProduct.price,
            initialAvailableQty: parsedStock,
            initialReservedQty: 0,
          },
          actorRole: (actorRole as "ADMIN" | "WAREHOUSE" | "CUSTOMER" | "SYSTEM") || "ADMIN",
          actorId: actorId || null,
          metadata: {
            sku: newProduct.sku,
            unitPrice: newProduct.price,
            initialStock: parsedStock,
            timestamp: new Date().toISOString(),
          },
        },
        tx
      );

      return newProduct;
    });

    return NextResponse.json(
      {
        success: true,
        message: `Product '${result.title}' (SKU: ${result.sku}) created with ${result.inventory?.availableQty} units.`,
        data: result,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error creating product";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}