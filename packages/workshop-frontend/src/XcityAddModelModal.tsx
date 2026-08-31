import { useState, useEffect } from 'react'
import { Dialog, Button, useKumoToastManager } from '@cloudflare/kumo'
import { Check, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, XcityCatalogModel } from '@gadgets/workshop-shared/api'

interface XcityAddModelModalProps {
  visible: boolean
  onCancel: () => void
  /** Called after a model was successfully re-added, so the caller can refetch its lists. */
  onAdded: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Full tokenhub catalog with per-model visibility (from XcityProviderInfo). */
  catalog: XcityCatalogModel[]
}

/**
 * Modal for re-adding hidden Xcity TokenHub catalog models to the user's model list. The BYOK
 * AddModelModal counterpart never shows on Xcity deployments — tokenhub is the only model source
 * there, so "adding" a model just flips its per-user visibility back on.
 */
export default function XcityAddModelModal({
  visible,
  onCancel,
  onAdded,
  authenticatedApi,
  catalog,
}: XcityAddModelModalProps) {
  const toasts = useKumoToastManager()
  const [search, setSearch] = useState('')
  const [addingId, setAddingId] = useState<string | null>(null)

  // Reset transient state whenever the dialog closes.
  useEffect(() => {
    if (!visible) {
      setSearch('')
      setAddingId(null)
    }
  }, [visible])

  // Show the whole catalog, not just hidden models: rows already in the list render as "Added",
  // so the dialog doubles as a view of everything TokenHub grants this plan.
  const filtered = catalog.filter((m) => {
    if (!search) return true
    const q = search.toLowerCase()
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
  })

  const handleAdd = async (model: XcityCatalogModel) => {
    if (addingId) return
    setAddingId(model.id)
    try {
      await authenticatedApi.setXcityModelHidden(model.id, false)
      onAdded()
    } catch (err) {
      console.error('Failed to add model:', err)
      toasts.add({ title: 'Failed to add model', variant: 'error' })
    } finally {
      setAddingId(null)
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-1">Add model</Dialog.Title>
        <p className="mb-4 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Every model TokenHub grants your plan. Models you removed from your list can be added
          back here.
        </p>

        {catalog.length === 0 ? (
          // An empty catalog means the user's TokenHub key has no models granted at all —
          // a plan/entitlement problem, not "everything is already added".
          <div className="py-10 text-center text-[13px] leading-[18px] text-kumo-subtle">
            TokenHub hasn't made any models available to your plan yet. Check your plan's
            model list on the Xcity dashboard, or contact an administrator.
          </div>
        ) : (
          <>
            <div className="relative mb-3">
              <MagnifyingGlass
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models…"
                className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[13px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] duration-150 ease-out focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
              />
            </div>

            {filtered.length === 0 ? (
              <div className="py-8 text-center text-[13px] text-kumo-inactive">No models found</div>
            ) : (
              <div className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto">
                {filtered.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-[12px] font-medium text-kumo-subtle">
                      {model.name[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
                        {model.name}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[12px] tracking-[-0.1px] text-kumo-inactive">
                        {model.id}
                      </span>
                    </div>
                    {model.hidden ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={addingId === model.id}
                        disabled={addingId !== null && addingId !== model.id}
                        onClick={() => handleAdd(model)}
                      >
                        <Plus size={13} weight="bold" />
                        Add
                      </Button>
                    ) : (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium tracking-[-0.1px] text-kumo-subtle">
                        <Check size={13} weight="bold" />
                        Added
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-6 flex justify-end">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props}>
              Done
            </Button>
          )} />
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
