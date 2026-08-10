import xcityLogoUrl from '../assets/xcity-logo.svg'

// Default Xcity OS logomark, shown wherever no custom deployment logo is configured.
export default function XcityMark({ size, className }: { size: number; className?: string }) {
  return (
    <img
      src={xcityLogoUrl}
      alt=""
      width={size}
      height={size}
      className={`object-contain ${className ?? ''}`}
    />
  )
}
