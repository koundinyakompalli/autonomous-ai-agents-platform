import { Fragment, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ExternalLink, GitPullRequest, Info, PlayCircle } from "lucide-react";
import {
  FACTORY_FILTERS,
  PRODUCT_STATUS_LABEL,
  STATUS_FILTERS,
  buildProductArtworkMap,
  buildProductShelves,
  filterProducts,
  getFeaturedProduct,
} from "../product-catalog/catalogData.js";
import type {
  ProductCatalogItem,
  ProductCatalogResponse,
  ProductContentType,
  ProductDeploymentActionKind,
  ProductFactory,
  ProductStatus,
} from "../product-catalog/types.js";
import "../product-catalog/ProductCatalog.css";

function crossNavigate(
  path: "/" | "/oneshot" | "/production-support" | "/watchdog",
) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const PRODUCT_CONTENT_TYPE_LABEL: Record<ProductContentType, string> = {
  feature: "Feature",
  fix: "Fix",
  integration: "Integration",
  epic: "Epic",
};

const BILLBOARD_TITLE = "Preview before Merge";
const BILLBOARD_DESCRIPTION =
  "Feature introduced in OneShot to preview generated implementation branches before merge.";
const BILLBOARD_STATUS: ProductStatus = "production_ready";
const BILLBOARD_FACTORY: ProductFactory = "OneShot";
const BILLBOARD_TYPE = "Feature";

function contentTypeLabel(product: ProductCatalogItem): string | null {
  return product.contentType ? PRODUCT_CONTENT_TYPE_LABEL[product.contentType] : null;
}

function productionSupportAgentLabel(product: ProductCatalogItem): string {
  const agentVersion = product.supportedVersions.find((version) =>
    version.toLowerCase().startsWith("agent:"),
  );
  const agentFromVersion = agentVersion?.split(":").slice(1).join(":").trim();
  if (agentFromVersion) return agentFromVersion;

  const agentFromTagline = product.tagline.split(" - ")[0]?.trim();
  return agentFromTagline || "Production Support";
}

function isOneShotPrOutputProduct(product: ProductCatalogItem): boolean {
  return (
    product.factory === "OneShot" &&
    product.contentType !== undefined &&
    product.contentType !== "epic" &&
    product.recentTickets?.some(
      (ticket) => ticket.source === "oneshot" && Boolean(ticket.prUrl?.trim()),
    ) === true
  );
}

function isProductionSupportStoryProduct(product: ProductCatalogItem): boolean {
  return (
    product.factory === "Production Support" &&
    product.status === "production_ready" &&
    product.shelves.includes("production_support") &&
    product.recentTickets?.some((ticket) => ticket.source === "task") === true
  );
}

function productArtworkStyle(
  product: ProductCatalogItem,
  artworkUrl: string | undefined,
): CSSProperties {
  return {
    backgroundColor: product.accent.secondary,
    backgroundImage: artworkUrl
      ? `url("${artworkUrl}"), ${product.accent.image}`
      : product.accent.image,
  };
}

function DeploymentActionIcon({ kind }: { kind: ProductDeploymentActionKind }) {
  if (kind === "github") return <GitPullRequest aria-hidden="true" size={15} />;
  if (kind === "jenkins") return <PlayCircle aria-hidden="true" size={15} />;
  return <ExternalLink aria-hidden="true" size={15} />;
}

function ProductCard({
  product,
  artworkUrl,
  onSelect,
}: {
  product: ProductCatalogItem;
  artworkUrl?: string;
  onSelect: (product: ProductCatalogItem) => void;
}) {
  const catalogType = contentTypeLabel(product);
  return (
    <button
      type="button"
      className="pc-card"
      style={productArtworkStyle(product, artworkUrl)}
      onClick={() => onSelect(product)}
      aria-label={`${product.name} product card`}
    >
      <span className="pc-card-copy">
        <span className="pc-card-title">{product.name}</span>
        <span className="pc-card-tagline">{product.tagline}</span>
        <span className="pc-card-meta">
          {product.factory} - {PRODUCT_STATUS_LABEL[product.status]}
        </span>
      </span>
      <span className="pc-card-hover-panel" aria-hidden="true">
        <span className="pc-card-controls">
          <span className="pc-card-play">
            <PlayCircle aria-hidden="true" size={18} />
          </span>
          <span>Details</span>
        </span>
        <span className="pc-card-domains">
          {product.domains.slice(0, 2).join(" - ")}
        </span>
      </span>
      {catalogType ? (
        <span className={`pc-card-kind is-${product.contentType}`}>{catalogType}</span>
      ) : product.repository ? (
        <span className="pc-card-repo">{product.repository.name}</span>
      ) : null}
      {product.metrics?.recentOneshotRuns ? (
        <span className="pc-card-signal">
          {product.metrics.recentOneshotRuns} recent runs
        </span>
      ) : null}
    </button>
  );
}

