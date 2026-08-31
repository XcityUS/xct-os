// Per-user visibility of Xcity TokenHub catalog models. Hiding a model only removes it from the
// user's model list (listModels / the /providers page); resolution paths stay unfiltered so chats
// that already use a hidden model keep working, and a hidden model can be re-added at any time.

import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "../observability.js";

const logger = createWorkshopLogger("workshop.xcity.model-visibility");

/**
 * Return the tokenhub catalog models that are visible to the user (i.e. not in
 * `hiddenModelIds`). Used by listModels(); resolution paths must NOT go through this filter.
 */
export function filterVisibleXcityModels(
    models: readonly AiChatAuthorInfo[],
    hiddenModelIds: readonly string[],
): AiChatAuthorInfo[] {
  let hidden = new Set(hiddenModelIds);
  return models.filter(model => !hidden.has(model.id));
}

/**
 * Compute the new hidden-model-id list after showing or hiding `modelId`. Idempotent: hiding an
 * already-hidden model or showing an already-visible one returns an equivalent list. Ids not in
 * `catalogModelIds` (the current tokenhub catalog) are ignored with a warning, leaving the list
 * unchanged.
 */
export function toggleXcityHiddenModelId(
    hiddenModelIds: readonly string[],
    catalogModelIds: ReadonlySet<string>,
    modelId: string,
    hidden: boolean,
): string[] {
  if (!catalogModelIds.has(modelId)) {
    logger.warn("ignoring visibility toggle for a model not in the tokenhub catalog", {
      event: "xcity.model.visibility.unknown", modelId,
    });
    return [...hiddenModelIds];
  }

  let next = hiddenModelIds.filter(id => id !== modelId);
  if (hidden) next.push(modelId);
  return next;
}
