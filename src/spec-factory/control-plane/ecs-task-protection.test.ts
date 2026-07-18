import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSpecFactoryEcsTaskProtection,
  SpecFactoryEcsTaskProtection,
} from "./ecs-task-protection.js";

describe("SpecFactoryEcsTaskProtection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op when disabled", async () => {
    const fetchImpl = vi.fn();
    const protection = new SpecFactoryEcsTaskProtection({
      enabled: false,
      fetchImpl,
    });

    await expect(protection.run(async () => "done")).resolves.toBe("done");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(protection.snapshot()).toMatchObject({
      enabled: false,
      activeScopes: 0,
      protected: false,
    });
  });

  it("fails startup when enabled outside an ECS task", () => {
    expect(() =>
      createSpecFactoryEcsTaskProtection({
        SPEC_FACTORY_ECS_TASK_PROTECTION_ENABLED: "true",
      }),
    ).toThrow("requires ECS_AGENT_URI");
  });

  it("protects before work and releases after success", async () => {
    const states: boolean[] = [];
    const fetchImpl = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          ProtectionEnabled: boolean;
        };
        states.push(body.ProtectionEnabled);
        return taskProtectionResponse(body.ProtectionEnabled);
      },
    );
    const protection = enabledProtection(fetchImpl);

    await expect(
      protection.run(async () => {
        expect(states).toEqual([true]);
        expect(protection.snapshot()).toMatchObject({
          activeScopes: 1,
          protected: true,
        });
        return 42;
      }),
    ).resolves.toBe(42);

    expect(states).toEqual([true, false]);
    expect(protection.snapshot()).toMatchObject({
      activeScopes: 0,
      protected: false,
      lastError: null,
    });
  });

  it("releases protection without masking the work error", async () => {
    const fetchImpl = successfulFetch();
    const protection = enabledProtection(fetchImpl);
    const expected = new Error("work failed");

    await expect(
      protection.run(async () => {
        throw expected;
      }),
    ).rejects.toBe(expected);

    expect(protection.snapshot()).toMatchObject({
      activeScopes: 0,
      protected: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reference-counts concurrent work on the same ECS task", async () => {
    const fetchImpl = successfulFetch();
    const protection = enabledProtection(fetchImpl);
    const firstStarted = deferred<void>();
    const finishFirst = deferred<void>();

    const first = protection.run(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
    });
    await firstStarted.promise;

    await protection.run(async () => {
      expect(protection.snapshot()).toMatchObject({
        activeScopes: 2,
        protected: true,
      });
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(protection.snapshot().activeScopes).toBe(1);
    finishFirst.resolve();
    await first;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(protection.snapshot()).toMatchObject({
      activeScopes: 0,
      protected: false,
    });
  });

  it("continues durable work when protection cannot be acquired", async () => {
    const work = vi.fn(async () => "done");
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const protection = new SpecFactoryEcsTaskProtection({
      enabled: true,
      agentUri: "http://169.254.170.2/v4/task-id",
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => "agent unavailable",
      })),
      logger,
    });

    await expect(protection.run(work)).resolves.toBe("done");
    expect(work).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(protection.snapshot()).toMatchObject({
      activeScopes: 0,
      protected: false,
      lastError: "ecs_task_protection_http_503:agent unavailable",
    });
  });

  it("does not mask completed work when release fails", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(taskProtectionResponse(true))
      .mockRejectedValueOnce(new Error("agent unavailable"));
    const protection = new SpecFactoryEcsTaskProtection({
      enabled: true,
      agentUri: "http://169.254.170.2/v4/task-id",
      fetchImpl,
      logger,
    });

    await expect(protection.run(async () => "complete")).resolves.toBe(
      "complete",
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(protection.snapshot()).toMatchObject({
      activeScopes: 0,
      protected: true,
      lastError: "agent unavailable",
    });
  });

  it("renews protection while work remains active", async () => {
    vi.useFakeTimers();
    const fetchImpl = successfulFetch();
    const protection = new SpecFactoryEcsTaskProtection({
      enabled: true,
      agentUri: "http://169.254.170.2/v4/task-id",
      expiresInMinutes: 1,
      refreshMs: 10_000,
      fetchImpl,
    });
    const started = deferred<void>();
    const finish = deferred<void>();
    const run = protection.run(async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(protection.snapshot().protected).toBe(true);

    finish.resolve();
    await run;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(protection.snapshot().protected).toBe(false);
  });
});

function enabledProtection(
  fetchImpl: ConstructorParameters<
    typeof SpecFactoryEcsTaskProtection
  >[0]["fetchImpl"],
): SpecFactoryEcsTaskProtection {
  return new SpecFactoryEcsTaskProtection({
    enabled: true,
    agentUri: "http://169.254.170.2/v4/task-id",
    fetchImpl,
  });
}

function successfulFetch() {
  return vi.fn(async (_input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      ProtectionEnabled: boolean;
    };
    return taskProtectionResponse(body.ProtectionEnabled);
  });
}

function taskProtectionResponse(protectionEnabled: boolean) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        protection: {
          ProtectionEnabled: protectionEnabled,
          ExpirationDate: protectionEnabled ? "2026-07-13T18:00:00.000Z" : null,
          TaskArn: "arn:aws:ecs:us-east-2:123456789012:task/test",
        },
      }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
