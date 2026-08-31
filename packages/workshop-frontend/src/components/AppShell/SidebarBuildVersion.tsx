/**
 * Build stamp under the sidebar's utility strip: the UTC build date and the CI build counter,
 * with the source revision in the hover title. The deployment pipeline injects the values at
 * build time; local dev builds carry none, so the line renders nothing there.
 */
export default function SidebarBuildVersion({ collapsed }: { collapsed: boolean }) {
  const date = import.meta.env.VITE_BUILD_DATE
  const build = import.meta.env.VITE_BUILD_NUMBER
  const commit = import.meta.env.VITE_BUILD_COMMIT
  if (!date || collapsed) return null

  return (
    <div
      className="shrink-0 select-none px-3 pb-1.5 text-center text-[10px] leading-4 text-kumo-inactive"
      title={commit ? `Revision ${commit}` : undefined}
    >
      v{date}
      {build ? ` · build ${build}` : ''}
    </div>
  )
}
