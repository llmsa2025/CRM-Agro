"use server";

import { signOut } from "@/auth";

/** Encerra a sessão e volta para o login. */
export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}
