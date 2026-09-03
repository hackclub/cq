import crypto from "node:crypto";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

function extension(file) {
  const candidate = path.extname(String(file.originalname || "")).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(candidate)) return candidate;
  return { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }[file.mimetype] || ".bin";
}

/** R2 uses the S3 API; uploaded files are served through CQ's custom domain. */
export function createCdnClient(config, client = null) {
  const configured = () => Boolean(config.r2Endpoint && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2BucketName && config.r2PublicBaseUrl);
  const s3 = client ?? (configured() ? new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey },
  }) : null);

  return {
    configured,
    async upload(file) {
      if (!configured() || !s3) throw new Error("Image uploads are not configured.");
      const key = `uploads/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension(file)}`;
      await s3.send(new PutObjectCommand({
        Bucket: config.r2BucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: "public, max-age=31536000, immutable",
      }));
      return { id: key, url: `${config.r2PublicBaseUrl}/${key}`, filename: String(file.originalname || key) };
    },
  };
}
