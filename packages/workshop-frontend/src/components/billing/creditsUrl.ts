import type { CloudflareUsageInfo } from '@gadgets/workshop-shared/api'

export function isXcityUsage(usage: CloudflareUsageInfo | null | undefined): boolean {
  return usage?.billingMode === 'xcity'
}

export function formatUsageBalance(usage: CloudflareUsageInfo): string | null {
  if (usage.balance === null) return null
  if (isXcityUsage(usage)) return `${(usage.balance / 100).toFixed(1)} KWH`
  return `$${usage.balance.toFixed(2)}`
}

/**
 * Build the top-up URL for the current billing surface. For Cloudflare, when the account id is
 * known we deep-link directly, skipping the dashboard's account picker.
 */
export function buildAddCreditsUrl(
  usage: Pick<CloudflareUsageInfo, 'accountId' | 'billingMode' | 'rechargeUrl'>,
  fallbackXcityHomeUrl?: string,
): string | null {
  if (usage.billingMode === 'xcity') {
    return usage.rechargeUrl ?? fallbackXcityHomeUrl ?? null
  }
  const account = usage.accountId || ':account'
  return `https://dash.cloudflare.com/?to=/${account}/ai/ai-gateway/credits`
}
