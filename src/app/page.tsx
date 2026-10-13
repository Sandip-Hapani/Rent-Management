import { redirect } from "next/navigation";
import { getCtx } from "@/server/auth/context";

export default async function Home() {
  redirect((await getCtx()) ? "/dashboard" : "/login");
}
