import { create } from 'zustand'

type Marker = { owner: symbol; count: number }

export const useStudioQuoteReferenceMarkers = create<Record<string, Marker>>(() => ({}))

/** 临时报价状态，随面板卸载或报价变化清理。 */
export function markStudioQuoteReferences(nodeId: string, count: number) {
  const owner = Symbol(nodeId)
  useStudioQuoteReferenceMarkers.setState({ [nodeId]: { owner, count } })
  return () => {
    useStudioQuoteReferenceMarkers.setState(state => {
      if (state[nodeId]?.owner !== owner) return state
      const next = { ...state }
      delete next[nodeId]
      return next
    }, true)
  }
}
