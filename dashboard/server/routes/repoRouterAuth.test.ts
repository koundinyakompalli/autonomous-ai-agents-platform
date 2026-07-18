import { describe, expect, it } from "vitest";
import { startRepoRouterAuth } from "./repoRouterAuth.js";

function createResponseRecorder() {
  const response = {
    statusCode: 200,
    location: "",
    redirect(code: number, location: string) {
      this.statusCode = code;
      this.location = location;
      return this;
    },
  };

  return response;
}

describe("repo router auth route", () => {
  it("redirects back to the requested relative path", () => {
    const response = createResponseRecorder();
    const returnTo =
      "/oneshot?view=waiting&run=qualifier-task-2429&repoConfirm=1&repoConfirmationId=18&repoId=1";

    startRepoRouterAuth(
      { query: { returnTo } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(302);
    expect(response.location).toBe(returnTo);
  });

  it.each([
    "https://evil.example/oneshot",
    "//evil.example/oneshot",
  ])("sanitizes unsafe return target %s", (returnTo) => {
    const response = createResponseRecorder();

    startRepoRouterAuth(
      { query: { returnTo } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(302);
    expect(response.location).toBe("/oneshot");
  });
});
