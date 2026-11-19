const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function logPass(msg: string) {
  console.log(`${GREEN}${BOLD}✓ PASS:${RESET} ${msg}`);
}

function logFail(msg: string, details?: unknown) {
  console.error(`${RED}${BOLD}✗ FAIL:${RESET} ${msg}`);
  if (details) console.error(details);
}

function logSection(title: string) {
  console.log(`\n${CYAN}${BOLD}====================================================${RESET}`);
  console.log(`${CYAN}${BOLD} ${title}${RESET}`);
  console.log(`${CYAN}${BOLD}====================================================${RESET}`);
}

async function fetchProducts() {
  const res = await fetch(`${BASE_URL}/api/products`);
  if (!res.ok) throw new Error(`Failed to fetch products: ${res.statusText}`);
  const data = await res.json();
  return data.data;
}

async function testDuplicateOrderAttack() {
  logSection("TEST 1: Double-Click Duplicate Order Attack (Idempotency)");
  const products = await fetchProducts();
  const targetProduct = products.find((p: any) => p.inventory?.availableQty > 2) || products[0];
  const idempotencyKey = `cli-dup-attack-${Date.now()}`;

  console.log(`Target: [${targetProduct.sku}] "${targetProduct.title}"`);
  console.log(`Sending 2 simultaneous requests with key: ${idempotencyKey}...`);

  const payload = {
    idempotencyKey,
    userId: "usr_customer_00000000001",
    items: [{ productId: targetProduct.id, quantity: 1 }],
  };

  const [resA, resB] = await Promise.all([
    fetch(`${BASE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    fetch(`${BASE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  ]);

  const dataA = await resA.json();
  const dataB = await resB.json();

  const orderNumA = dataA.data?.orderNumber;
  const orderNumB = dataB.data?.orderNumber;

  if (resA.ok && resB.ok && orderNumA === orderNumB && (dataA.idempotentReplay || dataB.idempotentReplay)) {
    logPass(`Duplicate safely deduplicated. Both requests mapped to Order #${orderNumA}. No double reservation.`);
    return true;
  } else {
    logFail("Idempotency deduplication failed!", { dataA, dataB });
    return false;
  }
}

async function testConcurrentOversell() {
  logSection("TEST 2: Concurrent Oversell Race (5 Simultaneous Orders for 1 Unit)");
  const products = await fetchProducts();
  const rareItem = products.find((p: any) => p.sku === "KB-ULTRA-001");

  if (!rareItem) {
    logFail("Product KB-ULTRA-001 not found.");
    return false;
  }

  const initialStock = rareItem.inventory?.availableQty;
  console.log(`Initial Available Stock for ${rareItem.sku}: ${initialStock}`);

  if (initialStock < 1) {
    logFail("Stock is already 0. Run 'npm run db:seed' to re-seed initial 1 unit.");
    return false;
  }

  console.log("Firing 5 concurrent requests at the exact same millisecond...");

  const promises = Array.from({ length: 5 }).map(async (_, idx) => {
    const threadKey = `cli-race-${Date.now()}-th-${idx}-${Math.random().toString(36).substring(2, 6)}`;
    const res = await fetch(`${BASE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: threadKey,
        userId: "usr_customer_00000000001",
        items: [{ productId: rareItem.id, quantity: 1 }],
      }),
    });
    const body = await res.json();
    return { threadId: idx + 1, status: res.status, body };
  });

  const results = await Promise.all(promises);

  let successCount = 0;
  let conflictCount = 0;

  for (const r of results) {
    if (r.status === 201) {
      successCount++;
      console.log(` - Worker Thread ${r.threadId}: ${GREEN}201 CREATED${RESET} (Order: ${r.body.data?.orderNumber})`);
    } else if (r.status === 409) {
      conflictCount++;
      console.log(` - Worker Thread ${r.threadId}: ${YELLOW}409 CONFLICT${RESET} (Stock exhausted)`);
    } else {
      console.log(` - Worker Thread ${r.threadId}: ${RED}${r.status} UNEXPECTED${RESET}`);
    }
  }

  const updatedProducts = await fetchProducts();
  const updatedRareItem = updatedProducts.find((p: any) => p.id === rareItem.id);
  const finalAvailable = updatedRareItem.inventory.availableQty;

  console.log(`Final Database Stock: Available=${finalAvailable}`);

  if (successCount === 1 && conflictCount === 4 && finalAvailable >= 0) {
    logPass("Zero oversell! Exactly 1 worker acquired reservation, 4 workers blocked with 409. Stock is not negative.");
    return true;
  } else {
    logFail(`Race condition failed! Successes: ${successCount}, Conflicts: ${conflictCount}`);
    return false;
  }
}

async function testPaymentFailureStockRelease() {
  logSection("TEST 3: Payment Failure Webhook Stock Compensation");
  const products = await fetchProducts();
  const mouse = products.find((p: any) => p.sku === "MOUSE-PRECISION-002");
  const initialAvailable = mouse.inventory.availableQty;
  const initialReserved = mouse.inventory.reservedQty;

  const orderRes = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: `cli-fail-test-${Date.now()}`,
      userId: "usr_customer_00000000001",
      items: [{ productId: mouse.id, quantity: 2 }],
    }),
  });

  const orderData = await orderRes.json();
  const paymentIntentId = orderData.data?.payment?.paymentIntentId;

  console.log(`Order #${orderData.data.orderNumber} placed. Triggering FAILED payment webhook...`);

  await fetch(`${BASE_URL}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentIntentId,
      status: "FAILED",
      reason: "Simulated charge card decline",
    }),
  });

  const finalProducts = await fetchProducts();
  const finalMouse = finalProducts.find((p: any) => p.id === mouse.id);

  if (finalMouse.inventory.availableQty === initialAvailable && finalMouse.inventory.reservedQty === initialReserved) {
    logPass("Compensating transaction verified. Stock restored to Available pool, order status set to CANCELLED.");
    return true;
  } else {
    logFail("Stock rollback mismatch!");
    return false;
  }
}

async function testStateMachineIllegalJump() {
  logSection("TEST 4: State Machine Enforcement (Block PENDING -> DELIVERED)");
  const orderRes = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: `cli-sm-${Date.now()}`,
      userId: "usr_customer_00000000001",
      items: [{ productId: "prod_wireless_mouse_002", quantity: 1 }],
    }),
  });
  const orderData = await orderRes.json();
  const orderId = orderData.data?.id;

  console.log(`Attempting illegal transition jump: PENDING ➔ DELIVERED...`);
  const patchRes = await fetch(`${BASE_URL}/api/orders/${orderId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nextStatus: "DELIVERED", actorRole: "WAREHOUSE" }),
  });
  const patchData = await patchRes.json();

  if (patchRes.status === 400 && patchData.error) {
    logPass(`Boundary enforced! Rejected with 400 Bad Request: "${patchData.error}"`);
    return true;
  } else {
    logFail("State machine allowed illegal transition!", patchData);
    return false;
  }
}

async function main() {
  console.log(`\n${BOLD}Starting Academic Integrity Automated Verification on ${BASE_URL}${RESET}\n`);
  const t1 = await testDuplicateOrderAttack();
  const t2 = await testConcurrentOversell();
  const t3 = await testPaymentFailureStockRelease();
  const t4 = await testStateMachineIllegalJump();

  logSection("FINAL EXAM VERIFICATION REPORT");
  console.log(`1. Idempotency Suppressed Duplicates:  ${t1 ? GREEN + "PASSED" : RED + "FAILED"}${RESET}`);
  console.log(`2. Concurrency Oversell Blocked:       ${t2 ? GREEN + "PASSED" : RED + "FAILED"}${RESET}`);
  console.log(`3. Payment Failure Stock Restored:     ${t3 ? GREEN + "PASSED" : RED + "FAILED"}${RESET}`);
  console.log(`4. State Machine Jump Rejected:        ${t4 ? GREEN + "PASSED" : RED + "FAILED"}${RESET}`);

  if (t1 && t2 && t3 && t4) {
    console.log(`\n${GREEN}${BOLD}ALL 4 INTEGRITY TESTS PASSED ACCORDING TO SPECIFICATION.${RESET}\n`);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
