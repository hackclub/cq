import { frequencyGrid, issueFrequencyPattern } from "../internal/cq-internal/src/frequency.js";

export function createInternalFrequency(config, user, session, page) {
  if (!config.internalFrequencyKey || !user || !session || !page.startsWith("/admin")) return null;
  const pattern = issueFrequencyPattern({
    userId: user.id,
    name: user.name,
    page,
    issuedAt: new Date().toISOString(),
    sessionNonce: String(session.id).slice(0, 16),
    privateKey: config.internalFrequencyKey,
  });
  return frequencyGrid(pattern);
}
