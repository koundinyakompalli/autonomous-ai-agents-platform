import { describe, expect, it, vi } from "vitest";
import { ImmutableS3ArtifactStore } from "./immutable-s3-artifact-store.js";

describe("ImmutableS3ArtifactStore", () => {
  it("writes content-addressed immutable objects", async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = new ImmutableS3ArtifactStore(
      { send } as never,
      "artifact-bucket",
      "spec-factory",
    );

    const result = await store.write({
      workspacePath: "/workspaces/compose/7",
      relativePath: "context/working-context-v4.json",
      content: Buffer.from('{"version":4}\n'),
    });

    expect(result.artifactUri).toMatch(
      /^s3:\/\/artifact-bucket\/spec-factory\/workspaces\/[a-f0-9]{16}\/sha256\//,
    );
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: "artifact-bucket",
      IfNoneMatch: "*",
      ContentType: "application/json",
    });
  });

  it("verifies an existing object after an idempotent precondition failure", async () => {
    const precondition = Object.assign(new Error("exists"), {
      name: "PreconditionFailed",
    });
    const body = Buffer.from("same");
    const sha256 = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(body).digest("hex"),
    );
    const send = vi
      .fn()
      .mockRejectedValueOnce(precondition)
      .mockResolvedValueOnce({
        ContentLength: body.byteLength,
        Metadata: { sha256 },
      });
    const store = new ImmutableS3ArtifactStore(
      { send } as never,
      "artifact-bucket",
    );

    await expect(
      store.write({
        workspacePath: "/workspaces/compose/7",
        relativePath: "same.md",
        content: body,
      }),
    ).resolves.toMatchObject({ sha256 });
  });
});
