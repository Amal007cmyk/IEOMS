export type OrderState =
  | "PENDING"
  | "PAID"
  | "PACKED"
  | "DISPATCHED"
  | "DELIVERED"
  | "CANCELLED";

export type RoleType = "ADMIN" | "WAREHOUSE" | "CUSTOMER" | "SYSTEM";

export interface CreateOrderItemInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderPayload {
  idempotencyKey: string;
  userId: string;
  items: CreateOrderItemInput[];
}

export interface PaymentWebhookPayload {
  paymentIntentId: string;
  status: "SUCCESS" | "FAILED";
  reason?: string;
  provider?: string;
}

export interface StatusTransitionPayload {
  nextStatus: OrderState;
  actorRole: RoleType;
  actorId?: string;
  reason?: string;
}
