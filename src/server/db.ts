import { PrismaClient, type Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

/** Serializable transactions for money-moving operations (retried once on serialization conflicts). */
export async function moneyTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: "Serializable", timeout: 20_000 });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (attempt < 2 && (code === "P2034" || code === "40001")) continue;
      throw e;
    }
  }
}
