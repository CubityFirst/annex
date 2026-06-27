import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleStripeWebhook } from "./stripe-webhook";

vi.mock("../stripe-client", () => ({
  getStripe: vi.fn(),
  getStripeWebhookCryptoProvider: vi.fn().mockReturnValue({}),
}));

import { getStripe } from "../stripe-client";

interface MockDB {
  prepare: ReturnType<typeof vi.fn>;
  _runResults: Array<{ meta: { changes: number } } | Error>;
  _bindCalls: unknown[][];
  _statements: string[];
}

// Returns a sequence-aware D1 mock. Each call to .run() returns the next
// object from `runResults` (default: { meta: { changes: 1 } }); an Error
// entry makes that .run() reject (simulates a transient D1 failure).
// `.first()` always resolves to `firstResult` - used by the idempotency
// dedup check (null/undefined = not yet processed, truthy = duplicate).
function makeDB(
  runResults: Array<{ meta: { changes: number } } | Error> = [],
  firstResult: unknown = null,
): MockDB {
  const _runResults = runResults;
  const _bindCalls: unknown[][] = [];
  const _statements: string[] = [];
  let runIndex = 0;

  const prepare = vi.fn((sql: string) => {
    _statements.push(sql);
    return {
      bind: (...args: unknown[]) => {
        _bindCalls.push(args);
        return {
          run: vi.fn().mockImplementation(() => {
            const result = _runResults[runIndex] ?? { meta: { changes: 1 } };
            runIndex += 1;
            if (result instanceof Error) return Promise.reject(result);
            return Promise.resolve(result);
          }),
          first: vi.fn().mockImplementation(() => Promise.resolve(firstResult)),
        };
      },
    };
  });

  return { prepare, _runResults, _bindCalls, _statements };
}

function makeEnv(db: MockDB) {
  return {
    DB: db,
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
  } as unknown as Parameters<typeof handleStripeWebhook>[1];
}

function makeRequest(body: string, sig = "valid-sig") {
  return new Request("http://localhost/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    body,
  });
}

function mockConstructEvent(event: unknown) {
  vi.mocked(getStripe).mockReturnValue({
    webhooks: {
      constructEventAsync: vi.fn().mockResolvedValue(event),
    },
  } as unknown as ReturnType<typeof getStripe>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleStripeWebhook - signature + idempotency", () => {
  it("returns 400 when stripe-signature header is missing", async () => {
    const db = makeDB();
    const req = new Request("http://localhost/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await handleStripeWebhook(req, makeEnv(db));
    expect(res.status).toBe(400);
  });

  it("returns 400 on bad signature", async () => {
    vi.mocked(getStripe).mockReturnValue({
      webhooks: {
        constructEventAsync: vi.fn().mockRejectedValue(new Error("bad sig")),
      },
    } as unknown as ReturnType<typeof getStripe>);

    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(400);
  });

  it("acknowledges duplicate events without processing", async () => {
    mockConstructEvent({ id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_1", metadata: {} } } });
    // dedup SELECT returns a row → already processed
    const db = makeDB([], { seen: 1 });
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);
    // Only the dedup lookup should have run - no handler, no marker write
    expect(db._statements.length).toBe(1);
    expect(db._statements[0]).toContain("SELECT 1 FROM webhook_events");
  });
});

describe("handleStripeWebhook - checkout.session.completed", () => {
  it("links customer + subscription IDs to the user", async () => {
    mockConstructEvent({
      id: "evt_2",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          client_reference_id: "user-1",
          customer: "cus_abc",
          subscription: "sub_xyz",
        },
      },
    });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);

    expect(db._statements[0]).toContain("SELECT 1 FROM webhook_events");
    expect(db._statements[1]).toContain("INSERT INTO user_billing");
    expect(db._statements[1]).toContain("stripe_customer_id");
    expect(db._statements[1]).toContain("stripe_subscription_id");
    // bind args for the user_billing upsert: userId, customerId, subId
    expect(db._bindCalls[1]).toEqual(["user-1", "cus_abc", "sub_xyz"]);
    // marker recorded only after the handler succeeded
    expect(db._statements[2]).toContain("INSERT OR IGNORE INTO webhook_events");
  });

  it("ignores events missing client_reference_id", async () => {
    mockConstructEvent({
      id: "evt_3",
      type: "checkout.session.completed",
      data: { object: { id: "cs_2", customer: "cus_abc", subscription: "sub_xyz" } },
    });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);
    // dedup lookup + post-success marker; no user_billing write (no-op)
    expect(db._statements.length).toBe(2);
    expect(db._statements[0]).toContain("SELECT 1 FROM webhook_events");
    expect(db._statements[1]).toContain("INSERT OR IGNORE INTO webhook_events");
  });
});

