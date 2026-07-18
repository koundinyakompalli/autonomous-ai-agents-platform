// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "./App.js";

vi.mock("./routes/OfficePage.js", () => ({
  OfficePage: () => <main aria-label="Floor">Floor</main>,
}));

vi.mock("./routes/OneShotPage.js", () => ({
  OneShotPage: () => <main aria-label="OneShot">OneShot</main>,
}));

vi.mock("./production-support/ProductionSupportPage.js", () => ({
  ProductionSupportPage: () => (
    <main aria-label="Production Support">Production Support</main>
  ),
}));

vi.mock("./routes/ProductCatalogPage.js", () => ({
  ProductCatalogPage: () => (
    <main aria-label="Product Catalog">Product Catalog</main>
  ),
}));

vi.mock("./routes/WatchdogLandingPage.js", () => ({
  WatchdogLandingPage: () => <main aria-label="Watchdog intro">Intro</main>,
}));

vi.mock("./routes/WatchdogPage.js", () => ({
  WatchdogPage: () => <main aria-label="Watchdog">Watchdog</main>,
}));

vi.mock("./spec-factory/SpecFactoryPage.js", () => ({
  SpecFactoryPage: () => <main aria-label="Spec Factory">Spec Factory</main>,
}));

describe("App production support route", () => {
  it("renders the Production Support screen from /production-support", () => {
    window.history.pushState({}, "", "/production-support");

    render(<App />);

    expect(
      screen.getByRole("main", { name: "Production Support" }),
    ).toBeTruthy();
  });

  it("shows Production Support in the global dashboard navigation", () => {
    window.history.pushState({}, "", "/");

    render(<App />);

    expect(
      screen.getByRole("button", { name: "Production Support" }),
    ).toBeTruthy();
  });
});

describe("App spec factory route", () => {
  it("renders the Spec Factory screen from /spec-factory", () => {
    window.history.pushState({}, "", "/spec-factory");

    render(<App />);

    expect(screen.getByRole("main", { name: "Spec Factory" })).toBeTruthy();
  });

  it("shows Spec Factory in the global dashboard navigation", () => {
    window.history.pushState({}, "", "/");

    render(<App />);

    expect(screen.getByRole("button", { name: "Spec Factory" })).toBeTruthy();
  });
});

describe("App product catalog route", () => {
  it("renders the Product Catalog screen from /product-catalog", () => {
    window.history.pushState({}, "", "/product-catalog");

    render(<App />);

    expect(screen.getByRole("main", { name: "Product Catalog" })).toBeTruthy();
  });

  it("shows Product Catalog in the global dashboard navigation", () => {
    window.history.pushState({}, "", "/");

    render(<App />);

    expect(
      screen.getByRole("button", { name: "Product Catalog" }),
    ).toBeTruthy();
  });
});
