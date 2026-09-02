import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ActionState, Overseer } from '@gadgets/workshop-shared/api'

type ActionDecision = 'approve' | 'deny'

/**
 * Server-side failures reach us as an opaque RPC error, and the message is the only clue the user
 * gets — a bare "Failed to approve action" sent people to the code to find out what broke. Show the
 * message as the toast's description, but only when it reads like a sentence: collapse it to its
 * first line so a stack trace does not fill the viewport, cap the length, and drop values that carry
 * no information (empty strings, a bare `Error`, `[object Object]`) so the toast degrades to the
 * title alone.
 */
function errorDetail(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const firstLine = raw.split('\n')[0].trim().replace(/\s+/g, ' ')
  if (!firstLine || firstLine === 'Error' || firstLine.startsWith('[object ')) return undefined
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine
}

export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  onResolved?: (actionId: number, state: Extract<ActionState, 'approved' | 'rejected'>) => void,
) {
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  return useCallback(async (actionId: number, decision: ActionDecision) => {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      if (decision === 'approve') await overseer.approveAction(actionId)
      else await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, decision === 'approve' ? 'approved' : 'rejected')
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      const detail = errorDetail(error)
      toasts.add({
        title: `Failed to ${decision} action`,
        ...(detail ? { description: detail } : {}),
        variant: 'error',
      })
    } finally {
      setProcessing(previous => {
        const next = new Set(previous)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessing, toasts])
}
