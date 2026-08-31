import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { SESSION_COOKIE, issueToken, operatorPassword } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = operatorPassword();
  if (!expected) {
    return NextResponse.json({ error: "No operator password is configured" }, { status: 500 });
  }

  let password = "";
  try {
    password = String(((await request.json()) as { password?: string }).password ?? "");
  } catch {
    return NextResponse.json({ error: "Body was not valid JSON" }, { status: 400 });
  }

  const ok =
    password.length === expected.length &&
    timingSafeEqual(Buffer.from(password), Buffer.from(expected));
  if (!ok) {
    // Same shape and timing whether the password was empty or merely wrong.
    return NextResponse.json({ error: "That password was not right" }, { status: 401 });
  }

  const token = issueToken();
  if (!token) return NextResponse.json({ error: "No signing secret is configured" }, { status: 500 });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
