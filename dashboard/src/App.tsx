import { useCallback, useEffect, useState } from "react";
import { DashboardNav } from "./components/DashboardNav.js";
import { OfficePage } from "./routes/OfficePage.js";
import { InvestigationPage } from "./routes/InvestigationPage.js";
import { OneShotPage } from "./routes/OneShotPage.js";
import { ProductionSupportPage } from "./production-support/ProductionSupportPage.js";
import { ProductCatalogPage } from "./routes/ProductCatalogPage.js";
import { SpecFactoryPage } from "./spec-factory/SpecFactoryPage.js";
import { WatchdogLandingPage } from "./routes/WatchdogLandingPage.js";
import { WatchdogPage } from "./routes/WatchdogPage.js";

type SupportedPath =
  | "/"
  | "/oneshot"
  | "/production-support"
  | "/product-catalog"
  | "/spec-factory"
  | "/watchdog"
  | "/watchdog/intro"
  | "/investigation";

function normalizePathname(pathname: string): SupportedPath {
  if (pathname.startsWith("/investigation")) return "/investigation";
  if (pathname.startsWith("/watchdog/intro")) return "/watchdog/intro";
  if (pathname.startsWith("/watchdog")) return "/watchdog";
  if (pathname.startsWith("/spec-factory")) return "/spec-factory";
  if (pathname.startsWith("/product-catalog")) return "/product-catalog";
  if (pathname.startsWith("/production-support")) return "/production-support";
  return pathname.startsWith("/oneshot") ? "/oneshot" : "/";
}

export default function App() {
  const [pathname, setPathname] = useState<SupportedPath>(() =>
    normalizePathname(window.location.pathname),
  );

  useEffect(() => {
    const handlePopState = () => {
      setPathname(normalizePathname(window.location.pathname));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((nextPath: SupportedPath) => {
    if (normalizePathname(window.location.pathname) === nextPath) {
      return;
    }

    window.history.pushState({}, "", nextPath);
    setPathname(nextPath);
  }, []);

  const isOneShot = pathname === "/oneshot";
  const isProductionSupport = pathname === "/production-support";
  const isProductCatalog = pathname === "/product-catalog";
  const isSpecFactory = pathname === "/spec-factory";
  const isWatchdog = pathname === "/watchdog";
  const isWatchdogIntro = pathname === "/watchdog/intro";
  const isInvestigation = pathname === "/investigation";
  const isDocumentPage =
    isOneShot ||
    isProductionSupport ||
    isProductCatalog ||
    isSpecFactory ||
    isWatchdog ||
    isWatchdogIntro ||
    isInvestigation;

  return (
    <div
      style={{
        width: "100%",
        height: isDocumentPage ? "auto" : "100vh",
        minHeight: "100%",
        position: "relative",
        overflow: isDocumentPage ? "visible" : "hidden",
      }}
    >
      {isOneShot ? (
        <OneShotPage />
      ) : isProductionSupport ? (
        <ProductionSupportPage />
      ) : isProductCatalog ? (
        <ProductCatalogPage />
      ) : isSpecFactory ? (
        <SpecFactoryPage />
      ) : isInvestigation ? (
        <InvestigationPage />
      ) : isWatchdogIntro ? (
        <WatchdogLandingPage />
      ) : isWatchdog ? (
        <WatchdogPage />
      ) : (
        <>
          <OfficePage />
          <DashboardNav currentPath={pathname} onNavigate={navigate} />
        </>
      )}
    </div>
  );
}
