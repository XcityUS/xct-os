import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Xcity gatekeeper. */
export type XcityObservabilityFields = {
  path: string;
  status: number;
  statusText: string;
  vendorId: string;
  mediaId: string;
  providerJobId: string;
  /** How an xcity-media Worker call was sent: the `XCITY_MEDIA` service binding or a public-URL fetch. */
  transport: "service-binding" | "fetch";
};

/** Ambient observability fields for one Xcity gatekeeper operation. */
export const obsContext = createObservabilityContext<XcityObservabilityFields>();
