// =============================================================================
// EMP CLOUD — File Storage Adapter
// -----------------------------------------------------------------------------
// Provides a uniform interface for storing and retrieving uploaded files.
//
// Two backends, selected at runtime:
//
//   LOCAL  — writes to `<cwd>/uploads/…` (default; works in dev and traditional
//             long-running deployments).  Zero new dependencies or env vars.
//
//   S3     — streams files to any S3-compatible bucket (AWS S3, Cloudflare R2).
//             Activated when STORAGE_BACKEND=s3 (or when VERCEL is set and
//             STORAGE_BACKEND is not explicitly "local").
//
// The backend is chosen ONCE at module-import time and cached, so there is no
// per-request branching overhead.
//
// Environment variables (S3 backend only):
//
//   STORAGE_BACKEND        s3 | local   (default: local; auto-s3 on Vercel)
//   STORAGE_S3_BUCKET      bucket name
//   STORAGE_S3_REGION      e.g. auto (R2) or us-east-1 (AWS)
//   STORAGE_S3_ENDPOINT    full endpoint URL for Cloudflare R2 / custom S3
//                          (omit for standard AWS S3 — it is auto-derived)
//   STORAGE_S3_ACCESS_KEY  access key id
//   STORAGE_S3_SECRET_KEY  secret access key
//   STORAGE_S3_PUBLIC_URL  optional: CDN / public base URL for public files
//                          e.g. https://cdn.example.com
//                          Used for public (photo) assets — omit to use signed URLs.
//   STORAGE_SIGNED_URL_EXPIRY_SECONDS   default 3600 (1 hour)
// =============================================================================

import path from "node:path";
import fs from "node:fs";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StorageUploadInput {
  /** Destination key inside the bucket / relative path under uploads/. */
  key: string;
  /** Raw file bytes (from multer memoryStorage). */
  buffer: Buffer;
  /** MIME type, e.g. application/pdf */
  mimeType: string;
  /** Original file name for Content-Disposition. */
  originalName: string;
}

export interface StorageFile {
  /**
   * The canonical reference stored in the database.
   * LOCAL  → relative path, e.g. "uploads/documents/1/2/1234567890-abc.pdf"
   * S3     → S3 object key,  e.g. "uploads/documents/1/2/1234567890-abc.pdf"
   * Both are intentionally the same path shape so the column can be migrated
   * without a data transformation.
   */
  storageKey: string;
  /** Public or signed URL clients can use to download the file. */
  url: string;
  /** Size in bytes. */
  size: number;
}

export interface StorageAdapter {
  /**
   * Store a file and return its canonical storage key and a download URL.
   */
  upload(input: StorageUploadInput): Promise<StorageFile>;

  /**
   * Generate a temporary download URL for an existing file.
   * LOCAL  → returns the /api/v1/… download route URL (served by Express).
   * S3     → returns a pre-signed S3 URL.
   */
  getDownloadUrl(storageKey: string, expiresInSeconds?: number): Promise<string>;

  /**
   * Delete a stored file.  Best-effort — does not throw if the file is missing.
   */
  delete(storageKey: string): Promise<void>;

  /** Whether this adapter uses remote object storage. */
  readonly isRemote: boolean;
}

// ---------------------------------------------------------------------------
// Local filesystem adapter
// ---------------------------------------------------------------------------

class LocalStorageAdapter implements StorageAdapter {
  readonly isRemote = false;

  async upload(input: StorageUploadInput): Promise<StorageFile> {
    const absolutePath = path.resolve(process.cwd(), input.key);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, input.buffer);
    return {
      storageKey: input.key,
      // The download URL is served by the Express download route —
      // the route reconstructs the absolute path from the key.
      url: `/api/v1/documents/download-by-key?key=${encodeURIComponent(input.key)}`,
      size: input.buffer.length,
    };
  }

  async getDownloadUrl(storageKey: string, _expiresInSeconds?: number): Promise<string> {
    // Local: the caller route handles serving the file; return the internal path.
    return storageKey;
  }

  async delete(storageKey: string): Promise<void> {
    const absolutePath = path.resolve(process.cwd(), storageKey);
    try {
      fs.unlinkSync(absolutePath);
    } catch {
      // File already gone — not an error
    }
  }
}

