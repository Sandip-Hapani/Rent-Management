import { config } from "dotenv";

config({ quiet: true });

// Integration tests always run against the disposable test database, never the dev database.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
}
process.env.APP_URL ??= "http://localhost:3000";
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR = "./storage-test";
