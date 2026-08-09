export type XcityMediaConfiguratorValues = Record<string, never>;

export interface XcityMediaConfiguratorRpc {
  /** Returns the deployment's fixed Xcity media resource URL. */
  getResourceUrl(): Promise<string>;
}