// ---------------------------------------------------------------------------
// S3-compatible adapter (AWS S3 / Cloudflare R2)
// ---------------------------------------------------------------------------

class S3StorageAdapter implements StorageAdapter {
  readonly isRemote = true;

  private bucket: string;
  private region: string;
  private endpoint: string | undefined;
  private accessKey: string;
  private secretKey: string;
  private publicBaseUrl: string | null;
  private signedUrlExpiry: number;

  constructor() {
    this.bucket = process.env.STORAGE_S3_BUCKET ?? "";
    this.publicBaseUrl = process.env.STORAGE_S3_PUBLIC_URL ?? null;
    this.signedUrlExpiry = parseInt(
      process.env.STORAGE_SIGNED_URL_EXPIRY_SECONDS ?? "3600",
      10,
    );

    if (!this.bucket) {
      throw new Error(
        "STORAGE_S3_BUCKET is required when STORAGE_BACKEND=s3. " +
        "Set it in your Vercel environment variables.",
      );
    }

    this.accessKey = process.env.STORAGE_S3_ACCESS_KEY ?? "";
    this.secretKey = process.env.STORAGE_S3_SECRET_KEY ?? "";
    this.region = process.env.STORAGE_S3_REGION ?? "auto";
    this.endpoint = process.env.STORAGE_S3_ENDPOINT;

    if (!this.accessKey || !this.secretKey) {
      throw new Error(
        "STORAGE_S3_ACCESS_KEY and STORAGE_S3_SECRET_KEY are required when STORAGE_BACKEND=s3.",
      );
    }

    logger.info(`S3 storage adapter configured (bucket: ${this.bucket}, region: ${this.region})`);
  }

  /** Create an S3Client on demand — the constructor is synchronous so no race condition. */
  private async getClient(): Promise<import("@aws-sdk/client-s3").S3Client> {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      credentials: { accessKeyId: this.accessKey, secretAccessKey: this.secretKey },
      // Required for Cloudflare R2 (path-style) and some custom S3 endpoints.
      forcePathStyle: !!this.endpoint,
    });
  }

  async upload(input: StorageUploadInput): Promise<StorageFile> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.buffer,
        ContentType: input.mimeType,
        ContentDisposition: `attachment; filename="${encodeURIComponent(input.originalName)}"`,
      }),
    );

    const url = this.publicBaseUrl
      ? `${this.publicBaseUrl.replace(/\/+$/, "")}/${input.key}`
      : await this.getDownloadUrl(input.key);

    return { storageKey: input.key, url, size: input.buffer.length };
  }

  async getDownloadUrl(storageKey: string, expiresInSeconds?: number): Promise<string> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = await this.getClient();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      { expiresIn: expiresInSeconds ?? this.signedUrlExpiry },
    );
  }

  async delete(storageKey: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.getClient();
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
    } catch (err) {
      logger.warn("S3 delete failed (best-effort)", {
        key: storageKey,
        error: (err as Error).message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

function resolveBackend(): "local" | "s3" {
  const explicit = (process.env.STORAGE_BACKEND ?? "").toLowerCase();
  if (explicit === "s3") return "s3";
  if (explicit === "local") return "local";
  // Auto-detect: use S3 on Vercel unless the operator explicitly chose local.
  if (process.env.VERCEL) return "s3";
  return "local";
}

let _adapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (_adapter) return _adapter;
  const backend = resolveBackend();
  if (backend === "s3") {
    _adapter = new S3StorageAdapter();
    logger.info("File storage backend: S3");
  } else {
    _adapter = new LocalStorageAdapter();
    logger.info("File storage backend: local disk");
  }
  return _adapter;
}

/** Reset the adapter singleton — for tests. */
export function resetStorageAdapter(): void {
  _adapter = null;
}

// ---------------------------------------------------------------------------
// Key generation helpers — same path shapes for both backends
// ---------------------------------------------------------------------------

export function documentKey(orgId: number, userId: number, originalName: string): string {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const ext = path.extname(originalName);
  return `uploads/documents/${orgId}/${userId}/${uniqueSuffix}${ext}`;
}

export function photoKey(orgId: number, originalName: string): string {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const ext = path.extname(originalName);
  return `uploads/photos/${orgId}/${uniqueSuffix}${ext}`;
}
