import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET() {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "API Key Not Configured" },
      { status: 500 }
    );
  }

  return NextResponse.json({ apiKey });
}
