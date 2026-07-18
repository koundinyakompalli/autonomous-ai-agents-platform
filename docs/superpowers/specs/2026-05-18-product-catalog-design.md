# Product Catalog Design

Date: 2026-05-18

## Goal

Add a top-level **Product Catalog** screen to the dashboard that showcases products and capabilities produced by multiple factories. OneShot is one factory in this catalog, not the catalog itself.

The first implementation should feel as close to Netflix as is practical inside this dashboard: black-first surface, horizontal shelf browsing, a large featured billboard, strong card artwork, hover enlargement, and an overlay detail experience. The catalog still needs operational substance: each product must expose what was built, configuration requirements, supported versions, deployment steps, evidence, and related links.

## Scope

In scope for v1:

- Top-level route: `/product-catalog`.
- Top-level nav item: `Product Catalog`.
- Curated typed frontend dataset for initial products.
- Netflix-style catalog page with:
  - sticky top navigation area,
  - search and lightweight filters,
  - featured product billboard,
  - horizontal product shelves,
  - hover/focus card enlargement,
  - card click opening a Netflix-like detail overlay anchored as a right-side drawer on desktop.
- Product detail content:
  - overview,
  - factory/source,
  - product status,
  - supported versions,
  - configuration,
  - deployment steps,
  - dependencies,
  - evidence and links,
  - known limitations.

Out of scope for v1:

- Backend persistence or admin editing.
- Auto-discovery of products from Jira, GitHub, or docs.
- Runtime deployment actions from the catalog.
- Per-user recommendations or personalization.

## Visual Thesis

A Netflix-like internal product catalog: cinematic black surface, large featured product billboard, dense horizontal shelves, and high-confidence product tiles, with operational details revealed only after selection.

## Content Model

Create a typed catalog data module in the dashboard frontend. Each product should use a structure similar to:

- `id`
- `name`
- `tagline`
- `description`
- `factory`
- `status`
- `domains`
- `shelves`
- `supportedVersions`
- `configuration`
- `deploymentSteps`
- `dependencies`
- `evidenceLinks`
- `knownLimitations`
- `lastUpdated`
- `accent`

Seed content should use real Product-Factory examples from this repo and recent work where possible, including OneShot, production-support automation, preview deployment, Jira posting, repository routing, and dashboard capabilities. The content remains curated and easy to replace when a backend source exists.

## Page Structure

The page should use a dedicated `ProductCatalogPage` route component.

Primary sections:

1. Top navigation rail
   - Product Catalog title.
   - Top-level factory/category tabs such as `All`, `OneShot`, `Production Support`, `Spec Factory`, `Platform`.
   - Search field.
   - Filter trigger for status/domain/version.

2. Featured billboard
   - Large feature area similar to Netflix's selected hero treatment.
   - Uses one featured product from the dataset.
   - Shows product name, short description, status, factory, supported version signal, and a primary `View details` action.

3. Product shelves
   - Horizontal shelves grouped by curated shelf definitions:
     - Featured
     - Recently Built
     - Production Ready
     - Needs Configuration
     - Factory: OneShot
     - Factory: Production Support
     - Upcoming / Spec Factory
   - Shelves should scroll horizontally and preserve card dimensions.
   - Empty shelves are hidden.

4. Product cards
   - Wide landscape cards, not generic dashboard cards.
   - Use strong color/art direction per product.
   - Hover/focus should scale the card and reveal metadata, matching Netflix behavior closely without making layout unstable.
   - Cards are clickable and keyboard focusable.

5. Detail overlay
   - Opens when selecting a product.
   - Keeps the catalog context visible.
   - Anchors to the right on desktop to preserve the accepted browsing model.
   - Becomes a full-screen sheet on mobile.
   - Presents operational sections clearly:
     - What was built
     - How to configure
     - Supported versions
     - Deployment steps
     - Evidence and links
     - Known limitations

## Interaction Design

- Default state lands on `All` with the featured billboard and all populated shelves.
- Selecting a factory tab filters shelves to matching products.
- Search filters across product name, tagline, factory, domain, and supported versions.
- Clicking a card opens product details.
- Pressing `Escape` closes the detail view.
- Hovering a card enlarges it and reveals quick metadata.
- Keyboard users can tab through cards and open details with Enter/Space.
- On mobile, shelves remain horizontal, and details open as a full-screen sheet.

## Architecture

New frontend files:

- `dashboard/src/routes/ProductCatalogPage.tsx`
- `dashboard/src/product-catalog/catalogData.ts`
- `dashboard/src/product-catalog/types.ts`
- `dashboard/src/product-catalog/ProductCatalog.css`

Existing files to update:

- `dashboard/src/App.tsx`
  - Add `/product-catalog` to the supported path model.
  - Route to `ProductCatalogPage`.
- `dashboard/src/components/DashboardNav.tsx`
  - Add a `Product Catalog` nav item.
  - Include `/product-catalog` in the navigation type.

The v1 data source is a pure frontend module. Keep filtering and shelf-building as local pure functions so later API-backed catalog data can reuse the same rendering path.

## Error And Empty States

- If no products match search/filter state, show a quiet empty state with a clear reset action.
- If a selected product disappears due to filtering, close the detail overlay.
- If optional links are absent, omit the section instead of showing empty placeholders.
- Unsupported or unknown status values should render with a neutral status treatment.

## Testing

Add focused dashboard tests for:

- `/product-catalog` route rendering.
- Dashboard nav includes and navigates to Product Catalog.
- Search filters products.
- Factory/status filtering changes visible shelves.
- Clicking a card opens the detail drawer.
- Escape closes the detail drawer.
- Empty state appears for no matches.

Run:

- Focused dashboard Vitest tests for the new route and navigation.
- `npm run build` in `dashboard` before creating a PR.

## Acceptance Criteria

- Product Catalog is reachable as a top-level screen.
- The first impression strongly resembles Netflix: black surface, featured billboard, horizontal rows, large product artwork, hover expansion, and detail overlay.
- OneShot appears as one factory/category among others.
- Product details include configuration, supported versions, deployment steps, evidence, and limitations.
- The implementation does not require backend schema changes.
- The curated dataset is typed and isolated from rendering components.
- Existing OneShot, Watchdog, and Office routes continue to work.
