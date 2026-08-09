import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Xcity gatekeeper. */
export type XcityObservabilityFields = {
  path: string;
  status: number;
  statusText: string;
  vendorId: string;
  mediaId: string;
  providerJobId: string;
};

/** Ambient observability fields for one Xcity gatekeeper operation. */
export const obsContext = createObservabilityContext<XcityObservabilityFields>();
