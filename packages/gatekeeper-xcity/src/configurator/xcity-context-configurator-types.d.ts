export type XcityContextConfiguratorValues = Record<string, never>;

export interface XcityContextConfiguratorRpc {
  /** Returns the deployment's fixed Xcity context resource URL. */
  getResourceUrl(): Promise<string>;
}
