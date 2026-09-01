// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The wizard's "Choose your model" step has to offer TokenHub models on an Xcity deployment —
// the BYOK dialog is useless there — while staying byte-identical on every other deployment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  getXcityProviderInfo: vi.fn<() => Promise<unknown>>(async () => null),
  listModels: vi.fn<() => Promise<unknown[]>>(async () => []),
  addModelProps: [] as unknown[],
  xcityAddModelProps: [] as unknown[],
}));

const authenticatedApi = {
  listModels: testState.listModels,
  getAiConfig: async () => ({ enabled: false }),
  getXcityProviderInfo: testState.getXcityProviderInfo,
  listGatekeeperVendors: async () => [],
  subscribeConnectedAccounts: () => {
    const subscription = Promise.resolve();
    return Object.assign(subscription, { [Symbol.dispose]: () => {} });
  },
};

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi,
    currentUser: { id: "user-a", name: "User A" },
  }),
}));

vi.mock("./ThemeContext", () => ({ useTheme: () => ({ resolvedThemeMode: "light" }) }));
vi.mock("./ServerConfigContext", () => ({ useSiteName: () => "Workshop" }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));
vi.mock("./components/SiteLogo", () => ({ default: () => null }));
vi.mock("./components/XcityMark", () => ({ default: () => null }));

vi.mock("./AddModelModal", () => ({
  default: (props: unknown) => {
    testState.addModelProps.push(props);
    return <div data-testid="byok-add-model" />;
  },
}));

vi.mock("./XcityAddModelModal", () => ({
  default: (props: unknown) => {
    testState.xcityAddModelProps.push(props);
    return <div data-testid="xcity-add-model" />;
  },
}));

import OnboardingWizard from "./OnboardingWizard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const XCITY_INFO = {
  tokenhubUrl: "https://tokenhub.xcity.ai",
  modelIds: ["gpt-5.5-xhigh"],
  catalog: [
    { id: "gpt-5.5-xhigh", name: "gpt-5.5-xhigh", hidden: false },
    { id: "cheap-model", name: "cheap-model", hidden: true },
  ],
  diagnostics: { identity: true, keyPresent: true },
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderWizard() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<OnboardingWizard onComplete={() => {}} />));
  // Let the model/provider-info fetches settle.
  await act(async () => { await Promise.resolve(); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  testState.addModelProps.length = 0;
  testState.xcityAddModelProps.length = 0;
  testState.getXcityProviderInfo.mockResolvedValue(null);
  testState.listModels.mockResolvedValue([]);
  vi.clearAllMocks();
});

describe("OnboardingWizard model step", () => {
  it("offers the TokenHub catalog on an Xcity deployment", async () => {
    testState.getXcityProviderInfo.mockResolvedValue(XCITY_INFO);
    await renderWizard();

    expect(container!.querySelector('[data-testid="xcity-add-model"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="byok-add-model"]')).toBeNull();
    // The catalog, including models the user hid, is handed to the picker as-is.
    expect(testState.xcityAddModelProps.at(-1)).toMatchObject({
      visible: false,
      catalog: XCITY_INFO.catalog,
    });
    // Wording matches /providers, where the same TokenHub-only choice is presented.
    expect(container!.textContent).toContain("Add model");
    expect(container!.textContent).toContain("No models in your list");
    expect(container!.textContent).toContain("Add a TokenHub model to get started");
  });

  it("keeps the BYOK dialog and its wording when the deployment is not Xcity", async () => {
    await renderWizard();

    expect(container!.querySelector('[data-testid="byok-add-model"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="xcity-add-model"]')).toBeNull();
    expect(container!.textContent).toContain("Add new model...");
    expect(container!.textContent).toContain("No models configured yet");
    expect(container!.textContent).not.toContain("TokenHub");
  });

  it("falls back to BYOK when the provider-info RPC is unavailable", async () => {
    testState.getXcityProviderInfo.mockRejectedValue(new Error("no such method"));
    await renderWizard();

    expect(container!.querySelector('[data-testid="byok-add-model"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="xcity-add-model"]')).toBeNull();
  });
});
