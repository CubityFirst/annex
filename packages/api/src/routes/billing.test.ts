import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleBillingCheckout, handleBillingPortal } from "./billing";

vi.mock("../account/stripe-client", () => ({
  getStripe: vi.fn(),
}));

import { getStripe } from "../account/stripe-client";

const mockSession = { userId: "user-1", email: "test@example.com", expiresAt: Date.now() + 3600_000 };

function makeEnv(userRow: Record<string, unknown> | null) {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(userRow),
        }),
      }),
    },
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_INK_PRICE_ID: "price_xxx",
    APP_ORIGIN: "https://docs.example.com",
  } as unknown as Parameters<typeof handleBillingCheckout>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleBillingCheckout", () => {
  it("returns 404 when user row missing", async () => {
    const res = await handleBillingCheckout(makeEnv(null), mockSession);
    expect(res.status).toBe(404);
  });

  it("creates checkout with customer_email when no stripe_customer_id", async () => {
    const create = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/abc" });
    vi.mocked(getStripe).mockReturnValue({
      checkout: { sessions: { create } },
    } as unknown as ReturnType<typeof getStripe>);

    const env = makeEnv({ email: "u@example.com", name: "U", stripe_customer_id: null });
    const res = await handleBillingCheckout(env, mockSession);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { url: string } }>();
    expect(body.data.url).toBe("https://checkout.stripe.com/abc");

    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0][0];
    expect(args.mode).toBe("subscription");
    expect(args.customer_email).toBe("u@example.com");
    expect(args.customer).toBeUndefined();
    expect(args.client_reference_id).toBe("user-1");
    expect(args.line_items).toEqual([{ price: "price_xxx", quantity: 1 }]);
  });

  it("reuses existing stripe_customer_id when present", async () => {
    const create = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/def" });
    vi.mocked(getStripe).mockReturnValue({
      checkout: { sessions: { create } },
    } as unknown as ReturnType<typeof getStripe>);

    const env = makeEnv({ email: "u@example.com", name: "U", stripe_customer_id: "cus_existing" });
    await handleBillingCheckout(env, mockSession);

    const args = create.mock.calls[0][0];
    expect(args.customer).toBe("cus_existing");
    expect(args.customer_email).toBeUndefined();
  });

  it("returns 500 when Stripe doesn't return a url", async () => {
    const create = vi.fn().mockResolvedValue({ url: null });
    vi.mocked(getStripe).mockReturnValue({
      checkout: { sessions: { create } },
    } as unknown as ReturnType<typeof getStripe>);

    const env = makeEnv({ email: "u@example.com", name: "U", stripe_customer_id: null });
    const res = await handleBillingCheckout(env, mockSession);
    expect(res.status).toBe(500);
  });
});

describe("handleBillingPortal", () => {
  it("returns 400 when user has no stripe_customer_id", async () => {
    const env = makeEnv({ stripe_customer_id: null });
    const res = await handleBillingPortal(env, mockSession);
    expect(res.status).toBe(400);
  });

  it("creates a portal session and returns the url", async () => {
    const create = vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/portal/xyz" });
    vi.mocked(getStripe).mockReturnValue({
      billingPortal: { sessions: { create } },
    } as unknown as ReturnType<typeof getStripe>);

    const env = makeEnv({ stripe_customer_id: "cus_1" });
    const res = await handleBillingPortal(env, mockSession);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { url: string } }>();
    expect(body.data.url).toBe("https://billing.stripe.com/portal/xyz");

    const args = create.mock.calls[0][0];
    expect(args.customer).toBe("cus_1");
    expect(args.return_url).toBe("https://docs.example.com/settings#billing");
  });
});