describe("handleStripeWebhook - customer.subscription.created/updated", () => {
  const event = {
    id: "evt_4",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        metadata: { userId: "user-1" },
        items: {
          data: [{ current_period_end: 1_700_000_000 }],
        },
      },
    },
  };

  it("upserts plan, status, period_end, started_at via COALESCE", async () => {
    mockConstructEvent(event);
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);

    expect(db._statements[1]).toContain("INSERT INTO user_billing");
    expect(db._statements[1]).toContain("personal_plan");
    expect(db._statements[1]).toContain("COALESCE(user_billing.personal_plan_started_at");

    const args = db._bindCalls[1];
    expect(args[0]).toBe("user-1"); // user id (now leads since it's the upsert key)
    expect(args[1]).toBe("cus_1"); // customerId
    expect(args[2]).toBe("sub_1"); // subscriptionId
    expect(args[3]).toBe("ink"); // plan
    expect(args[4]).toBe("active"); // status
    expect(args[5]).toBe(1_700_000_000_000); // period end (ms)
    expect(args[6]).toBeNull(); // cancel_at (null when no cancellation pending)
    // args[7] is now (Date.now()) - just check it's a number
    expect(typeof args[7]).toBe("number");
  });

  it("captures cancel_at when subscription is set to cancel at period end", () => {
    mockConstructEvent({
      ...event,
      data: {
        object: {
          ...event.data.object,
          cancel_at: 1_750_000_000,
          cancel_at_period_end: true,
        },
      },
    });
    const db = makeDB();
    return handleStripeWebhook(makeRequest("{}"), makeEnv(db)).then(() => {
      const args = db._bindCalls[1];
      expect(args[6]).toBe(1_750_000_000_000); // cancel_at in ms (now position 6 - userId leads)
    });
  });

  it("ignores subscription events missing metadata.userId", async () => {
    mockConstructEvent({
      ...event,
      data: { object: { ...event.data.object, metadata: {} } },
    });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);
    // dedup lookup + post-success marker; no user_billing write (no-op)
    expect(db._statements.length).toBe(2);
    expect(db._statements[0]).toContain("SELECT 1 FROM webhook_events");
    expect(db._statements[1]).toContain("INSERT OR IGNORE INTO webhook_events");
  });

  // Price-binding guard: when STRIPE_INK_PRICE_ID is configured, only a
  // subscription on that price may grant Ink.
  function makeEnvWithInkPrice(db: MockDB, priceId: string) {
    return { ...makeEnv(db), STRIPE_INK_PRICE_ID: priceId } as Parameters<typeof handleStripeWebhook>[1];
  }

  it("grants Ink when a subscription item matches the configured Ink price", async () => {
    mockConstructEvent({
      ...event,
      data: { object: { ...event.data.object, items: { data: [{ price: { id: "price_ink" }, current_period_end: 1_700_000_000 }] } } },
    });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnvWithInkPrice(db, "price_ink"));
    expect(res.status).toBe(200);
    expect(db._statements[1]).toContain("INSERT INTO user_billing");
    expect(db._bindCalls[1][3]).toBe("ink");
  });

  it("does NOT grant Ink for a subscription on a different price", async () => {
    mockConstructEvent({
      ...event,
      data: { object: { ...event.data.object, items: { data: [{ price: { id: "price_other_cheaper" }, current_period_end: 1_700_000_000 }] } } },
    });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnvWithInkPrice(db, "price_ink"));
    expect(res.status).toBe(200);
    // No user_billing write - only dedup lookup + post-success marker.
    expect(db._statements.length).toBe(2);
    expect(db._statements.some(s => s.includes("INSERT INTO user_billing"))).toBe(false);
  });
});

describe("handleStripeWebhook - customer.subscription.deleted", () => {
  it("clears plan + sub id, sets status canceled", async () => {
    mockConstructEvent({
      id: "evt_5",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", metadata: { userId: "user-1" } } },
    });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);

    expect(db._statements[1]).toContain("personal_plan = NULL");
    expect(db._statements[1]).toContain("'canceled'");
    expect(db._bindCalls[1]).toEqual(["user-1"]);
  });
});

describe("handleStripeWebhook - invoice events", () => {
  it("invoice.payment_failed flips status to past_due", async () => {
    mockConstructEvent({
      id: "evt_6",
      type: "invoice.payment_failed",
      data: { object: { id: "in_1", subscription: "sub_1", lines: { data: [] } } },
    });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);

    expect(db._statements[1]).toContain("'past_due'");
    expect(db._bindCalls[1]).toEqual(["sub_1"]);
  });

  it("invoice.paid sets status active and refreshes period_end", async () => {
    mockConstructEvent({
      id: "evt_7",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_2",
          subscription: "sub_1",
          lines: { data: [{ period: { end: 1_800_000_000 } }] },
        },
      },
    });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);

    expect(db._statements[1]).toContain("'active'");
    expect(db._bindCalls[1]).toEqual([1_800_000_000_000, "sub_1"]);
  });
});

describe("handleStripeWebhook - idempotency ordering on failure", () => {
  const deletedEvent = {
    id: "evt_fail",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_1", customer: "cus_1", metadata: { userId: "user-1" } } },
  };

  it("returns 500 and does NOT record the event when the handler throws", async () => {
    mockConstructEvent(deletedEvent);
    // The handler's UPDATE rejects (transient D1 failure).
    const db = makeDB([new Error("d1 unavailable")]);
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(500);
    // No idempotency marker written → Stripe's redelivery will reprocess.
    expect(db._statements.some(s => s.includes("INSERT OR IGNORE INTO webhook_events"))).toBe(false);
  });

  it("records the marker only after the handler succeeds", async () => {
    mockConstructEvent({ ...deletedEvent, id: "evt_ok" });
    const db = makeDB();
    const res = await handleStripeWebhook(makeRequest("{}"), makeEnv(db));
    expect(res.status).toBe(200);
    expect(db._statements[0]).toContain("SELECT 1 FROM webhook_events");
    // Last statement is the post-success idempotency marker.
    expect(db._statements[db._statements.length - 1]).toContain("INSERT OR IGNORE INTO webhook_events");
  });
});
