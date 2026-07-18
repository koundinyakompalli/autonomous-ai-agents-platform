import { describe, expect, it } from "vitest";
import {
  buildProductArtworkMap,
  buildProductShelves,
  catalogProducts,
  filterProducts,
  findProductById,
  getFeaturedProduct,
  getProductArtwork,
  getProductVisualCategory,
} from "./catalogData.js";

describe("product catalog data", () => {
  it("seeds products from multiple factories", () => {
    expect(catalogProducts.length).toBeGreaterThanOrEqual(6);
    expect(
      new Set(catalogProducts.map((product) => product.factory)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(
      catalogProducts.some((product) => product.factory === "OneShot"),
    ).toBe(true);
  });

  it("filters products by search query across operational fields", () => {
    const matches = filterProducts(catalogProducts, {
      factory: "all",
      status: "all",
      query: "preview",
    });

    expect(matches.map((product) => product.id)).toContain(
      "coreapp-preview-deployments",
    );
  });

  it("filters products by factory and status", () => {
    const matches = filterProducts(catalogProducts, {
      factory: "OneShot",
      status: "production_ready",
      query: "",
    });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((product) => product.factory === "OneShot")).toBe(
      true,
    );
    expect(
      matches.every((product) => product.status === "production_ready"),
    ).toBe(true);
  });

  it("builds populated shelves and hides empty shelves", () => {
    const shelves = buildProductShelves(
      filterProducts(catalogProducts, {
        factory: "all",
        status: "all",
        query: "",
      }),
    );

    expect(shelves.length).toBeGreaterThan(2);
    expect(shelves.every((shelf) => shelf.products.length > 0)).toBe(true);
    expect(shelves.map((shelf) => shelf.title)).toContain("Top Picks");
    expect(shelves.map((shelf) => shelf.title)).toContain("Recently Added");
  });

  it("builds repository shelves from live catalog metadata", () => {
    const shelves = buildProductShelves([
      {
        ...catalogProducts[0],
        id: "repo-core-app",
        name: "core-app",
        shelves: ["trending", "repo:core-app"],
        repository: {
          id: 1,
          name: "core-app",
          url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          defaultBranch: "master",
        },
      },
    ]);

    expect(shelves.map((shelf) => shelf.title)).toContain("Trending");
    expect(shelves.map((shelf) => shelf.title)).toContain("Repo: core-app");
  });

  it("builds OneShot ticket and epic shelves from live catalog metadata", () => {
    const shelves = buildProductShelves([
      {
        ...catalogProducts[0],
        id: "oneshot-ticket-172-cpdev-22733",
        name: "CPDEV-22733",
        contentType: "feature",
        shelves: ["oneshot_tickets", "recently_added"],
      },
      {
        ...catalogProducts[0],
        id: "oneshot-epic-42-cpdev-epic",
        name: "CPDEV-EPIC",
        contentType: "epic",
        shelves: ["oneshot_epics", "top_picks"],
      },
    ]);

    expect(shelves.map((shelf) => shelf.title)).toContain("OneShot Tickets");
    expect(shelves.map((shelf) => shelf.title)).toContain("OneShot Epics");
  });

  it("finds featured and selected products", () => {
    expect(getFeaturedProduct(catalogProducts)?.id).toBe(
      "coreapp-preview-deployments",
    );
    expect(findProductById("jira-ai-result-posting")?.name).toBe(
      "Jira AI Result Posting",
    );
  });

  it("maps products to stable generated tile artwork by software category", () => {
    const feature = {
      ...catalogProducts[0],
      id: "oneshot-ticket-172-cpdev-22733",
      name: "CPDEV-22733",
      contentType: "feature" as const,
      domains: ["Feature Delivery"] as const,
    };
    const fix = {
      ...catalogProducts[0],
      id: "oneshot-ticket-202-cpdev-22002",
      name: "CPDEV-22002",
      contentType: "fix" as const,
    };
    const security = {
      ...catalogProducts[0],
      id: "security-hardening",
      name: "Security hardening",
      description: "Adds authentication and access control coverage.",
    };
    const performance = {
      ...catalogProducts[0],
      id: "pipeline-throughput",
      name: "Pipeline throughput",
      description: "Improves runtime reliability and latency.",
    };
    const data = {
      ...catalogProducts[0],
      id: "analytics-insights",
      name: "Analytics insights",
      description: "Shows reporting metrics and product insight trends.",
    };

    expect(getProductVisualCategory(feature)).toBe("features");
    expect(getProductVisualCategory(fix)).toBe("fixes");
    expect(getProductVisualCategory(security)).toBe("security");
    expect(getProductVisualCategory(performance)).toBe("performance");
    expect(getProductVisualCategory(data)).toBe("data");
    expect(getProductArtwork(feature)).toMatch(
      /^\/product-catalog\/tiles\/features\/\d+\.jpg$/,
    );
    expect(getProductArtwork(feature)).toBe(getProductArtwork(feature));
  });

  it("uses the full visible artwork pool before repeating images", () => {
    const featureProducts = Array.from({ length: 14 }, (_, index) => ({
      ...catalogProducts[0],
      id: `feature-${index + 1}`,
      name: `Feature ${index + 1}`,
      contentType: "feature" as const,
      domains: ["Feature Delivery"] as const,
    }));
    const artwork = buildProductArtworkMap(featureProducts);

    expect(artwork.get("feature-1")).toBe("/product-catalog/tiles/features/1.jpg");
    expect(artwork.get("feature-13")).toBe("/product-catalog/tiles/features/13.jpg");
    expect(artwork.get("feature-14")).toBe("/product-catalog/tiles/fixes/1.jpg");
    expect(new Set([...artwork.values()]).size).toBe(14);
  });
});
