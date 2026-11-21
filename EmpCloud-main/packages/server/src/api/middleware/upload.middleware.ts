// =============================================================================
// EMP CLOUD — File Upload Middleware (Multer)
// -----------------------------------------------------------------------------
// Uses memoryStorage so uploaded bytes are available as req.file.buffer.
// The route handler is responsible for persisting the buffer via the
// storage adapter (local disk or S3 depending on STORAGE_BACKEND / VERCEL).
//
// Previous behaviour (diskStorage writing to process.cwd()/uploads/…) only
// worked on a traditional long-running server with a writable filesystem.
// Vercel's filesystem is read-only except /tmp, so we must not write to CWD.
// =============================================================================

import multer from "multer";
import { ValidationError } from "../../utils/errors.js";

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function fileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
): void {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ValidationError(
        "Invalid file type. Only PDF, JPEG, PNG, and DOCX files are allowed.",
      ),
    );
  }
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});
