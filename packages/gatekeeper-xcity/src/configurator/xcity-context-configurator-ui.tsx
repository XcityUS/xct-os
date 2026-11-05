import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  XcityContextConfiguratorRpc,
  XcityContextConfiguratorValues,
} from "./xcity-context-configurator-types";

export default {
  initial: {},

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.getResourceUrl();
  },

  render() {
    return <Section title="Xcity Context" />;
  },
} satisfies ConfiguratorUISpec<XcityContextConfiguratorRpc, XcityContextConfiguratorValues>;
