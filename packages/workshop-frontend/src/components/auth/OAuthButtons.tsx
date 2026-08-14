import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthVendorInfo } from '@gadgets/workshop-shared/api'
import { Button, Banner } from '@cloudflare/kumo'

interface OAuthButtonsProps {
  rpcStub: RpcStub<PublicApi>
  vendors: AuthVendorInfo[]
  onSuccess?: () => void
}

const LOGIN_TIMEOUT_MS = 2 * 60 * 1000

/**
 * Renders a sign-in button per auth-capable gatekeeper vendor. Clicking opens the gatekeeper's
 * OAuth popup (which self-closes) and waits for the result over RPC; on success the session token is
 * stored and the app re-authenticates.
 */
export default function OAuthButtons({ rpcStub, vendors, onSuccess }: OAuthButtonsProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  // Track the pop-up-poll interval, the in-flight login RPC, and mounted state so we can stop a
  // sign-in attempt that's still running if the component unmounts (e.g. the user navigates away
  // mid-login): clear the poller, dispose the RPC (Cap'n Web treats this as a best-effort cancel and
  // frees the client-side pending call), and avoid updating state on an unmounted component.
  const pollRef = useRef<number | null>(null)
  const loginRpcRef = useRef<Disposable | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    // Re-assert on (re)mount: under StrictMode the effect runs mount→cleanup→mount, and the cleanup
    // below sets this false. Without resetting here it would stay false for the component's whole
    // life, causing a successful login result to be silently dropped by the `!mountedRef.current`
    // guards below.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollRef.current !== null) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      if (loginRpcRef.current) {
        try { loginRpcRef.current[Symbol.dispose]() } catch { /* already settled/disposed */ }
        loginRpcRef.current = null
      }
    }
  }, [])

  if (vendors.length === 0) return null

  const start = async (vendorId: string) => {
    setError(null)
    setPending(vendorId)
    // Open synchronously inside the click handler. Opening only after the first await loses the
    // browser's user-activation grant and can look like a stalled authorization on strict browsers.
    // Don't pass "noopener": it makes window.open() return null, so we couldn't distinguish a
    // blocked popup or observe the user closing it.
    const popup = window.open('', 'gatekeeper-login', 'popup,width=520,height=680')
    if (!popup) {
      setError('Pop-up blocked. Please allow pop-ups and try again.')
      setPending(null)
      return
    }
    try {
      const { url, attempt } = await rpcStub.startGatekeeperLogin(vendorId)
      // `attempt` is the capability to receive the session token; track it so we can dispose it
      // (cancelling the wait server-side) if the component unmounts mid-login.
      loginRpcRef.current = attempt as unknown as Disposable
      popup.location.href = url
      // Resolve when the gatekeeper finishes, or reject if the user closes the pop-up first.
      const token = await new Promise<string>((resolve, reject) => {
        let settled = false
        let timeoutId: number | null = null
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null }
          if (timeoutId !== null) clearTimeout(timeoutId)
          // Dispose the attempt stub: cancels the in-flight wait() (e.g. pop-up closed), no-op if it
          // already settled.
          try { (attempt as unknown as Disposable)[Symbol.dispose]() } catch { /* already settled */ }
          loginRpcRef.current = null
          fn()
        }
        pollRef.current = window.setInterval(() => {
          if (popup.closed) finish(() => reject(new Error('Sign-in was cancelled.')))
        }, 500)
        timeoutId = window.setTimeout(() => finish(() => reject(new Error(
          'Sign-in timed out. Please close the authorization window and try again.'))), LOGIN_TIMEOUT_MS)
        attempt.wait()
          .then(t => finish(() => resolve(t)))
          .catch(e => finish(() => reject(e instanceof Error ? e : new Error('Could not sign in'))))
      })
      if (!mountedRef.current) return  // user navigated away mid-flow; drop the result
      localStorage.setItem('authToken', token)
      if (onSuccess) onSuccess()
      else window.location.reload()
    } catch (err) {
      if (!popup.closed) popup.close()
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Could not sign in')
      setPending(null)
    }
  }

  return (
    <div className="space-y-3">
      {error && <Banner variant="error" title={error} />}
      {vendors.map((vendor) => (
        <Button
          key={vendor.vendorId}
          variant="secondary"
          onClick={() => start(vendor.vendorId)}
          loading={pending === vendor.vendorId}
          disabled={pending !== null}
          className="w-full justify-center"
        >
          {vendor.logo && (
            <img
              src={vendor.logo.url}
              alt=""
              className="mr-1"
              style={{ height: 18, width: 'auto' }}
            />
          )}
          Continue with {vendor.displayName}
        </Button>
      ))}
    </div>
  )
}
