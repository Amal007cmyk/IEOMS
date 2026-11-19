import { OrderState } from "./types";

export const ALLOWED_STATE_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  PENDING: ["PAID", "CANCELLED"],
  PAID: ["PACKED", "CANCELLED"],
  PACKED: ["DISPATCHED", "CANCELLED"],
  DISPATCHED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
} as const;

export interface TransitionValidationResult {
  allowed: boolean;
  currentStatus: OrderState;
  attemptedStatus: OrderState;
  allowedNextStatuses: readonly OrderState[];
  errorMessage?: string;
}

export function validateStateTransition(
  currentStatus: string,
  targetStatus: string
): TransitionValidationResult {
  const current = currentStatus.toUpperCase() as OrderState;
  const target = targetStatus.toUpperCase() as OrderState;

  const validTargetStates = ALLOWED_STATE_TRANSITIONS[current];

  if (!validTargetStates) {
    return {
      allowed: false,
      currentStatus: current,
      attemptedStatus: target,
      allowedNextStatuses: [],
      errorMessage: `Unrecognized current order status: '${currentStatus}'.`,
    };
  }

  const isAllowed = validTargetStates.includes(target);

  if (!isAllowed) {
    return {
      allowed: false,
      currentStatus: current,
      attemptedStatus: target,
      allowedNextStatuses: validTargetStates,
      errorMessage: `Invalid state transition from '${current}' to '${target}'. Allowed transitions from '${current}': [${validTargetStates.join(", ") || "None (Terminal State)"}].`,
    };
  }

  return {
    allowed: true,
    currentStatus: current,
    attemptedStatus: target,
    allowedNextStatuses: validTargetStates,
  };
}
