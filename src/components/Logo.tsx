export function Logo({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="sl-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset=".5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#sl-logo)" />
      <path
        d="M18 17c6 0 8 4 14 4s8-4 14-4"
        fill="none"
        stroke="#fff"
        strokeOpacity=".55"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M32 28v17m-9-9 9 9 9-9"
        fill="none"
        stroke="#fff"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
