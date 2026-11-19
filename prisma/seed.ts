import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("--- Starting database cleanup and seeding ---");

  await prisma.auditLog.deleteMany();
  await prisma.shipment.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.inventory.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();

  const adminUser = await prisma.user.create({
    data: {
      id: "usr_admin_000000000000001",
      email: "admin@ecommerce.local",
      name: "Security Admin",
      passwordHash: "$2b$10$wT8m96p94hXo1K2sTf8hNu9ZqvR6O1Q6p8vLz3N5wX6rXz5YQe0Wy",
      role: "ADMIN",
    },
  });

  const warehouseUser = await prisma.user.create({
    data: {
      id: "usr_warehouse_00000000001",
      email: "warehouse@ecommerce.local",
      name: "Warehouse Lead",
      passwordHash: "$2b$10$wT8m96p94hXo1K2sTf8hNu9ZqvR6O1Q6p8vLz3N5wX6rXz5YQe0Wy",
      role: "WAREHOUSE",
    },
  });

  const customerUser = await prisma.user.create({
    data: {
      id: "usr_customer_00000000001",
      email: "customer@ecommerce.local",
      name: "Verified Customer",
      passwordHash: "$2b$10$wT8m96p94hXo1K2sTf8hNu9ZqvR6O1Q6p8vLz3N5wX6rXz5YQe0Wy",
      role: "CUSTOMER",
    },
  });

  const productSingleUnit = await prisma.product.create({
    data: {
      id: "prod_mechanical_keyboard_001",
      sku: "KB-ULTRA-001",
      title: "Ultra-Rare Prototype Mechanical Keyboard",
      slug: "ultra-rare-prototype-mechanical-keyboard",
      description: "Handcrafted boutique keyboard. Only 1 unit exists in warehouse inventory. Ideal target for race condition tests.",
      price: 349.99,
      inventory: {
        create: {
          availableQty: 1,
          reservedQty: 0,
          version: 0,
        },
      },
    },
    include: { inventory: true },
  });

  const productMouse = await prisma.product.create({
    data: {
      id: "prod_wireless_mouse_002",
      sku: "MOUSE-PRECISION-002",
      title: "Precision Ergonomic Wireless Mouse",
      slug: "precision-ergonomic-wireless-mouse",
      description: "Low-latency wireless mouse with optical switches and high-capacity battery.",
      price: 89.99,
      inventory: {
        create: {
          availableQty: 50,
          reservedQty: 0,
          version: 0,
        },
      },
    },
    include: { inventory: true },
  });

  const productHeadphones = await prisma.product.create({
    data: {
      id: "prod_studio_headphones_003",
      sku: "HEADPHONES-STUDIO-003",
      title: "Studio Monitor Noise-Cancelling Headphones",
      slug: "studio-monitor-noise-cancelling-headphones",
      description: "Planar magnetic driver headphones tuned for reference audio listening.",
      price: 249.99,
      inventory: {
        create: {
          availableQty: 25,
          reservedQty: 0,
          version: 0,
        },
      },
    },
    include: { inventory: true },
  });

  console.log("Seeded Products:");
  console.log(` - [${productSingleUnit.sku}] ${productSingleUnit.title}: Available=${productSingleUnit.inventory?.availableQty}`);
  console.log(` - [${productMouse.sku}] ${productMouse.title}: Available=${productMouse.inventory?.availableQty}`);
  console.log(` - [${productHeadphones.sku}] ${productHeadphones.title}: Available=${productHeadphones.inventory?.availableQty}`);

  await prisma.auditLog.create({
    data: {
      entityType: "SYSTEM",
      entityId: "SYSTEM_INIT",
      action: "DATABASE_SEEDED",
      previousState: null,
      newState: JSON.stringify({
        usersCount: 3,
        productsCount: 3,
        singleUnitTargetSku: productSingleUnit.sku,
      }),
      actorRole: "ADMIN",
      actorId: adminUser.id,
      metadata: JSON.stringify({ environment: "development", initializedAt: new Date().toISOString() }),
    },
  });

  console.log("Immutable Audit Log initialized.");
  console.log("--- Seeding complete ---");
}

main()
  .catch((e) => {
    console.error("Seeding error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
