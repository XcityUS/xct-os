import { useMemo, useState } from "react";
import { Dialog, Tooltip } from "@cloudflare/kumo";
import {
  ArrowSquareOut,
  CaretDown,
  Check,
  MagnifyingGlass,
  Sparkle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { XcityCatalogAgent } from "@gadgets/workshop-shared/api";
import { safeExternalUrl } from "../../utils/safeExternalUrl";

type XcityAgentPickerProps = {
  agents: XcityCatalogAgent[];
  selectedSlug: string | null;
  personaAvailability: Record<string, boolean | undefined>;
  homeUrl?: string;
  loading?: boolean;
  onSelect: (slug: string | null) => void;
};

function categoryLabel(category: string | undefined): string {
  return category?.trim() || "Uncategorized";
}

function agentSearchText(agent: XcityCatalogAgent): string {
  return [
    agent.displayName,
    agent.name,
    agent.description,
    agent.category,
    ...agent.tags,
    ...agent.skills.flatMap(skill => [skill.name, skill.description, ...skill.tags]),
  ].filter(Boolean).join(" ").toLowerCase();
}

function agentDetailUrl(homeUrl: string | undefined, slug: string): string | undefined {
  if (!homeUrl) return undefined;
  try {
    return safeExternalUrl(new URL(`/agents/${slug}`, homeUrl).toString());
  } catch {
    return safeExternalUrl(`${homeUrl}/agents`);
  }
}

export function XcityAgentPicker({
  agents,
  selectedSlug,
  personaAvailability,
  homeUrl,
  loading = false,
  onSelect,
}: XcityAgentPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const selected = agents.find(agent => agent.slug === selectedSlug) ?? null;
  const selectedPersonaAvailable = selected ? personaAvailability[selected.slug] : undefined;

  const categories = useMemo(() => {
    return [...new Set(agents.map(agent => categoryLabel(agent.category)))]
        .toSorted((a, b) => a.localeCompare(b));
  }, [agents]);

  const filtered = useMemo(() => {
    let normalizedQuery = query.trim().toLowerCase();
    return agents.filter(agent => {
      if (category && categoryLabel(agent.category) !== category) return false;
      if (!normalizedQuery) return true;
      return agentSearchText(agent).includes(normalizedQuery);
    });
  }, [agents, category, query]);

  const choose = (slug: string | null) => {
    onSelect(slug);
    setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group inline-flex h-8 min-w-0 max-w-[190px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] leading-5 tracking-[-0.25px] text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97]"
        aria-label="Select marketplace agent"
      >
        <span className="grid h-4 w-4 flex-shrink-0 place-items-center text-[14px]" aria-hidden="true">
          {selected?.emoji ?? <Sparkle size={14} />}
        </span>
        <span className="min-w-0 truncate">{selected?.displayName ?? "Marketplace"}</span>
        {selected && selectedPersonaAvailable === false && (
          <Tooltip content="Persona unavailable" asChild>
            <WarningCircle size={13} className="flex-shrink-0 text-kumo-warning" />
          </Tooltip>
        )}
        <CaretDown size={12} weight="bold" className="flex-shrink-0 text-kumo-inactive" />
      </button>

      <Dialog
        className="!z-[1200] !w-[min(760px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0"
        size="lg"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[17px] font-medium leading-6 tracking-[-0.35px] text-kumo-default">
              Agent Marketplace
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              {selected ? selected.displayName : "Choose a persona for new chats"}
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <button
                {...props}
                type="button"
                className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand/45"
                aria-label="Close agent marketplace"
              >
                <X size={16} />
              </button>
            )}
          />
        </div>

        <div className="border-b border-kumo-line px-5 py-3">
          <div className="relative">
            <MagnifyingGlass
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search agents"
              className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-control pl-9 pr-3 text-[13px] leading-5 tracking-[-0.2px] text-kumo-default outline-none transition-colors placeholder:text-kumo-inactive focus:border-kumo-brand/50"
            />
          </div>
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5">
            <button
              type="button"
              onClick={() => setCategory(null)}
              className={`h-7 flex-shrink-0 rounded-lg px-2.5 text-[12px] leading-none tracking-[-0.15px] transition-colors ${category === null ? "bg-kumo-brand text-white" : "bg-kumo-tint text-kumo-subtle hover:text-kumo-default"}`}
            >
              All
            </button>
            {categories.map(name => (
              <button
                key={name}
                type="button"
                onClick={() => setCategory(name)}
                className={`h-7 flex-shrink-0 rounded-lg px-2.5 text-[12px] leading-none tracking-[-0.15px] transition-colors ${category === name ? "bg-kumo-brand text-white" : "bg-kumo-tint text-kumo-subtle hover:text-kumo-default"}`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[min(62vh,560px)] overflow-y-auto px-5 py-4">
          <div className="mb-3">
            <button
              type="button"
              onClick={() => choose(null)}
              className="flex w-full items-center gap-3 rounded-lg border border-kumo-line bg-kumo-control px-3 py-2.5 text-left transition-colors hover:bg-kumo-tint/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand/35"
            >
              <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-kumo-tint text-kumo-inactive">
                <Sparkle size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium leading-5 text-kumo-default">
                  No marketplace persona
                </span>
                <span className="block truncate text-[12px] leading-4 text-kumo-subtle">
                  Use the standard coding agent prompt.
                </span>
              </span>
              {selectedSlug === null && <Check size={15} weight="bold" className="text-kumo-inactive" />}
            </button>
          </div>

          {loading ? (
            <div className="py-10 text-center text-[13px] text-kumo-subtle">Loading agents…</div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-kumo-subtle">No agents found</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {filtered.map(agent => {
                const active = selectedSlug === agent.slug;
                const personaAvailable = personaAvailability[agent.slug];
                const detailUrl = agentDetailUrl(homeUrl, agent.slug);
                return (
                  <div
                    key={agent.slug}
                    role="button"
                    tabIndex={0}
                    onClick={() => choose(agent.slug)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      choose(agent.slug);
                    }}
                    className={`group flex min-h-[128px] w-full cursor-pointer flex-col rounded-lg border p-3 text-left transition-[background-color,border-color,transform] duration-150 ease-out hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand/35 ${active ? "border-kumo-brand/60 bg-kumo-brand/8" : "border-kumo-line bg-kumo-control hover:border-kumo-line/90 hover:bg-kumo-tint/60"}`}
                  >
                    <span className="flex min-w-0 items-start gap-2.5">
                      <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-kumo-tint text-[20px]">
                        {agent.emoji ?? <Sparkle size={18} className="text-kumo-inactive" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="min-w-0 truncate text-[13px] font-medium leading-5 text-kumo-default">
                            {agent.displayName}
                          </span>
                          {active && <Check size={13} weight="bold" className="flex-shrink-0 text-kumo-inactive" />}
                        </span>
                        <span className="mt-0.5 inline-flex max-w-full rounded-md bg-kumo-tint px-1.5 py-0.5 text-[10px] font-medium leading-none tracking-[0.02em] text-kumo-subtle">
                          <span className="truncate">{categoryLabel(agent.category)}</span>
                        </span>
                      </span>
                      {detailUrl && (
                        <a
                          href={detailUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand/35"
                          aria-label={`Open ${agent.displayName} in xct-home`}
                        >
                          <ArrowSquareOut size={14} />
                        </a>
                      )}
                    </span>
                    <span className="mt-2 line-clamp-3 text-[12px] leading-[17px] tracking-[-0.15px] text-kumo-subtle">
                      {agent.description || "No description available."}
                    </span>
                    <span className="mt-auto pt-2">
                      {personaAvailable === false ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-kumo-warning/12 px-1.5 py-1 text-[11px] leading-none text-kumo-warning">
                          <WarningCircle size={12} />
                          Persona unavailable
                        </span>
                      ) : personaAvailable === undefined ? (
                        <span className="inline-flex rounded-md bg-kumo-tint px-1.5 py-1 text-[11px] leading-none text-kumo-inactive">
                          Checking persona
                        </span>
                      ) : (
                        <span className="inline-flex rounded-md bg-kumo-success/12 px-1.5 py-1 text-[11px] leading-none text-kumo-success">
                          Persona ready
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
