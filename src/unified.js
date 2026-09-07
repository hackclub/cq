function hoursText(minutes) {
  return (Math.round((Math.max(0, Number(minutes) || 0) / 60) * 100) / 100).toFixed(2);
}

export function submissionMinutes(submission) {
  const journals = Array.isArray(submission.journalSnapshots)
    ? submission.journalSnapshots
    : Array.isArray(submission.payload?.journals)
      ? submission.payload.journals
      : [];
  return Math.round(journals.reduce((sum, journal) => sum + Math.max(0, Number(journal.minutes) || 0), 0));
}

export function finalizeUnifiedFields(submission, { decision, claimedMinutes, approvedMinutes, technicalNote = "", timeNote = "" }) {
  const approved = decision === "approved";
  const claimedHours = hoursText(claimedMinutes);
  const approvedHours = hoursText(approvedMinutes);
  const reviewStatus = approved
    ? "Approved — ready for Unified"
    : decision === "changes"
      ? "Changes requested — not ready for Unified"
      : "Rejected — do not submit to Unified";
  const justification = approved
    ? [
      "CQ two-pass review completed.",
      `Claimed hours: ${claimedHours}.`,
      `Approved hours: ${approvedHours}.`,
      approvedMinutes < claimedMinutes ? `Deflation reason: ${timeNote || technicalNote}.` : `Review basis: ${technicalNote || timeNote}.`,
      submission.projectSnapshot?.isUpdate ? "This is an update; only the new work in this submission was approved." : "",
    ].filter(Boolean).join(" ")
    : "";
  return {
    ...(submission.airtableFields || {}),
    "Claimed Hours": claimedHours,
    "Override Hours Spent": approved ? approvedHours : "",
    "Override hours spent justification": justification,
    "Approved Hours": approved ? approvedHours : "",
    "Review Status": reviewStatus,
  };
}
