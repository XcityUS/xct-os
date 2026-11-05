// Xcity TokenHub provider card for the AI Providers page (seam: routes/providers.tsx renders it
// only when the backend reports Xcity provider info).
import { useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { XcityProviderInfo } from '@gadgets/workshop-shared/api'
import {
  Eye,
  EyeSlash,
  Copy,
  ArrowSquareOut,
  CheckCircle,
  XCircle,
} from '@phosphor-icons/react'
import { useServerConfig } from './ServerConfigContext'

// ─── Xcity TokenHub default-provider card ─────────────────────────────────────

// Small icon button matching the kebab-trigger treatment used by ModelRow.
const ICON_BTN =
  'cursor-pointer rounded-md p-1.5 text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default'

// ─── Xcity hop-by-hop diagnostics ─────────────────────────────────────────────

// Shown only when the tokenhub model list came back empty: one row per hop of
// identity → wallet key mint → tokenhub catalog, so the failing step is visible at a glance
// instead of being buried in worker logs.
type XcityDiagnostics = NonNullable<XcityProviderInfo['diagnostics']>

type HopStatus = { ok: boolean; detail: string }

function identityHop(diag: XcityDiagnostics): HopStatus {
  return diag.identity
    ? { ok: true, detail: 'connected' }
    : { ok: false, detail: 'not stored — sign out and sign in again via Xcity' }
}

function walletKeyHop(diag: XcityDiagnostics): HopStatus {
  if (diag.keyPresent) return { ok: true, detail: 'present' }

  const mint = diag.keyMint
  if (!mint?.attempted) {
    return {
      ok: false,
      detail: diag.identity ? 'no key and no mint attempted' : 'no identity to mint a key for',
    }
  }
  if (mint.error === 'network-error' || mint.error === 'timeout') {
    return { ok: false, detail: 'mint failed: wallet unreachable' }
  }
  if (mint.status === 401 || mint.status === 403) {
    return {
      ok: false,
      detail: `mint failed: HTTP ${mint.status} — check WALLET_SERVICE_TOKEN on the workshop worker`,
    }
  }
  if (mint.error === 'malformed-response') {
    return { ok: false, detail: 'mint failed: unexpected wallet response' }
  }
  if (mint.status !== undefined && mint.status >= 500) {
    return { ok: false, detail: `mint failed: wallet error HTTP ${mint.status}` }
  }
  return {
    ok: false,
    detail: mint.status !== undefined ? `mint failed: HTTP ${mint.status}` : 'mint failed',
  }
}

function catalogHop(diag: XcityDiagnostics, allHidden: boolean): HopStatus {
  const catalog = diag.catalog
  if (!catalog) return { ok: false, detail: 'not reached — no wallet key to query TokenHub with' }

  if (catalog.error === 'network-error' || catalog.error === 'timeout') {
    return { ok: false, detail: 'TokenHub unreachable' }
  }
  if (catalog.error === 'malformed-response') {
    return { ok: false, detail: 'unexpected catalog response' }
  }
  if (catalog.status !== undefined && catalog.status !== 200) {
    return {
      ok: false,
      detail:
        catalog.status === 401 || catalog.status === 403
          ? `HTTP ${catalog.status} — TokenHub rejected the wallet key`
          : `catalog failed: HTTP ${catalog.status}`,
    }
  }
  // A catalog of nothing but LiteLLM grant markers (`*`, `all-proxy-models`, …) is a key
  // provisioning failure, not an empty plan — call it out separately so an operator fixes the
  // wallet's key mint instead of hunting through plan-params.
  if (catalog.grantNotExpanded) {
    return {
      ok: false,
      detail:
        "the gateway returned only a wildcard placeholder — the key's model grant was not " +
        "expanded (the wallet must grant 'all-proxy-models')",
    }
  }
  if (!catalog.modelCount) {
    return {
      ok: false,
      detail: "key has no models granted — set the plan's model list (admin plan-params)",
    }
  }

  const stale = catalog.servedStale ? ', cached' : ''
  const hidden = allHidden ? ' — all hidden from your list' : ''
  return { ok: true, detail: `${catalog.modelCount} models${stale}${hidden}` }
}

function XcityDiagnosticRow({ label, status }: { label: string; status: HopStatus }) {
  return (
    <div className="flex items-start gap-2">
      {status.ok ? (
        <CheckCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-kumo-success" />
      ) : (
        <XCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-kumo-danger" />
      )}
      <span className="shrink-0 font-medium text-kumo-default">{label}</span>
      <span className={`min-w-0 ${status.ok ? 'text-kumo-subtle' : 'text-kumo-danger'}`}>
        {status.detail}
      </span>
    </div>
  )
}

function XcityDiagnostics({ info }: { info: XcityProviderInfo }) {
  const diag = info.diagnostics
  // Older backends don't report diagnostics; say nothing rather than guessing.
  if (!diag) return null

  const allHidden = info.catalog.length > 0 && info.modelIds.length === 0
  return (
    <div className="mt-2.5 ml-12 flex flex-col gap-1 rounded-lg border border-kumo-line bg-kumo-tint px-3 py-2.5 text-[12px] leading-[17px] tracking-[-0.1px]">
      <XcityDiagnosticRow label="Xcity identity" status={identityHop(diag)} />
      <XcityDiagnosticRow label="Wallet key" status={walletKeyHop(diag)} />
      <XcityDiagnosticRow label="TokenHub catalog" status={catalogHop(diag, allHidden)} />
    </div>
  )
}

export default function XcityProviderCard({ info }: { info: XcityProviderInfo }) {
  const toasts = useKumoToastManager()
  const xcityHomeUrl = useServerConfig()?.xcityHomeUrl
  const [keyVisible, setKeyVisible] = useState(false)

  const copyKey = async () => {
    if (!info.apiKey) return
    try {
      await navigator.clipboard.writeText(info.apiKey)
      toasts.add({ title: 'API key copied' })
    } catch (err) {
      console.error('Failed to copy API key:', err)
      toasts.add({ title: 'Failed to copy API key', variant: 'error' })
    }
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      {/* Row 1: identity */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-[12px] font-medium text-kumo-subtle">
          X
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
            Xcity TokenHub
          </span>
          <span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle">
            default
          </span>
        </div>
        {xcityHomeUrl && (
          <a
            href={`${xcityHomeUrl}/dashboard`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[13px] tracking-[-0.25px] text-kumo-brand hover:underline"
          >
            Manage in dashboard
            <ArrowSquareOut size={13} />
          </a>
        )}
      </div>

      {/* Row 2: connection details */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-12 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
        {info.email && <span className="truncate">Connected as {info.email}</span>}
        <span>{info.modelIds.length} models from TokenHub</span>
      </div>

      {/* Row 3: API key */}
      {info.apiKey && (
        <div className="mt-2 flex items-center gap-2 pl-12">
          <span className="shrink-0 text-[13px] tracking-[-0.25px] text-kumo-subtle">API key</span>
          <span className="min-w-0 truncate font-mono text-[12px] tracking-[-0.1px] text-kumo-default">
            {keyVisible ? info.apiKey : `sk-…${info.apiKey.slice(-4)}`}
          </span>
          <button
            type="button"
            aria-label={keyVisible ? 'Hide API key' : 'Reveal API key'}
            onClick={() => setKeyVisible((v) => !v)}
            className={ICON_BTN}
          >
            {keyVisible ? <EyeSlash size={14} /> : <Eye size={14} />}
          </button>
          <button type="button" aria-label="Copy API key" onClick={copyKey} className={ICON_BTN}>
            <Copy size={14} />
          </button>
        </div>
      )}

      {/* Row 4: why the list is empty — only when it is */}
      {info.modelIds.length === 0 && <XcityDiagnostics info={info} />}
    </div>
  )
}
