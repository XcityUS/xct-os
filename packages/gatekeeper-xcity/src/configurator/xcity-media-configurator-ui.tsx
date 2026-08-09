import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  XcityMediaConfiguratorRpc,
  XcityMediaConfiguratorValues,
} from "./xcity-media-configurator-types";

export default {
  initial: {},

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.getResourceUrl();
  },

  render() {
    return <Section title="Xcity Media" />;
  },
} satisfies ConfiguratorUISpec<XcityMediaConfiguratorRpc, XcityMediaConfiguratorValues>;
