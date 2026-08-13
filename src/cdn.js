const uploadEndpoint = "https://cdn.hackclub.com/api/v4/upload";

export function createCdnClient(config, fetchImpl = fetch) {
  const configured = () => Boolean(config.hackClubCdnApiKey);

  return {
    configured,
    async upload(file) {
      if (!configured()) throw new Error("Image uploads are not configured.");
      const form = new FormData();
      form.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);
      const response = await fetchImpl(uploadEndpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.hackClubCdnApiKey}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.url) {
        throw new Error(String(body.error || `The image host returned status ${response.status}.`));
      }
      return {
        id: String(body.id || ""),
        url: String(body.url),
        filename: String(body.filename || file.originalname),
      };
    },
  };
}
