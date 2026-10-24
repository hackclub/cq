const DAY_MS = 86_400_000;
export const ANALYTICS_RANGES = [7, 30, 60, 90, 180];

const time = (value) => {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};
const sum = (items, select) => items.reduce((total, item) => total + (Number(select(item)) || 0), 0);
const pct = (value, total) => total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
const isInRange = (value, since) => time(value) >= since;
const dateKey = (value) => new Date(value).toISOString().slice(0, 10);

function dayKeys(days, now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => dateKey(today - (days - index - 1) * DAY_MS));
}

function series(keys, items, selectDate) {
  const counts = new Map(keys.map((key) => [key, 0]));
  for (const item of items) {
    const value = selectDate(item);
    if (!value) continue;
    const key = dateKey(value);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }
  return keys.map((date) => ({ date, count: counts.get(date) }));
}

function buckets(values) {
  return {
    none: values.filter((value) => value === 0).length,
    under5: values.filter((value) => value > 0 && value < 5).length,
    from5to10: values.filter((value) => value >= 5 && value < 10).length,
    from10to25: values.filter((value) => value >= 10 && value < 25).length,
    over25: values.filter((value) => value >= 25).length,
  };
}

export function buildAnalytics(records, days, now = new Date()) {
  const keys = dayKeys(days, now);
  const since = time(`${keys[0]}T00:00:00.000Z`);
  const today = keys.at(-1);
  const { users, projects, journals, submissions, orders, products, ledgers, activities, fundingRequests } = records;
  const participantUsers = users.filter((user) => !user.mergedIntoUserId);
  const participantIds = new Set(participantUsers.map((user) => user.id));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const journalsByUser = new Map();
  for (const journal of journals) {
    const userId = projectById.get(journal.projectId)?.userId;
    if (!userId) continue;
    if (!journalsByUser.has(userId)) journalsByUser.set(userId, []);
    journalsByUser.get(userId).push(journal);
  }
  const activeUserIds = new Set(journals.filter((journal) => isInRange(journal.createdAt || journal.entryDate, since)).map((journal) => projectById.get(journal.projectId)?.userId).filter(Boolean));
  const activeTodayIds = new Set(journals.filter((journal) => dateKey(journal.createdAt || `${journal.entryDate}T00:00:00Z`) === today).map((journal) => projectById.get(journal.projectId)?.userId).filter(Boolean));
  const activeSeries = keys.map((date) => ({ date, count: new Set(journals.filter((journal) => dateKey(journal.createdAt || `${journal.entryDate}T00:00:00Z`) === date).map((journal) => projectById.get(journal.projectId)?.userId).filter(Boolean)).size }));
  const visitorSeries = keys.map((date) => ({ date, count: new Set(activities.filter((activity) => activity.day === date).map((activity) => activity.userId)).size }));
  const rangeVisitors = new Set(activities.filter((activity) => isInRange(activity.lastSeenAt || activity.createdAt, since)).map((activity) => activity.userId));
  const nowCutoff = now.getTime() - 10 * 60_000;
  const latestActivity = activities.reduce((map, activity) => {
    if (time(activity.lastSeenAt) > time(map.get(activity.userId)?.lastSeenAt)) map.set(activity.userId, activity);
    return map;
  }, new Map());
  const verified = participantUsers.filter((user) => user.verificationStatus === "verified" || user.yswsEligible === true).length;
  const eligible = participantUsers.filter((user) => user.yswsEligible !== false).length;
  const organizers = participantUsers.filter((user) => (user.roles || [user.role]).some((role) => role && role !== "participant")).length;
  const submittedProjects = new Set(submissions.map((submission) => submission.projectId));
  const approvedSubmissions = submissions.filter((submission) => submission.decision === "approved");
  const approvedProjects = new Set(approvedSubmissions.map((submission) => submission.projectId));
  const buyerIds = new Set(orders.filter((order) => order.status !== "cancelled").map((order) => order.userId));
  const funnel = [
    ["Signed up", participantUsers.length], ["Verified and eligible", verified],
    ["Started a project", new Set(projects.map((project) => project.userId)).size],
    ["Posted a devlog", journalsByUser.size], ["Submitted a project", new Set([...submittedProjects].map((id) => projectById.get(id)?.userId).filter(Boolean)).size],
    ["Got a project approved", new Set([...approvedProjects].map((id) => projectById.get(id)?.userId).filter(Boolean)).size],
    ["Bought something", buyerIds.size],
  ].map(([label, count], index, all) => ({ label, count, pctOfSignups: pct(count, participantUsers.length), pctOfPrevious: index ? pct(count, all[index - 1][1]) : null }));
  const statusCounts = Object.entries(projects.reduce((counts, project) => ({ ...counts, [project.status || "unknown"]: (counts[project.status || "unknown"] || 0) + 1 }), {})).map(([status, count]) => ({ status, count }));
  const decided = submissions.filter((submission) => submission.decision);
  const decidedRange = decided.filter((submission) => isInRange(submission.review?.reviewed_at || submission.updatedAt, since));
  const pending = submissions.filter((submission) => !submission.decision && !["withdrawn", "error"].includes(submission.phase));
  const decisionSeconds = decidedRange.map((submission) => (time(submission.review?.reviewed_at || submission.updatedAt) - time(submission.createdAt)) / 1000).filter((value) => value >= 0);
  const approvedHours = (submission) => Number(submission.review?.approved_hours) || Number(submission.review?.approved_minutes) / 60 || 0;
  const approvedHoursAll = sum(approvedSubmissions, approvedHours);
  const earnedAll = sum(ledgers.filter((ledger) => Number(ledger.delta) > 0), (ledger) => ledger.delta);
  const spentOrders = orders.filter((order) => order.status !== "cancelled");
  const spentAll = sum(spentOrders, (order) => order.total);
  const topItems = new Map();
  for (const order of spentOrders) for (const item of order.items || []) {
    const row = topItems.get(item.productId || item.id) || { name: item.name || products.find((product) => product.id === (item.productId || item.id))?.name || "Unknown item", unitsSold: 0, hertzSpent: 0 };
    row.unitsSold += Number(item.quantity) || 0;
    row.hertzSpent += (Number(item.price) || 0) * (Number(item.quantity) || 0);
    topItems.set(item.productId || item.id, row);
  }
  const countryCounts = [...participantUsers.reduce((map, user) => map.set(user.addressCountry || "Not supplied", (map.get(user.addressCountry || "Not supplied") || 0) + 1), new Map())].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  const approvedHoursByUser = participantUsers.map((user) => sum(approvedSubmissions.filter((submission) => projectById.get(submission.projectId)?.userId === user.id), approvedHours));
  return {
    range: { days, since: keys[0], trackingSince: activities.map((item) => item.createdAt || item.lastSeenAt).sort()[0] || null },
    activity: { activeToday: activeTodayIds.size, activeInRange: activeUserIds.size, avgDau: Math.round(sum(activeSeries, (row) => row.count) / days * 10) / 10, totalUsers: participantUsers.length, perDay: activeSeries },
    visitors: { now: [...latestActivity.values()].filter((activity) => time(activity.lastSeenAt) >= nowCutoff).length, today: visitorSeries.at(-1).count, inRange: rangeVisitors.size, avgPerDay: Math.round(sum(visitorSeries, (row) => row.count) / days * 10) / 10, perDay: visitorSeries },
    participation: { signupsInRange: participantUsers.filter((user) => isInRange(user.createdAt, since)).length, signupsPerDay: series(keys, participantUsers, (user) => user.createdAt), verified, eligible, notEligible: participantUsers.length - eligible, organizers, countries: countryCounts },
    funnel,
    projects: { byStatus: statusCounts, createdInRange: projects.filter((project) => isInRange(project.createdAt, since)).length, devlogsInRange: journals.filter((journal) => isInRange(journal.createdAt, since)).length, totalLoggedHours: sum(journals, (journal) => journal.minutes) / 60, loggedHoursInRange: sum(journals.filter((journal) => isInRange(journal.createdAt, since)), (journal) => journal.minutes) / 60, submittedPerDay: series(keys, submissions, (submission) => submission.createdAt), builderBuckets: buckets(approvedHoursByUser) },
    review: { pendingNow: pending.length, oldestPendingSeconds: pending.length ? (now.getTime() - Math.min(...pending.map((item) => time(item.createdAt)))) / 1000 : null, submittedInRange: submissions.filter((item) => isInRange(item.createdAt, since)).length, decidedInRange: decidedRange.length, approvedInRange: decidedRange.filter((item) => item.decision === "approved").length, changesInRange: decidedRange.filter((item) => item.decision === "changes").length, rejectedInRange: decidedRange.filter((item) => item.decision === "rejected").length, avgDecisionSeconds: decisionSeconds.length ? sum(decisionSeconds, (value) => value) / decisionSeconds.length : null, approvalRate: pct(decided.filter((item) => item.decision === "approved").length, decided.length), approvedHoursAll, approvedHoursInRange: sum(decidedRange.filter((item) => item.decision === "approved"), approvedHours) },
    economy: { earnedAll, earnedInRange: sum(ledgers.filter((ledger) => Number(ledger.delta) > 0 && isInRange(ledger.createdAt, since)), (ledger) => ledger.delta), spentAll, spentInRange: sum(spentOrders.filter((order) => isInRange(order.createdAt, since)), (order) => order.total), outstanding: sum(participantUsers, (user) => user.hertz), totalOrders: spentOrders.length, ordersInRange: spentOrders.filter((order) => isInRange(order.createdAt, since)).length, buyers: buyerIds.size, ordersPerDay: series(keys, spentOrders, (order) => order.createdAt), topHolders: [...participantUsers].sort((a, b) => Number(b.hertz) - Number(a.hertz)).slice(0, 5).map((user) => ({ name: user.name, balance: Number(user.hertz) || 0 })), topItems: [...topItems.values()].sort((a, b) => b.unitsSold - a.unitsSold).slice(0, 5) },
    funding: { pending: fundingRequests.filter((request) => ["submitted", "under_review", "second_pass"].includes(request.status)).length, approvedInRange: fundingRequests.filter((request) => ["approved", "issued"].includes(request.status) && isInRange(request.updatedAt, since)).length, issuedAll: fundingRequests.filter((request) => request.status === "issued").length, requestedHertz: sum(fundingRequests, (request) => request.requestedHertz), approvedHertz: sum(fundingRequests, (request) => request.approvedHertz || request.firstPass?.approvedHertz) },
    inventory: { activeProducts: products.filter((product) => product.active !== false).length, unitsInStock: sum(products, (product) => product.stock), lowStock: products.filter((product) => product.active !== false && Number(product.stock) <= 10).length },
  };
}
