import { describe, expectTypeOf, it } from "vitest";
import type {
  OneShotModelCost as ClientOneShotModelCost,
  OneShotModelPricing as ClientOneShotModelPricing,
} from "./types.js";
import type {
  OneShotModelCost as ServerOneShotModelCost,
  OneShotModelPricing as ServerOneShotModelPricing,
} from "../../server/types/oneshot.js";

describe("OneShot costs type contract", () => {
  it("keeps client model pricing types aligned with the server wire contract", () => {
    expectTypeOf<ClientOneShotModelPricing>().toEqualTypeOf<
      ServerOneShotModelPricing
    >();
    expectTypeOf<ClientOneShotModelCost>().toEqualTypeOf<
      ServerOneShotModelCost
    >();
  });
});
