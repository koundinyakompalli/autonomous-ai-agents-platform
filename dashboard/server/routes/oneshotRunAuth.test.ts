import { describe, expect, it } from "vitest";
import { startOneShotRunAuth } from "./oneshotRunAuth.js";

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

describe("oneshot run auth route", () => {
  it("redirects back to the requested relative path with the new-run marker", () => {
    const response = createResponseRecorder();

    startOneShotRunAuth(
      { query: { returnTo: "/oneshot?view=runs&range=24h" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(302);
    expect(response.location).toBe("/oneshot?view=runs&range=24h&newRun=1");
  });

  it("sanitizes unsafe return targets before adding the new-run marker", () => {
    const response = createResponseRecorder();

    startOneShotRunAuth(
      { query: { returnTo: "https://evil.example/oneshot" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(302);
    expect(response.location).toBe("/oneshot?newRun=1");
  });
});