function ProductionSupportStoryCard({
  product,
  artworkUrl,
  onSelect,
}: {
  product: ProductCatalogItem;
  artworkUrl?: string;
  onSelect: (product: ProductCatalogItem) => void;
}) {
  const ticket = product.recentTickets?.[0];
  const agentLabel = productionSupportAgentLabel(product);
  return (
    <button
      type="button"
      className="pc-reel-card"
      style={productArtworkStyle(product, artworkUrl)}
      onClick={() => onSelect(product)}
      aria-label={`${product.name} production support story`}
    >
      <span className="pc-reel-status">{agentLabel}</span>
      <span className="pc-reel-copy">
        <span className="pc-reel-title">{product.name}</span>
        <span className="pc-reel-tagline">{product.tagline}</span>
        <span className="pc-reel-meta">
          {ticket?.branch ?? "Production Support"}
        </span>
      </span>
    </button>
  );
}

function ProductionSupportStories({
  products,
  artworkByProductId,
  onSelect,
}: {
  products: ProductCatalogItem[];
  artworkByProductId: Map<string, string>;
  onSelect: (product: ProductCatalogItem) => void;
}) {
  if (products.length === 0) return null;
  return (
    <section className="pc-reels" aria-label="Production Support Stories">
      <div className="pc-shelf-header">
        <h2>Production Support Stories</h2>
        <p>Completed Production Support work from task management and Jira posting</p>
      </div>
      <div className="pc-reel-row">
        {products.map((product) => (
          <ProductionSupportStoryCard
            key={product.id}
            product={product}
            artworkUrl={artworkByProductId.get(product.id)}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function DetailSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="pc-detail-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function DeploymentSection({ product }: { product: ProductCatalogItem }) {
  if (product.deploymentSteps.length === 0 && !product.deploymentActions?.length) {
    return null;
  }
  return (
    <section className="pc-detail-section">
      <h3>Deployment steps</h3>
      {product.deploymentActions && product.deploymentActions.length > 0 && (
        <div className="pc-deployment-actions">
          {product.deploymentActions.map((action) => (
            <a
              key={`${action.kind}-${action.href}`}
              className={`pc-action-button is-${action.kind}`}
              href={action.href}
              target="_blank"
              rel="noreferrer"
            >
              <DeploymentActionIcon kind={action.kind} />
              <span>{action.label}</span>
            </a>
          ))}
        </div>
      )}
      {product.deploymentSteps.length > 0 && (
        <ul>
          {product.deploymentSteps.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProductDetailOverlay({
  product,
  artworkUrl,
  onClose,
}: {
  product: ProductCatalogItem;
  artworkUrl?: string;
  onClose: () => void;
}) {
  const catalogType = contentTypeLabel(product);
  return (
    <div className="pc-overlay-backdrop" onClick={onClose}>
      <aside
        className="pc-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`${product.name} details`}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="pc-detail-close"
          onClick={onClose}
          aria-label="Close product details"
        >
          X
        </button>
        <div className="pc-detail-art" style={productArtworkStyle(product, artworkUrl)} />
        <div className="pc-detail-body">
          <h2>{product.name}</h2>
          <p className="pc-detail-tagline">{product.tagline}</p>
          <p>{product.description}</p>
          <div className="pc-detail-badges">
            {catalogType && <span>{catalogType}</span>}
            <span>{PRODUCT_STATUS_LABEL[product.status]}</span>
            {product.supportedVersions.slice(0, 2).map((version) => (
              <span key={version}>{version}</span>
            ))}
          </div>
          {product.storyDescription && (
            <section className="pc-detail-section pc-story-section">
              <h3>Story</h3>
              <p>{product.storyDescription}</p>
            </section>
          )}
          {product.supportInsight?.defectDescription && (
            <section className="pc-detail-section pc-story-section">
              <h3>Defect</h3>
              <p>{product.supportInsight.defectDescription}</p>
            </section>
          )}
          {product.supportInsight?.rootCause && (
            <section className="pc-detail-section pc-story-section">
              <h3>Root cause</h3>
              <p>{product.supportInsight.rootCause}</p>
            </section>
          )}
          {product.contentGroup && (
            <section className="pc-detail-section">
              <h3>Epic</h3>
              <div className="pc-repo-line">
                <span>{product.contentGroup.label}</span>
                <span>{product.contentGroup.ticketCount} tickets</span>
              </div>
            </section>
          )}
          {product.repository && (
            <section className="pc-detail-section">
              <h3>Repository</h3>
              <div className="pc-repo-line">
                <span>{product.repository.name}</span>
                <span>{product.repository.defaultBranch}</span>
                <a href={product.repository.url}>GitHub</a>
              </div>
            </section>
          )}
          {product.metrics && (
            <section className="pc-detail-section">
              <h3>Live metrics</h3>
              <div className="pc-metric-grid">
                {Object.entries(product.metrics)
                  .filter(([, value]) => typeof value === "number")
                  .map(([key, value]) => (
                    <div key={key}>
                      <strong>{value}</strong>
                      <span>{key.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
                    </div>
                  ))}
              </div>
            </section>
          )}
          {product.recentTickets && product.recentTickets.length > 0 && (
            <section className="pc-detail-section">
              <h3>{product.contentType === "epic" ? "Linked tickets" : "Recent tickets"}</h3>
              <div className="pc-ticket-list">
                {product.recentTickets.slice(0, 8).map((ticket) => (
                  <div key={`${ticket.source}-${ticket.key}-${ticket.branch ?? ""}`}>
                    <span>{ticket.key}</span>
                    <small>
                      {ticket.source}
                      {ticket.state ? ` - ${ticket.state}` : ""}
                      {ticket.branch ? ` - ${ticket.branch}` : ""}
                    </small>
                  </div>
                ))}
              </div>
            </section>
          )}
          <DetailSection title="How to configure" items={product.configuration} />
          <DetailSection title="Supported versions" items={product.supportedVersions} />
          <DeploymentSection product={product} />
          <DetailSection title="Dependencies" items={product.dependencies} />
          <DetailSection title="Known limitations" items={product.knownLimitations} />
          {product.evidenceLinks.length > 0 && (
            <section className="pc-detail-section">
              <h3>Evidence and links</h3>
              <div className="pc-links">
                {product.evidenceLinks.map((link) => (
                  <a key={link.href} href={link.href}>
                    {link.label}
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

export function ProductCatalogPage() {
  const [factory, setFactory] = useState<ProductFactory | "all">("all");
  const [status, setStatus] = useState<ProductStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [liveCatalog, setLiveCatalog] =
    useState<ProductCatalogResponse | null>(null);
  const [catalogLoadState, setCatalogLoadState] =
    useState<"loading" | "live" | "error">("loading");
  const [selectedProduct, setSelectedProduct] =
    useState<ProductCatalogItem | null>(null);

  useEffect(() => {
    if (typeof fetch !== "function") return;

    let cancelled = false;
    async function loadCatalog() {
      try {
        const response = await fetch("/api/product-catalog");
        if (!response.ok) {
          throw new Error(`Product Catalog request failed with ${response.status}`);
        }
        const payload = (await response.json()) as ProductCatalogResponse;
        if (!cancelled && Array.isArray(payload.products)) {
          setLiveCatalog(payload);
          setCatalogLoadState("live");
        }
      } catch {
        if (!cancelled) {
          setCatalogLoadState("error");
        }
      }
    }

    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  const oneShotProducts = useMemo(
    () => liveCatalog?.products.filter(isOneShotPrOutputProduct) ?? [],
    [liveCatalog],
  );
  const productionSupportStories = useMemo(
    () => liveCatalog?.products.filter(isProductionSupportStoryProduct) ?? [],
    [liveCatalog],
  );

  const filteredOneShotProducts = useMemo(
    () => filterProducts(oneShotProducts, { factory, status, query }),
    [oneShotProducts, factory, query, status],
  );
  const filteredProductionSupportStories = useMemo(
    () => filterProducts(productionSupportStories, { factory, status, query }),
    [factory, productionSupportStories, query, status],
  );
  const shelves = useMemo(
    () => buildProductShelves(filteredOneShotProducts),
    [filteredOneShotProducts],
  );
  const featuredProduct =
    getFeaturedProduct(filteredOneShotProducts) ?? getFeaturedProduct(oneShotProducts);
  const artworkProducts = useMemo(
    () => [...oneShotProducts, ...productionSupportStories],
    [oneShotProducts, productionSupportStories],
  );
  const artworkByProductId = useMemo(
    () => buildProductArtworkMap(artworkProducts),
    [artworkProducts],
  );
  const visibleProducts = useMemo(
    () => [...filteredOneShotProducts, ...filteredProductionSupportStories],
    [filteredOneShotProducts, filteredProductionSupportStories],
  );

  useEffect(() => {
    if (!selectedProduct) return;
    if (!visibleProducts.some((product) => product.id === selectedProduct.id)) {
      setSelectedProduct(null);
    }
  }, [selectedProduct, visibleProducts]);

  useEffect(() => {
    if (!selectedProduct) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedProduct(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedProduct]);

  const resetFilters = () => {
    setFactory("all");
    setStatus("all");
    setQuery("");
  };

  return (
    <div className="pc-scope">
      <nav className="pc-topbar" aria-label="Product Catalog navigation">
        <button type="button" className="pc-logo" onClick={resetFilters}>
          Product Catalog
        </button>
        <div className="pc-nav-links">
          <button
            type="button"
            aria-label="Open Floor"
            onClick={() => crossNavigate("/")}
          >
            Floor
          </button>
          <button
            type="button"
            aria-label="Open OneShot"
            onClick={() => crossNavigate("/oneshot")}
          >
            OneShot
          </button>
          <button
            type="button"
            aria-label="Open Production Support"
            onClick={() => crossNavigate("/production-support")}
          >
            Production Support
          </button>
          <button
            type="button"
            aria-label="Open Watchdog"
            onClick={() => crossNavigate("/watchdog")}
          >
            Watchdog
          </button>
        </div>
        <label className="pc-search">
          <span>Search products</span>
          <input
            type="search"
            aria-label="Search products"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search products"
          />
        </label>
        <div className={`pc-source-pill is-${catalogLoadState}`}>
          {catalogLoadState === "live"
            ? "Live RDS"
            : catalogLoadState === "error"
              ? "RDS unavailable"
              : "Loading RDS"}
        </div>
      </nav>

      <main className="pc-main" aria-label="Product Catalog">
        <div className="pc-filter-row" aria-label="Factory filters">
          {FACTORY_FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              className={factory === item ? "is-active" : ""}
              onClick={() => setFactory(item)}
            >
              {item === "all" ? "All" : item}
            </button>
          ))}
          <select
            aria-label="Status filter"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as ProductStatus | "all")
            }
          >
            {STATUS_FILTERS.map((item) => (
              <option key={item} value={item}>
                {PRODUCT_STATUS_LABEL[item]}
              </option>
            ))}
          </select>
        </div>

        {featuredProduct && (
          <section
            className="pc-billboard"
            style={productArtworkStyle(
              featuredProduct,
              artworkByProductId.get(featuredProduct.id),
            )}
          >
            <div className="pc-billboard-content">
              <div className="pc-eyebrow">Featured Product</div>
              <h1>{BILLBOARD_TITLE}</h1>
              <div className="pc-billboard-metadata">
                <strong>{PRODUCT_STATUS_LABEL[BILLBOARD_STATUS]}</strong>
                <span>{BILLBOARD_FACTORY}</span>
                <span>{BILLBOARD_TYPE}</span>
              </div>
              <p>{BILLBOARD_DESCRIPTION}</p>
              <div className="pc-billboard-actions">
                <button
                  type="button"
                  className="pc-billboard-primary"
                  onClick={() => setSelectedProduct(featuredProduct)}
                >
                  <PlayCircle aria-hidden="true" size={22} />
                  View latest output
                </button>
                <button
                  type="button"
                  className="pc-billboard-secondary"
                  onClick={() =>
                    document
                      .querySelector(".pc-shelves")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  <Info aria-hidden="true" size={21} />
                  Browse catalog
                </button>
              </div>
            </div>
          </section>
        )}

        {shelves.length === 0 && filteredProductionSupportStories.length === 0 ? (
          <section className="pc-empty">
            <h2>No products match this view.</h2>
            <button type="button" onClick={resetFilters}>
              Reset catalog filters
            </button>
          </section>
        ) : (
          <div className="pc-shelves">
            {shelves.map((shelf, index) => (
              <Fragment key={shelf.key}>
                <section
                  className="pc-shelf"
                  aria-label={shelf.title}
                >
                  <div className="pc-shelf-header">
                    <h2>{shelf.title}</h2>
                    <p>{shelf.subtitle}</p>
                  </div>
                  <div className="pc-row">
                    {shelf.products.map((product) => (
                      <ProductCard
                        key={`${shelf.key}-${product.id}`}
                        product={product}
                        artworkUrl={artworkByProductId.get(product.id)}
                        onSelect={setSelectedProduct}
                      />
                    ))}
                  </div>
                </section>
                {index === 0 && (
                  <ProductionSupportStories
                    products={filteredProductionSupportStories}
                    artworkByProductId={artworkByProductId}
                    onSelect={setSelectedProduct}
                  />
                )}
              </Fragment>
            ))}
            {shelves.length === 0 && (
              <ProductionSupportStories
                products={filteredProductionSupportStories}
                artworkByProductId={artworkByProductId}
                onSelect={setSelectedProduct}
              />
            )}
          </div>
        )}
      </main>

      {selectedProduct && (
        <ProductDetailOverlay
          product={selectedProduct}
          artworkUrl={artworkByProductId.get(selectedProduct.id)}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}
