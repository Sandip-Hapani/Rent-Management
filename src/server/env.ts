import { z } from "zod";

/** Hosts whose filesystem is temporary: files must live in the database (or S3). */
const EPHEMERAL_DISK = !!(process.env.VERCEL || process.env.NETLIFY || process.env.RENDER);

/** Public base URL: explicit APP_URL, else the URL the hosting platform provides. */
function platformUrl(): string | undefined {
  const raw = process.env.APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.RENDER_EXTERNAL_URL || (process.env.NETLIFY ? process.env.URL : undefined);
  if (!raw) return undefined;
  return (raw.startsWith("http") ? raw : `https://${raw}`).replace(/\/$/, "");
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DIRECT_URL: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  CRON_SECRET: z.string().min(32).optional(),
  APP_TIMEZONE: z.string().default("Europe/Berlin"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z.string().optional().transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default("Apartment Rent <no-reply@localhost>"),

  STORAGE_DRIVER: z.enum(["local", "s3", "db"]).default(EPHEMERAL_DISK ? "db" : "local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("eu-central-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().optional().transform((v) => v !== "false"),
  /** Send `ServerSideEncryption: AES256` with uploads (AWS S3 / Backblaze). Off for providers that reject it. */
  S3_SSE: z.string().optional().transform((v) => v === "true"),

  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  WORKER_ENABLED: z.string().optional().transform((v) => v !== "false"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Validated environment. Throws a readable error listing every invalid variable. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse({ ...process.env, APP_URL: platformUrl() });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";
