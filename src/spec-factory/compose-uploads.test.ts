import { describe, expect, it, vi } from "vitest";
import {
  composeRawKey,
  safeUploadFilename,
  ComposeUploads,
} from "./compose-uploads.js";

describe("compose-uploads helpers", () => {
  it("safeUploadFilename strips path + unsafe chars", () => {
    expect(safeUploadFilename("../../etc/passwd")).toBe("passwd");
    expect(safeUploadFilename("My Spec (v2).pdf")).toBe("My_Spec__v2_.pdf");
    expect(safeUploadFilename("")).toBe("upload");
  });

  it("composeRawKey builds the per-session raw key", () => {
    expect(composeRawKey("compose/4/", 21, "spec.pdf")).toBe(
      "compose/4/raw/21-spec.pdf",
    );
  });

  it("createUploadUrl returns a presigned PUT url + key", async () => {
    const signer = vi.fn().mockResolvedValue("https://s3.example/put?sig=abc");
    const uploads = new ComposeUploads({
      bucket: "specter-results",
      presign: signer as never,
    });
    const target = await uploads.createUploadUrl({
      s3Prefix: "compose/4/",
      sourceId: 21,
      filename: "spec.pdf",
      mimeType: "application/pdf",
    });
    expect(target.uploadUrl).toContain("https://s3.example/put");
    expect(target.s3KeyRaw).toBe("compose/4/raw/21-spec.pdf");
    expect(target.sourceId).toBe(21);
    expect(target.expiresInSeconds).toBe(900);
  });

  it("deletePrefix lists and batch-deletes every object under the session prefix, paginating", async () => {
    const send = vi
      .fn()
      // First ListObjectsV2: a page that is truncated.
      .mockResolvedValueOnce({
        Contents: [
          { Key: "compose/4/raw/1-a.pdf" },
          { Key: "compose/4/raw/2-b.mp4" },
        ],
        IsTruncated: true,
        NextContinuationToken: "tok",
      })
      // DeleteObjects for page 1.
      .mockResolvedValueOnce({ Deleted: [{}, {}] })
      // Second ListObjectsV2: final page.
      .mockResolvedValueOnce({
        Contents: [{ Key: "compose/4/sources/3-c.md" }],
        IsTruncated: false,
      })
      // DeleteObjects for page 2.
      .mockResolvedValueOnce({ Deleted: [{}] });
    const uploads = new ComposeUploads({
      bucket: "specter-results",
      client: { send } as never,
    });

    const deleted = await uploads.deletePrefix("compose/4/");

    expect(deleted).toBe(3);
    // 2 list + 2 delete calls.
    expect(send).toHaveBeenCalledTimes(4);
    const listInput = send.mock.calls[0][0].input;
    expect(listInput.Bucket).toBe("specter-results");
    expect(listInput.Prefix).toBe("compose/4/");
    // Second list passes the continuation token.
    expect(send.mock.calls[2][0].input.ContinuationToken).toBe("tok");
    // Delete payload targets the listed keys.
    const deleteInput = send.mock.calls[1][0].input;
    expect(deleteInput.Bucket).toBe("specter-results");
    expect(deleteInput.Delete.Objects).toEqual([
      { Key: "compose/4/raw/1-a.pdf" },
      { Key: "compose/4/raw/2-b.mp4" },
    ]);
  });

  it("deletePrefix is a no-op for an empty prefix (deletes nothing)", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const uploads = new ComposeUploads({
      bucket: "specter-results",
      client: { send } as never,
    });

    const deleted = await uploads.deletePrefix("compose/9/");

    expect(deleted).toBe(0);
    // One list, no delete.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("deletePrefix refuses a blank prefix to avoid bucket-wide deletion", async () => {
    const send = vi.fn();
    const uploads = new ComposeUploads({
      bucket: "specter-results",
      client: { send } as never,
    });

    await expect(uploads.deletePrefix("  ")).rejects.toThrow(/prefix/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("deletes only explicit artifact URIs in the configured bucket", async () => {
    const send = vi.fn().mockResolvedValue({ Deleted: [{}, {}] });
    const uploads = new ComposeUploads({
      bucket: "specter-results",
      client: { send } as never,
    });

    await expect(
      uploads.deleteArtifactUris([
        "s3://specter-results/spec-factory/a.json",
        "s3://specter-results/spec-factory/b.json",
      ]),
    ).resolves.toBe(2);
    expect(send.mock.calls[0][0].input.Delete.Objects).toEqual([
      { Key: "spec-factory/a.json" },
      { Key: "spec-factory/b.json" },
    ]);
    await expect(
      uploads.deleteArtifactUris(["s3://different-bucket/leak.json"]),
    ).rejects.toThrow("unapproved bucket");
  });
});
